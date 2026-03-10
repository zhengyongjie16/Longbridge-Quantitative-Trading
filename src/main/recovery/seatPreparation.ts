/**
 * 运行时席位恢复模块
 *
 * 核心职责：
 * - 基于历史订单与持仓推断席位标的，恢复上次运行状态
 * - 对启用自动寻标的空席位执行运行时恢复寻标
 * - 提供席位就绪状态查询与席位标的代码收集工具
 */
import type { SeatSymbolSnapshotEntry, SymbolRegistry } from '../../types/seat.js';
import type {
  CollectSeatSymbolsParams,
  PreparedSeats,
  PrepareSeatsForRuntimeDeps,
  RuntimeRecoverySearchParams,
  SeatSnapshot,
  SeatSnapshotInput,
} from './types.js';
import { findBestWarrant } from '../../services/autoSymbolFinder/index.js';
import {
  buildFindBestWarrantInputFromPolicy,
  resolveDirectionalAutoSearchPolicy,
} from '../../services/autoSymbolFinder/policyResolver.js';
import {
  isSeatReady,
  resolveNextSearchFailureState,
  resolveSeatOnStartup,
} from '../../services/autoSymbolManager/utils.js';
import { getLatestTradedSymbol } from '../../core/orderRecorder/orderOwnershipParser.js';
import { AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY } from '../../constants/index.js';
import { getHKDateKey } from '../../utils/time/index.js';

/**
 * 基于订单与持仓生成席位快照，用于恢复运行时席位标的。
 *
 * @param input 包含 monitors、positions、orders 的输入
 * @returns 席位快照，含各监控标的与方向的解析结果条目
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

/**
 * 获取指定监控标的和方向的就绪席位标的代码。
 *
 * @param symbolRegistry 席位注册表
 * @param monitorSymbol 监控标的代码
 * @param direction 方向（LONG 或 SHORT）
 * @returns 席位就绪时返回标的代码，否则返回 null
 */
export function resolveReadySeatSymbol(
  symbolRegistry: SymbolRegistry,
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
): string | null {
  const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
  return isSeatReady(seatState) ? seatState.symbol : null;
}

/**
 * 收集所有监控标的当前就绪席位的标的代码列表，用于订阅行情。
 *
 * @param params 包含 monitors、symbolRegistry
 * @returns 就绪席位的 monitorSymbol + direction + symbol 条目数组
 */
function collectSeatSymbols({
  monitors,
  symbolRegistry,
}: CollectSeatSymbolsParams): ReadonlyArray<SeatSymbolSnapshotEntry> {
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
 * 恢复全部席位：
 * - 先恢复历史标的
 * - 对启用自动寻标的席位执行寻标
 *
 * @param deps 依赖注入，包含 tradingConfig、symbolRegistry、positions、orders、marketDataClient、now、logger 等
 * @returns 就绪席位的标的列表（seatSymbols），用于后续订阅行情
 */
export async function prepareSeatsForRuntime(
  deps: PrepareSeatsForRuntimeDeps,
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

  const startupTimestampMs = now().getTime();

  function updateSeatOnRuntimeRecovery(
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    symbol: string | null,
  ): void {
    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol,
      status: symbol ? 'READY' : 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatReadyAt: symbol ? startupTimestampMs : null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
  }

  for (const monitorConfig of tradingConfig.monitors) {
    const longKey = `${monitorConfig.monitorSymbol}:LONG`;
    const shortKey = `${monitorConfig.monitorSymbol}:SHORT`;
    updateSeatOnRuntimeRecovery(
      monitorConfig.monitorSymbol,
      'LONG',
      snapshotMap.get(longKey) ?? null,
    );

    updateSeatOnRuntimeRecovery(
      monitorConfig.monitorSymbol,
      'SHORT',
      snapshotMap.get(shortKey) ?? null,
    );
  }

  let quoteContextPromise: ReturnType<typeof marketDataClient.getQuoteContext> | null = null;

  function getQuoteContext(): ReturnType<typeof marketDataClient.getQuoteContext> {
    quoteContextPromise ??= marketDataClient.getQuoteContext();
    return quoteContextPromise;
  }

  async function searchSeatSymbol({
    monitorSymbol,
    direction,
    autoSearchConfig,
    currentTime,
  }: RuntimeRecoverySearchParams): Promise<string | null> {
    const policy = resolveDirectionalAutoSearchPolicy({
      direction,
      autoSearchConfig,
      monitorSymbol,
      logPrefix: '[席位恢复] 缺少自动寻标阈值配置，跳过恢复寻标',
      logger,
    });
    if (policy === null) {
      return null;
    }

    const currentSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
    const nowMs = currentTime.getTime();
    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol: null,
      status: 'SEARCHING',
      lastSwitchAt: currentSeat.lastSwitchAt ?? null,
      lastSearchAt: nowMs,
      lastSeatReadyAt: currentSeat.lastSeatReadyAt ?? null,
      callPrice: null,
      searchFailCountToday: currentSeat.searchFailCountToday,
      frozenTradingDayKey: currentSeat.frozenTradingDayKey,
    });
    const ctx = await getQuoteContext();
    const best = await findBestWarrant(
      buildFindBestWarrantInputFromPolicy({
        ctx,
        monitorSymbol,
        currentTime,
        policy,
        expiryMinMonths: autoSearchConfig.autoSearchExpiryMinMonths,
        logger,
        getTradingMinutesSinceOpen,
        ...(warrantListCacheConfig ? { cacheConfig: warrantListCacheConfig } : {}),
      }),
    );
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
          `[席位恢复] ${monitorSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
        );
      }

      symbolRegistry.updateSeatState(monitorSymbol, direction, {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: updatedSeat.lastSwitchAt ?? null,
        lastSearchAt: nowMs,
        lastSeatReadyAt: updatedSeat.lastSeatReadyAt ?? null,
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
      lastSeatReadyAt: nowMs,
      callPrice: best.callPrice,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    return best.symbol;
  }

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
    const { nextFailCount, frozenTradingDayKey, shouldFreeze } = resolveNextSearchFailureState({
      currentSeat: stuckSeat,
      hkDateKey,
      maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
    });
    if (shouldFreeze) {
      logger.warn(
        `[席位恢复] ${monitorSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
      );
    }

    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: stuckSeat.lastSwitchAt ?? null,
      lastSearchAt: currentTime.getTime(),
      lastSeatReadyAt: stuckSeat.lastSeatReadyAt ?? null,
      callPrice: null,
      searchFailCountToday: nextFailCount,
      frozenTradingDayKey,
    });
  }

  function shouldSkipRuntimeRecoverySearch(
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

  async function trySearchEmptySeats(): Promise<void> {
    const currentTime = now();

    for (const monitorConfig of tradingConfig.monitors) {
      if (!monitorConfig.autoSearchConfig.autoSearchEnabled) {
        continue;
      }

      for (const direction of ['LONG', 'SHORT'] as const) {
        const seatState = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, direction);
        const openDelayMinutes = monitorConfig.autoSearchConfig.autoSearchOpenDelayMinutes;
        if (shouldSkipRuntimeRecoverySearch(seatState, openDelayMinutes, currentTime)) {
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
            logger.info(`[席位恢复] ${monitorConfig.monitorSymbol} ${direction} 已就绪: ${symbol}`);
          }
        } catch (err) {
          handleSearchException(monitorConfig.monitorSymbol, direction, currentTime);
          logger.error(
            `[席位恢复] ${monitorConfig.monitorSymbol} ${direction} 寻标异常: ${String(err)}`,
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
