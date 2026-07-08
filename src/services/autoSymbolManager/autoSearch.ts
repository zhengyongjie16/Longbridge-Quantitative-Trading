/**
 * 自动换标模块：自动寻标（AutoSearch）
 *
 * 功能：在席位为空时按冷却间隔触发自动寻标。
 * 职责：自动寻标开盘延迟（在早盘延迟窗口内跳过寻标）、失败冻结与成功后席位 ACTIVATING 更新。
 * 执行流程：maybeSearchOnEvent 检查席位状态与冷却 → 调用 findBestWarrant → 成功则更新为 ACTIVATING，失败则累计失败计数或冻结。
 */
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import type { AutoSearchDeps, AutoSearchManager, SearchOnEventParams } from './types.js';
import { isSeatFrozenToday, resolveNextSearchFailureState } from './utils.js';

/**
 * 创建自动寻标子模块，管理空席位的寻标触发、冷却控制与失败冻结逻辑；事件唤醒时检查席位状态，满足条件时调用 findBestWarrant 并更新席位。
 * @param deps - 依赖（autoSearchConfig、symbolRegistry、buildSeatState、updateSeatState、resolveDirectionalAutoSearchPolicy、buildFindBestWarrantInput、findBestWarrant 等）
 * @returns AutoSearchManager 实例（maybeSearchOnEvent）
 */
export function createAutoSearch(deps: AutoSearchDeps): AutoSearchManager {
  const {
    autoSearchConfig,
    monitorSymbol,
    symbolRegistry,
    buildSeatState,
    updateSeatState,
    resolveDirectionalAutoSearchPolicy,
    buildFindBestWarrantInput,
    findBestWarrant,
    isWithinMorningAutoSearchOpenDelay,
    searchCooldownMs,
    getHKDateKey,
    maxSearchFailuresPerDay,
    logger,
  } = deps;

  /**
   * 在席位为空时执行自动寻标，受自动寻标开盘延迟与冷却时间限制。
   */
  async function maybeSearchOnEvent({
    direction,
    currentTime,
    canTradeNow,
  }: SearchOnEventParams): Promise<void> {
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
      isWithinMorningAutoSearchOpenDelay(currentTime, autoSearchConfig.autoSearchOpenDelayMinutes)
    ) {
      return;
    }

    const policy = resolveDirectionalAutoSearchPolicy({
      direction,
      logPrefix: '[自动寻标] 缺少阈值配置，跳过寻标',
    });
    if (policy === null) {
      return;
    }

    updateSeatState(
      direction,
      buildSeatState({
        symbol: null,
        status: 'SEARCHING',
        lastSwitchAt: seatState.lastSwitchAt ?? null,
        lastSearchAt: nowMs,
        lastSeatActivatedAt: seatState.lastSeatActivatedAt ?? null,
        callPrice: null,
        searchFailCountToday: seatState.searchFailCountToday,
        frozenTradingDayKey: seatState.frozenTradingDayKey,
      }),
      false,
    );

    let best: { readonly symbol: string; readonly callPrice: number } | null;
    try {
      const input = await buildFindBestWarrantInput({
        currentTime,
        policy,
      });
      best = await findBestWarrant(input);
    } catch (err) {
      const currentSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
      updateSeatState(
        direction,
        buildSeatState({
          symbol: null,
          status: 'EMPTY',
          lastSwitchAt: currentSeat.lastSwitchAt ?? null,
          lastSearchAt: seatState.lastSearchAt ?? null,
          lastSeatActivatedAt: currentSeat.lastSeatActivatedAt ?? null,
          callPrice: null,
          searchFailCountToday: currentSeat.searchFailCountToday,
          frozenTradingDayKey: currentSeat.frozenTradingDayKey,
        }),
        false,
      );

      if (isExternalApiRequestError(err)) {
        logger.warn(
          `[自动寻标] ${monitorSymbol} ${direction} API 请求失败，等待事件重试: ${err.message}`,
        );
      }

      throw err;
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
          lastSeatActivatedAt: currentSeat.lastSeatActivatedAt ?? null,
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
      status: 'ACTIVATING',
      lastSwitchAt: nowMs,
      lastSearchAt: nowMs,
      lastSeatActivatedAt: null,
      callPrice: best.callPrice,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    updateSeatState(direction, nextState, true);
  }

  return {
    maybeSearchOnEvent,
  };
}
