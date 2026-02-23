/**
 * 自动换标模块：席位状态管理与日内抑制
 *
 * 职责：
 * - 席位状态创建与更新
 * - 日内抑制记录与清理
 * - 清空席位并重置换标流程
 */
import { LOG_COLORS } from '../../constants/index.js';
import type {
  BuildSeatStateParams,
  SeatStateBuilder,
  SeatStateManager,
  SeatStateManagerDeps,
  SeatStateUpdater,
} from './types.js';

/**
 * 创建席位状态管理器，封装席位状态构建、更新、日内抑制记录与清空换标流程。
 * @param deps - 依赖（monitorSymbol、symbolRegistry、switchStates、switchSuppressions、now、logger、getHKDateKey）
 * @returns SeatStateManager 实例（buildSeatState、updateSeatState、resolveSuppression、markSuppression、clearSeat）
 */
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

  /**
   * 构造席位状态对象，统一初始化各字段默认值（如 callPrice 默认为 null）。
   */
  const buildSeatState: SeatStateBuilder = ({
    symbol,
    status,
    lastSwitchAt,
    lastSearchAt,
    lastSeatReadyAt,
    callPrice,
    searchFailCountToday,
    frozenTradingDayKey,
  }: BuildSeatStateParams) => {
    return {
      symbol,
      status,
      lastSwitchAt,
      lastSearchAt,
      lastSeatReadyAt,
      callPrice: callPrice ?? null,
      searchFailCountToday,
      frozenTradingDayKey,
    };
  };

  /**
   * 更新席位状态，若标的发生变更且 bumpOnSymbolChange 为 true，则同步提升席位版本以隔离旧信号。
   */
  const updateSeatState: SeatStateUpdater = (
    direction: 'LONG' | 'SHORT',
    nextState,
    bumpOnSymbolChange,
  ): void => {
    const current = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (bumpOnSymbolChange && current.symbol !== nextState.symbol) {
      symbolRegistry.bumpSeatVersion(monitorSymbol, direction);
    }
    symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);
  };

  /**
   * 查询当前方向的日内抑制记录。若日期键已过期或标的不匹配则自动清除并返回 null。
   */
  function resolveSuppression(
    direction: 'LONG' | 'SHORT',
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

  /**
   * 记录当日日内抑制，防止同一标的在同一交易日内重复触发换标。
   */
  function markSuppression(direction: 'LONG' | 'SHORT', seatSymbol: string): void {
    const dateKey = getHKDateKey(now());
    if (!dateKey) {
      return;
    }
    switchSuppressions.set(direction, { symbol: seatSymbol, dateKey });
  }

  /**
   * 清空席位并进入换标流程，同时提升席位版本用于信号隔离。
   */
  function clearSeat({ direction, reason }: { direction: 'LONG' | 'SHORT'; reason: string }) {
    const timestamp = now().getTime();
    const currentState = symbolRegistry.getSeatState(monitorSymbol, direction);
    const currentSymbol = currentState.symbol;
    const nextVersion = symbolRegistry.bumpSeatVersion(monitorSymbol, direction);
    const nextState = buildSeatState({
      symbol: currentState.symbol ?? null,
      status: 'SWITCHING',
      lastSwitchAt: timestamp,
      lastSearchAt: null,
      lastSeatReadyAt: currentState.lastSeatReadyAt,
      callPrice: null,
      searchFailCountToday: currentState.searchFailCountToday,
      frozenTradingDayKey: currentState.frozenTradingDayKey,
    });
    symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);
    if (currentSymbol) {
      switchStates.set(direction, {
        direction,
        switchMode: 'DISTANCE',
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
    logger.info(
      `${LOG_COLORS.green}[自动换标] ${monitorSymbol} ${direction} 清空席位: ${reason}${LOG_COLORS.reset}`,
    );
    return nextVersion;
  }

  return {
    buildSeatState,
    updateSeatState,
    resolveSuppression,
    markSuppression,
    clearSeat,
  };
}
