/**
 * 自动换标模块：席位状态管理与日内抑制
 *
 * 职责：
 * - 席位状态创建与更新
 * - 日内抑制记录与清理
 * - 清空席位并重置换标流程
 */
import type {
  SeatStateBuilder,
  SeatStateManager,
  SeatStateManagerDeps,
  SeatStateUpdater,
  SeatDirection,
} from './types.js';

export function createSeatStateManager(deps: SeatStateManagerDeps): SeatStateManager {
  const {
    monitorSymbol,
    symbolRegistry,
    switchStates,
    switchSuppressions,
    now,
    logger,
    getHKDateKey,
  } = deps;

  const buildSeatState: SeatStateBuilder = (
    symbol,
    status,
    lastSwitchAt,
    lastSearchAt,
    callPrice,
  ) => {
    return {
      symbol,
      status,
      lastSwitchAt,
      lastSearchAt,
      callPrice: callPrice ?? null,
    } as const;
  };

  const updateSeatState: SeatStateUpdater = (
    direction: SeatDirection,
    nextState,
    bumpOnSymbolChange,
  ): void => {
    const current = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (bumpOnSymbolChange && current.symbol !== nextState.symbol) {
      symbolRegistry.bumpSeatVersion(monitorSymbol, direction);
    }
    symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);
  };

  function resolveSuppression(
    direction: SeatDirection,
    seatSymbol: string,
  ): ReturnType<SeatStateManager['resolveSuppression']> {
    const record = switchSuppressions.get(direction);
    if (!record) {
      return null;
    }
    const currentKey = getHKDateKey(now());
    if (!currentKey || record.dateKey !== currentKey || record.symbol !== seatSymbol) {
      switchSuppressions.delete(direction);
      return null;
    }
    return record;
  }

  function markSuppression(direction: SeatDirection, seatSymbol: string): void {
    const dateKey = getHKDateKey(now());
    if (!dateKey) {
      return;
    }
    switchSuppressions.set(direction, { symbol: seatSymbol, dateKey });
  }

  /**
   * 清空席位并进入换标流程，同时提升席位版本用于信号隔离。
   */
  function clearSeat({ direction, reason }: { direction: SeatDirection; reason: string }) {
    const timestamp = now().getTime();
    const currentState = symbolRegistry.getSeatState(monitorSymbol, direction);
    const currentSymbol = currentState.symbol;
    const nextVersion = symbolRegistry.bumpSeatVersion(monitorSymbol, direction);
    const nextState = buildSeatState(
      currentState.symbol ?? null,
      'SWITCHING',
      timestamp,
      null,
      null,
    );
    symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);
    if (currentSymbol) {
      switchStates.set(direction, {
        direction,
        seatVersion: nextVersion,
        stage: 'CANCEL_PENDING',
        oldSymbol: currentSymbol,
        nextSymbol: null,
        nextCallPrice: null,
        startedAt: timestamp,
        sellSubmitted: false,
        sellNotional: null,
        shouldRebuy: false,
        awaitingQuote: false,
      });
    } else {
      switchStates.delete(direction);
    }
    logger.warn(`[自动换标] ${monitorSymbol} ${direction} 清空席位: ${reason}`);
    return nextVersion;
  }

  function resetDailySwitchSuppression(): void {
    switchSuppressions.clear();
  }

  return {
    buildSeatState,
    updateSeatState,
    resolveSuppression,
    markSuppression,
    clearSeat,
    resetDailySwitchSuppression,
  };
}
