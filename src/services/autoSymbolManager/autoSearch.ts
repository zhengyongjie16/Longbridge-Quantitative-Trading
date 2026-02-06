/**
 * 自动换标模块：自动寻标
 *
 * 职责：
 * - 空席位寻标与冷却
 * - 开盘保护与席位更新
 */
import type { AutoSearchDeps, AutoSearchManager, SearchOnTickParams } from './types.js';

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

    const lastSearchAt = seatState.lastSearchAt ?? 0;
    const nowMs = currentTime.getTime();
    if (nowMs - lastSearchAt < searchCooldownMs) {
      return;
    }

    if (autoSearchConfig.autoSearchOpenDelayMinutes > 0 &&
        isWithinMorningOpenProtection(currentTime, autoSearchConfig.autoSearchOpenDelayMinutes)) {
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
      buildSeatState(null, 'SEARCHING', seatState.lastSwitchAt ?? null, nowMs),
      false,
    );

    const input = await buildFindBestWarrantInput({
      direction,
      currentTime,
      minDistancePct: thresholds.minDistancePct,
      minTurnoverPerMinute: thresholds.minTurnoverPerMinute,
    });
    const best = await findBestWarrant(input);

    if (!best) {
      updateSeatState(
        direction,
        buildSeatState(null, 'EMPTY', seatState.lastSwitchAt ?? null, nowMs),
        false,
      );
      return;
    }

    const nextState = buildSeatState(best.symbol, 'READY', nowMs, nowMs);
    updateSeatState(direction, nextState, true);
  }

  return {
    maybeSearchOnTick,
  };
}
