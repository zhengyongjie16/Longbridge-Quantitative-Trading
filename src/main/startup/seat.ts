/**
 * 启动席位准备流程：
 * - 从历史订单与持仓推断席位标的
 * - 自动寻标填充空席位
 */
import type {
  MonitorConfig,
  SeatSymbolSnapshotEntry,
  SymbolRegistry,
} from '../../types/index.js';
import type { PreparedSeats, PrepareSeatsOnStartupDeps, SeatSnapshot, SeatSnapshotInput } from './types.js';
import { findBestWarrant } from '../../services/autoSymbolFinder/index.js';
import { isSeatReady, resolveSeatOnStartup } from '../../services/autoSymbolManager/utils.js';
import { getLatestTradedSymbol } from '../../core/orderRecorder/orderOwnershipParser.js';

/**
 * 基于订单与持仓生成席位快照，用于启动时恢复席位标的。
 */
export function resolveSeatSnapshot(input: SeatSnapshotInput): SeatSnapshot {
  const { monitors, positions, orders } = input;
  const entries: SeatSymbolSnapshotEntry[] = [];

  for (const monitor of monitors) {
    const candidateLongSymbol = getLatestTradedSymbol(
      orders,
      monitor.orderOwnershipMapping,
      'LONG',
    );
    const candidateShortSymbol = getLatestTradedSymbol(
      orders,
      monitor.orderOwnershipMapping,
      'SHORT',
    );

    const resolvedLongSymbol = resolveSeatOnStartup({
      autoSearchEnabled: monitor.autoSearchConfig.autoSearchEnabled,
      candidateSymbol: candidateLongSymbol ?? null,
      configuredSymbol: monitor.longSymbol,
      positions,
    });
    if (resolvedLongSymbol) {
      entries.push({
        monitorSymbol: monitor.monitorSymbol,
        direction: 'LONG',
        symbol: resolvedLongSymbol,
      });
    }

    const resolvedShortSymbol = resolveSeatOnStartup({
      autoSearchEnabled: monitor.autoSearchConfig.autoSearchEnabled,
      candidateSymbol: candidateShortSymbol ?? null,
      configuredSymbol: monitor.shortSymbol,
      positions,
    });
    if (resolvedShortSymbol) {
      entries.push({
        monitorSymbol: monitor.monitorSymbol,
        direction: 'SHORT',
        symbol: resolvedShortSymbol,
      });
    }
  }

  return { entries };
}

export function resolveReadySeatSymbol(
  symbolRegistry: SymbolRegistry,
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
): string | null {
  const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
  return isSeatReady(seatState) ? seatState.symbol : null;
}

export function collectSeatSymbols({
  monitors,
  symbolRegistry,
}: {
  readonly monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol'>>;
  readonly symbolRegistry: SymbolRegistry;
}): ReadonlyArray<SeatSymbolSnapshotEntry> {
  const entries: SeatSymbolSnapshotEntry[] = [];
  for (const monitor of monitors) {
    const longSymbol = resolveReadySeatSymbol(symbolRegistry, monitor.monitorSymbol, 'LONG');
    if (longSymbol) {
      entries.push({
        monitorSymbol: monitor.monitorSymbol,
        direction: 'LONG',
        symbol: longSymbol,
      });
    }
    const shortSymbol = resolveReadySeatSymbol(symbolRegistry, monitor.monitorSymbol, 'SHORT');
    if (shortSymbol) {
      entries.push({
        monitorSymbol: monitor.monitorSymbol,
        direction: 'SHORT',
        symbol: shortSymbol,
      });
    }
  }
  return entries;
}

/**
 * 启动时准备所有席位：
 * - 先恢复历史标的
 * - 对启用自动寻标的席位执行寻标
 */
export async function prepareSeatsOnStartup(
  deps: PrepareSeatsOnStartupDeps,
): Promise<PreparedSeats> {
  const {
    tradingConfig,
    symbolRegistry,
    positions,
    orders,
    marketDataClient,
    sleep,
    now,
    intervalMs,
    logger,
    getTradingMinutesSinceOpen,
    isWithinMorningOpenProtection,
    warrantListCacheConfig,
  } = deps;

  const snapshot = resolveSeatSnapshot({
    monitors: tradingConfig.monitors,
    positions,
    orders,
  });

  const snapshotMap = new Map<string, string>();
  for (const entry of snapshot.entries) {
    snapshotMap.set(`${entry.monitorSymbol}:${entry.direction}`, entry.symbol);
  }

  /**
   * 启动阶段更新席位状态：READY/EMPTY。
   */
  function updateSeatOnStartup(
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    symbol: string | null,
  ): void {
    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol,
      status: symbol ? 'READY' : 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
    });
  }

  for (const monitorConfig of tradingConfig.monitors) {
    const longKey = `${monitorConfig.monitorSymbol}:LONG`;
    const shortKey = `${monitorConfig.monitorSymbol}:SHORT`;
    updateSeatOnStartup(
      monitorConfig.monitorSymbol,
      'LONG',
      snapshotMap.get(longKey) ?? null,
    );
    updateSeatOnStartup(
      monitorConfig.monitorSymbol,
      'SHORT',
      snapshotMap.get(shortKey) ?? null,
    );
  }

  const quoteContextPromise = marketDataClient._getContext();

  /**
   * 根据方向解析启动寻标阈值。
   */
  function resolveAutoSearchThresholds(
    direction: 'LONG' | 'SHORT',
    autoSearchConfig: {
      readonly autoSearchMinPriceBull: number | null;
      readonly autoSearchMinPriceBear: number | null;
      readonly autoSearchMinTurnoverPerMinuteBull: number | null;
      readonly autoSearchMinTurnoverPerMinuteBear: number | null;
    },
  ): { minPrice: number | null; minTurnoverPerMinute: number | null } {
    if (direction === 'LONG') {
      return {
        minPrice: autoSearchConfig.autoSearchMinPriceBull,
        minTurnoverPerMinute: autoSearchConfig.autoSearchMinTurnoverPerMinuteBull,
      };
    }
    return {
      minPrice: autoSearchConfig.autoSearchMinPriceBear,
      minTurnoverPerMinute: autoSearchConfig.autoSearchMinTurnoverPerMinuteBear,
    };
  }

  /**
   * 执行自动寻标并更新席位状态。
   */
  async function searchSeatSymbol({
    monitorSymbol,
    direction,
    autoSearchConfig,
    currentTime,
  }: {
    readonly monitorSymbol: string;
    readonly direction: 'LONG' | 'SHORT';
    readonly autoSearchConfig: {
      readonly autoSearchExpiryMinMonths: number;
      readonly autoSearchMinPriceBull: number | null;
      readonly autoSearchMinPriceBear: number | null;
      readonly autoSearchMinTurnoverPerMinuteBull: number | null;
      readonly autoSearchMinTurnoverPerMinuteBear: number | null;
    };
    readonly currentTime: Date;
  }): Promise<string | null> {
    const { minPrice, minTurnoverPerMinute } = resolveAutoSearchThresholds(
      direction,
      autoSearchConfig,
    );
    if (minPrice == null || minTurnoverPerMinute == null) {
      logger.error(`[启动席位] 缺少自动寻标阈值配置: ${monitorSymbol} ${direction}`);
      return null;
    }

    const nowMs = currentTime.getTime();
    const currentSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol: null,
      status: 'SEARCHING',
      lastSwitchAt: currentSeat.lastSwitchAt ?? null,
      lastSearchAt: nowMs,
    });

    const ctx = await quoteContextPromise;
    const tradingMinutes = getTradingMinutesSinceOpen(currentTime);
    const best = await findBestWarrant({
      ctx,
      monitorSymbol,
      isBull: direction === 'LONG',
      tradingMinutes,
      minPrice,
      minTurnoverPerMinute,
      expiryMinMonths: autoSearchConfig.autoSearchExpiryMinMonths,
      logger,
      ...(warrantListCacheConfig ? { cacheConfig: warrantListCacheConfig } : {}),
    });

    if (!best) {
      symbolRegistry.updateSeatState(monitorSymbol, direction, {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: currentSeat.lastSwitchAt ?? null,
        lastSearchAt: nowMs,
      });
      return null;
    }

    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol: best.symbol,
      status: 'READY',
      lastSwitchAt: nowMs,
      lastSearchAt: nowMs,
    });
    return best.symbol;
  }

  /**
   * 循环等待所有自动寻标席位就绪（包含开盘保护与间隔等待）。
   */
  async function waitForSeatsReady(): Promise<void> {
    let loggedWaiting = false;
    while (true) {
      const pendingSeats: Array<{
        monitorSymbol: string;
        direction: 'LONG' | 'SHORT';
        autoSearchConfig: {
          readonly autoSearchOpenDelayMinutes: number;
          readonly autoSearchExpiryMinMonths: number;
          readonly autoSearchMinPriceBull: number | null;
          readonly autoSearchMinPriceBear: number | null;
          readonly autoSearchMinTurnoverPerMinuteBull: number | null;
          readonly autoSearchMinTurnoverPerMinuteBear: number | null;
        };
      }> = [];

      for (const monitorConfig of tradingConfig.monitors) {
        if (!monitorConfig.autoSearchConfig.autoSearchEnabled) {
          continue;
        }
        const longSeat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
        if (!isSeatReady(longSeat)) {
          pendingSeats.push({
            monitorSymbol: monitorConfig.monitorSymbol,
            direction: 'LONG',
            autoSearchConfig: monitorConfig.autoSearchConfig,
          });
        }
        const shortSeat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'SHORT');
        if (!isSeatReady(shortSeat)) {
          pendingSeats.push({
            monitorSymbol: monitorConfig.monitorSymbol,
            direction: 'SHORT',
            autoSearchConfig: monitorConfig.autoSearchConfig,
          });
        }
      }

      if (pendingSeats.length === 0) {
        if (loggedWaiting) {
          logger.info('[启动席位] 所有席位已就绪');
        }
        return;
      }

      if (!loggedWaiting) {
        logger.info(`[启动席位] ${pendingSeats.length} 个席位待寻标，等待寻标完成`);
        loggedWaiting = true;
      }

      const currentTime = now();
      for (const seat of pendingSeats) {
        const openDelayMinutes = seat.autoSearchConfig.autoSearchOpenDelayMinutes ?? 0;
        if (
          openDelayMinutes > 0 &&
          isWithinMorningOpenProtection(currentTime, openDelayMinutes)
        ) {
          continue;
        }
        const symbol = await searchSeatSymbol({
          monitorSymbol: seat.monitorSymbol,
          direction: seat.direction,
          autoSearchConfig: seat.autoSearchConfig,
          currentTime,
        });
        if (symbol) {
          logger.info(`[启动席位] ${seat.monitorSymbol} ${seat.direction} 已就绪: ${symbol}`);
        }
      }

      await sleep(intervalMs);
    }
  }

  await waitForSeatsReady();

  return {
    seatSymbols: collectSeatSymbols({
      monitors: tradingConfig.monitors,
      symbolRegistry,
    }),
  };
}
