/**
 * 运行时席位恢复模块
 *
 * 核心职责：
 * - 基于历史订单与持仓推断席位标的，恢复上次运行状态
 * - 对启用自动寻标的空席位执行运行时恢复寻标
 * - 在恢复完成后回写当前席位快照，供后续运行时订阅使用
 */
import type { SeatSymbolSnapshotEntry, SymbolRegistry } from '../../types/seat.js';
import type {
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
import { hasSeatSymbol } from '../../utils/seat/guards.js';
import { collectBoundSeatSymbols } from '../../utils/seat/symbols.js';
import {
  isSeatFrozenToday,
  resolveNextSearchFailureState,
  resolveSeatOnStartup,
} from '../../services/autoSymbolManager/utils.js';
import { getLatestTradedSymbol } from '../../core/orderRecorder/index.js';
import { AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY } from '../../constants/index.js';
import { getHKDateKey } from '../../utils/time/index.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';

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
 * 恢复全部席位：
 * - 先恢复历史标的
 * - 对启用自动寻标的席位执行寻标
 *
 * @param deps 依赖注入，包含 tradingConfig、symbolRegistry、positions、orders、marketDataClient、now、logger 等
 * @returns 已绑定席位的标的列表（seatSymbols），用于后续订阅行情
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
    resolveCanAutoSearchNow,
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

  function updateSeatOnRuntimeRecovery(
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    symbol: string | null,
  ): void {
    const currentSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol,
      status: symbol ? 'ACTIVATING' : 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: symbol ? 0 : currentSeat.searchFailCountToday,
      frozenTradingDayKey: symbol ? null : currentSeat.frozenTradingDayKey,
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
      lastSeatActivatedAt: currentSeat.lastSeatActivatedAt ?? null,
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
        lastSeatActivatedAt: updatedSeat.lastSeatActivatedAt ?? null,
        callPrice: null,
        searchFailCountToday: nextFailCount,
        frozenTradingDayKey,
      });
      return null;
    }

    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol: best.symbol,
      status: 'ACTIVATING',
      lastSwitchAt: nowMs,
      lastSearchAt: nowMs,
      lastSeatActivatedAt: null,
      callPrice: best.callPrice,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    return best.symbol;
  }

  function resetSearchingSeatAfterException(
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    currentTime: Date,
  ): void {
    const stuckSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (stuckSeat.status !== 'SEARCHING') {
      return;
    }

    symbolRegistry.updateSeatState(monitorSymbol, direction, {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: stuckSeat.lastSwitchAt ?? null,
      lastSearchAt: currentTime.getTime(),
      lastSeatActivatedAt: stuckSeat.lastSeatActivatedAt ?? null,
      callPrice: null,
      searchFailCountToday: stuckSeat.searchFailCountToday,
      frozenTradingDayKey: stuckSeat.frozenTradingDayKey,
    });
  }

  function shouldSkipRuntimeRecoverySearch(
    seatState: ReturnType<SymbolRegistry['getSeatState']>,
    openDelayMinutes: number,
    currentTime: Date,
  ): boolean {
    if (hasSeatSymbol(seatState)) {
      return true;
    }

    if (isSeatFrozenToday(seatState)) {
      return true;
    }

    if (!resolveCanAutoSearchNow({ currentTime, openDelayMinutes })) {
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
            logger.info(
              `[席位恢复] ${monitorConfig.monitorSymbol} ${direction} 已进入激活阶段: ${symbol}`,
            );
          }
        } catch (err) {
          resetSearchingSeatAfterException(monitorConfig.monitorSymbol, direction, currentTime);
          if (isExternalApiRequestError(err)) {
            logger.warn(
              `[席位恢复] ${monitorConfig.monitorSymbol} ${direction} 寻标 API 请求失败，等待恢复链路重试: ${err.message}`,
            );
          }

          throw err;
        }
      }
    }
  }

  await trySearchEmptySeats();

  return {
    seatSymbols: collectBoundSeatSymbols({
      monitors: tradingConfig.monitors,
      symbolRegistry,
    }),
  };
}
