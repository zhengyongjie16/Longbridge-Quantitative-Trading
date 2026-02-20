/**
 * 自动换标模块：自动寻标（AutoSearch）
 *
 * 职责：
 * - 在席位为空时按冷却间隔触发自动寻标
 * - 开盘保护：在开盘延迟窗口内跳过寻标
 * - 寻标失败时累计失败计数，达上限后冻结席位
 * - 寻标成功后更新席位状态为 READY
 */
import type { AutoSearchDeps, AutoSearchManager, SearchOnTickParams } from './types.js';
import { isSeatFrozenToday, resolveNextSearchFailureState } from './utils.js';

/**
 * 创建自动寻标子模块，管理空席位的寻标触发、冷却控制与失败冻结逻辑；每 tick 检查席位状态，满足条件时调用 findBestWarrant 并更新席位。
 * @param deps - 依赖（autoSearchConfig、symbolRegistry、buildSeatState、updateSeatState、resolveAutoSearchThresholdInput、buildFindBestWarrantInput、findBestWarrant 等）
 * @returns AutoSearchManager 实例（maybeSearchOnTick）
 */
export function createAutoSearch(deps: AutoSearchDeps): AutoSearchManager {
  const {
    autoSearchConfig,
    monitorSymbol,
    symbolRegistry,
    buildSeatState,
    updateSeatState,
    resolveAutoSearchThresholdInput,
    buildFindBestWarrantInput,
    findBestWarrant,
    isWithinMorningOpenProtection,
    searchCooldownMs,
    getHKDateKey,
    maxSearchFailuresPerDay,
    logger,
  } = deps;

  /**
   * 在席位为空时执行自动寻标，受开盘保护与冷却时间限制。
   */
  async function maybeSearchOnTick({
    direction,
    currentTime,
    canTradeNow,
  }: SearchOnTickParams): Promise<void> {
    if (!autoSearchConfig.autoSearchEnabled || !canTradeNow) {
      return;
    }

    const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (seatState.status !== 'EMPTY') {
      return;
    }

    if (isSeatFrozenToday(seatState)) {
      return;
    }

    const lastSearchAt = seatState.lastSearchAt ?? 0;
    const nowMs = currentTime.getTime();
    if (nowMs - lastSearchAt < searchCooldownMs) {
      return;
    }

    if (
      autoSearchConfig.autoSearchOpenDelayMinutes > 0 &&
      isWithinMorningOpenProtection(currentTime, autoSearchConfig.autoSearchOpenDelayMinutes)
    ) {
      return;
    }

    const thresholds = resolveAutoSearchThresholdInput({
      direction,
      logPrefix: '[自动寻标] 缺少阈值配置，跳过寻标',
    });
    if (!thresholds) {
      return;
    }

    updateSeatState(
      direction,
      buildSeatState({
        symbol: null,
        status: 'SEARCHING',
        lastSwitchAt: seatState.lastSwitchAt ?? null,
        lastSearchAt: nowMs,
        callPrice: null,
        searchFailCountToday: seatState.searchFailCountToday,
        frozenTradingDayKey: seatState.frozenTradingDayKey,
      }),
      false,
    );

    let best: { readonly symbol: string; readonly callPrice: number } | null = null;
    try {
      const input = await buildFindBestWarrantInput({
        direction,
        currentTime,
        minDistancePct: thresholds.minDistancePct,
        minTurnoverPerMinute: thresholds.minTurnoverPerMinute,
      });
      best = await findBestWarrant(input);
    } catch (err) {
      logger.error(`[自动寻标] ${monitorSymbol} ${direction} 寻标异常: ${String(err)}`);
    }

    if (!best) {
      const currentSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
      const hkDateKey = getHKDateKey(currentTime);
      const { nextFailCount, frozenTradingDayKey, shouldFreeze } = resolveNextSearchFailureState({
        currentSeat,
        hkDateKey,
        maxSearchFailuresPerDay,
      });
      if (shouldFreeze) {
        logger.warn(
          `[自动寻标] ${monitorSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
        );
      }
      updateSeatState(
        direction,
        buildSeatState({
          symbol: null,
          status: 'EMPTY',
          lastSwitchAt: currentSeat.lastSwitchAt ?? null,
          lastSearchAt: nowMs,
          callPrice: null,
          searchFailCountToday: nextFailCount,
          frozenTradingDayKey,
        }),
        false,
      );
      return;
    }

    const nextState = buildSeatState({
      symbol: best.symbol,
      status: 'READY',
      lastSwitchAt: nowMs,
      lastSearchAt: nowMs,
      callPrice: best.callPrice,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    updateSeatState(direction, nextState, true);
  }

  return {
    maybeSearchOnTick,
  };
}
