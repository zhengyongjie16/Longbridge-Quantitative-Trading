/**
 * 自动换标模块：席位状态管理与日内抑制
 *
 * 职责：
 * - 席位状态创建与更新
 * - 日内抑制记录与清理
 * - 启动初始化与清席位
 */
import type {
  EnsureSeatOnStartupParams,
  SeatStateBuilder,
  SeatStateManager,
  SeatStateManagerDeps,
  SeatStateUpdater,
  SeatDirection,
} from './types.js';

export function createSeatStateManager(deps: SeatStateManagerDeps): SeatStateManager {
  const {
    monitorSymbol,
    monitorConfig,
    autoSearchConfig,
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
  ) => {
    return {
      symbol,
      status,
      lastSwitchAt,
      lastSearchAt,
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
   * 启动时初始化席位状态：
   * - 未启用自动寻标：直接绑定配置标的
   * - 已启用自动寻标：优先使用历史标的，否则置为空席位
   */
  function ensureSeatOnStartup({
    direction,
    initialSymbol,
  }: EnsureSeatOnStartupParams) {
    if (!autoSearchConfig.autoSearchEnabled) {
      const symbol = direction === 'LONG' ? monitorConfig.longSymbol : monitorConfig.shortSymbol;
      const nextState = buildSeatState(symbol, 'READY', null, null);
      updateSeatState(direction, nextState, false);
      return nextState;
    }

    if (initialSymbol) {
      const nextState = buildSeatState(initialSymbol, 'READY', null, null);
      updateSeatState(direction, nextState, false);
      return nextState;
    }

    const nextState = buildSeatState(null, 'EMPTY', null, null);
    updateSeatState(direction, nextState, false);
    return nextState;
  }

  /**
   * 清空席位并进入换标流程，同时提升席位版本用于信号隔离。
   */
  function clearSeat({ direction, reason }: { direction: SeatDirection; reason: string }) {
    const timestamp = now().getTime();
    const currentState = symbolRegistry.getSeatState(monitorSymbol, direction);
    const currentSymbol = currentState.symbol;
    const nextVersion = symbolRegistry.bumpSeatVersion(monitorSymbol, direction);
    const nextState = buildSeatState(currentState.symbol ?? null, 'SWITCHING', timestamp, null);
    symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);
    if (currentSymbol) {
      switchStates.set(direction, {
        direction,
        seatVersion: nextVersion,
        stage: 'CANCEL_PENDING',
        oldSymbol: currentSymbol,
        nextSymbol: null,
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
    ensureSeatOnStartup,
    clearSeat,
    resetDailySwitchSuppression,
  };
}
