/**
 * 启动席位准备流程：
 * - 从历史订单与持仓推断席位标的
 * - 自动寻标填充空席位
 */
import type { MonitorConfig } from '../../types/config.js';
import type { SeatSymbolSnapshotEntry, SymbolRegistry } from '../../types/seat.js';
import type {
  PreparedSeats,
  PrepareSeatsOnStartupDeps,
  SeatSnapshot,
  SeatSnapshotInput,
} from './types.js';
import { findBestWarrant } from '../../services/autoSymbolFinder/index.js';
import {
  isSeatReady,
  resolveNextSearchFailureState,
  resolveSeatOnStartup,
} from '../../services/autoSymbolManager/utils.js';
import { getLatestTradedSymbol } from '../../core/orderRecorder/orderOwnershipParser.js';
import { AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY } from '../../constants/index.js';
import { getHKDateKey } from '../../utils/helpers/tradingTime.js';

/**
 * 基于订单与持仓生成席位快照，用于启动时恢复席位标的。
 */
function resolveSeatSnapshot(input: SeatSnapshotInput): SeatSnapshot {
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

function collectSeatSymbols({
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
    now,
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
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
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

  const quoteContextPromise = marketDataClient.getQuoteContext();

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
      readonly autoSearchMinDistancePctBull: number | null;
      readonly autoSearchMinDistancePctBear: number | null;
      readonly autoSearchMinTurnoverPerMinuteBull: number | null;
      readonly autoSearchMinTurnoverPerMinuteBear: number | null;
    };
    readonly currentTime: Date;
  }): Promise<string | null> {
    const isBull = direction === 'LONG';
    const minDistancePct = isBull
      ? autoSearchConfig.autoSearchMinDistancePctBull
      : autoSearchConfig.autoSearchMinDistancePctBear;
    const minTurnoverPerMinute = isBull
      ? autoSearchConfig.autoSearchMinTurnoverPerMinuteBull
      : autoSearchConfig.autoSearchMinTurnoverPerMinuteBear;
    if (minDistancePct == null || minTurnoverPerMinute == null) {
      logger.error(`[启动席位] 缺少自动寻标阈值配置: ${monitorSymbol} ${direction}`);
      return null;
    }

    const currentSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
    const nowMs = currentTime.getTime();
    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol: null,
      status: 'SEARCHING',
      lastSwitchAt: currentSeat.lastSwitchAt ?? null,
      lastSearchAt: nowMs,
      callPrice: null,
      searchFailCountToday: currentSeat.searchFailCountToday,
      frozenTradingDayKey: currentSeat.frozenTradingDayKey,
    });

    const ctx = await quoteContextPromise;
    const tradingMinutes = getTradingMinutesSinceOpen(currentTime);
    const best = await findBestWarrant({
      ctx,
      monitorSymbol,
      isBull,
      tradingMinutes,
      minDistancePct,
      minTurnoverPerMinute,
      expiryMinMonths: autoSearchConfig.autoSearchExpiryMinMonths,
      logger,
      ...(warrantListCacheConfig ? { cacheConfig: warrantListCacheConfig } : {}),
    });

    if (!best) {
      const updatedSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
      const hkDateKey = getHKDateKey(currentTime);
      const { nextFailCount, frozenTradingDayKey, shouldFreeze } = resolveNextSearchFailureState({
        currentSeat: updatedSeat,
        hkDateKey,
        maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
      });
      if (shouldFreeze) {
        logger.warn(
          `[启动席位] ${monitorSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
        );
      }
      symbolRegistry.updateSeatState(monitorSymbol, direction, {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: updatedSeat.lastSwitchAt ?? null,
        lastSearchAt: nowMs,
        callPrice: null,
        searchFailCountToday: nextFailCount,
        frozenTradingDayKey,
      });
      return null;
    }

    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol: best.symbol,
      status: 'READY',
      lastSwitchAt: nowMs,
      lastSearchAt: nowMs,
      callPrice: best.callPrice,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    return best.symbol;
  }

  /**
   * 处理启动寻标异常：如果席位状态为SEARCHING，更新失败计数和冻结状态。
   */
  function handleSearchException(
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    currentTime: Date,
  ): void {
    const stuckSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (stuckSeat.status !== 'SEARCHING') {
      return;
    }
    const hkDateKey = getHKDateKey(currentTime);
    const {
      nextFailCount,
      frozenTradingDayKey,
      shouldFreeze,
    } = resolveNextSearchFailureState({
      currentSeat: stuckSeat,
      hkDateKey,
      maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
    });
    if (shouldFreeze) {
      logger.warn(
        `[启动席位] ${monitorSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
      );
    }
    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: stuckSeat.lastSwitchAt ?? null,
      lastSearchAt: currentTime.getTime(),
      callPrice: null,
      searchFailCountToday: nextFailCount,
      frozenTradingDayKey,
    });
  }

  /**
   * 检查是否应该跳过该席位的启动寻标。
   */
  function shouldSkipStartupSearch(
    seatState: ReturnType<SymbolRegistry['getSeatState']>,
    openDelayMinutes: number,
    currentTime: Date,
  ): boolean {
    if (isSeatReady(seatState)) {
      return true;
    }
    if (openDelayMinutes > 0 && isWithinMorningOpenProtection(currentTime, openDelayMinutes)) {
      return true;
    }
    return false;
  }

  /**
   * 启动时单次非阻塞寻标：遍历所有启用自动寻标的空席位，逐个尝试一次寻标。
   */
  async function trySearchEmptySeats(): Promise<void> {
    const currentTime = now();
    for (const monitorConfig of tradingConfig.monitors) {
      if (!monitorConfig.autoSearchConfig.autoSearchEnabled) {
        continue;
      }
      for (const direction of ['LONG', 'SHORT'] as const) {
        const seatState = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, direction);
        const openDelayMinutes = monitorConfig.autoSearchConfig.autoSearchOpenDelayMinutes ?? 0;
        if (shouldSkipStartupSearch(seatState, openDelayMinutes, currentTime)) {
          continue;
        }
        try {
          const symbol = await searchSeatSymbol({
            monitorSymbol: monitorConfig.monitorSymbol,
            direction,
            autoSearchConfig: monitorConfig.autoSearchConfig,
            currentTime,
          });
          if (symbol) {
            logger.info(`[启动席位] ${monitorConfig.monitorSymbol} ${direction} 已就绪: ${symbol}`);
          }
        } catch (err) {
          handleSearchException(monitorConfig.monitorSymbol, direction, currentTime);
          logger.error(
            `[启动席位] ${monitorConfig.monitorSymbol} ${direction} 寻标异常: ${String(err)}`,
          );
        }
      }
    }
  }

  await trySearchEmptySeats();

  return {
    seatSymbols: collectSeatSymbols({
      monitors: tradingConfig.monitors,
      symbolRegistry,
    }),
  };
}
