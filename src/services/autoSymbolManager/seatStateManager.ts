/**
 * 自动换标模块：席位状态管理与日内抑制
 *
 * 职责：
 * - 席位状态创建与更新
 * - 日内抑制记录与清理
 * - 进入换标中的席位状态并初始化换标上下文
 */
import { LOG_COLORS } from '../../constants/index.js';
import type {
  BuildSeatStateParams,
  SeatStateBuilder,
  SeatStateManager,
  SeatStateManagerDeps,
  SeatStateUpdater,
  SuppressibleSwitchTriggerKind,
} from './types.js';

/**
 * 构造席位状态对象，统一初始化各字段默认值（如 callPrice 默认为 null）。
 */
const buildSeatState: SeatStateBuilder = ({
  symbol,
  status,
  lastSwitchAt,
  lastSearchAt,
  lastSeatActivatedAt,
  callPrice,
  searchFailCountToday,
  frozenTradingDayKey,
}: BuildSeatStateParams) => {
  return {
    symbol,
    status,
    lastSwitchAt,
    lastSearchAt,
    lastSeatActivatedAt,
    callPrice: callPrice ?? null,
    searchFailCountToday,
    frozenTradingDayKey,
  };
};

/**
 * 创建席位状态管理器，封装席位状态构建、更新、日内抑制记录与换标启动准备。
 * @param deps - 依赖（monitorSymbol、symbolRegistry、switchStates、switchSuppressions、now、logger、getHKDateKey）
 * @returns SeatStateManager 实例（buildSeatState、updateSeatState、resolveSuppression、markSuppression、enterSwitchingSeat）
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
   * 更新席位状态，若标的发生变更且 bumpOnSymbolChange 为 true，则同步提升席位版本以隔离旧信号。
   */
  const updateSeatState: SeatStateUpdater = (
    direction: 'LONG' | 'SHORT',
    nextState,
    bumpOnSymbolChange,
  ): void => {
    const current = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (bumpOnSymbolChange && current.symbol !== nextState.symbol) {
      symbolRegistry.updateSeatStateWithVersionBump(monitorSymbol, direction, nextState);
      return;
    }

    symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);
  };

  /**
   * 查询当前方向指定 trigger kind 的日内抑制记录。
   * 若日期键已过期或标的不匹配则自动清除并返回 null；若仅 trigger kind 不匹配，则保留原记录并返回 null。
   */
  function resolveSuppression(
    direction: 'LONG' | 'SHORT',
    seatSymbol: string,
    triggerKind: SuppressibleSwitchTriggerKind,
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

    if (!record.suppressedTriggerKinds.has(triggerKind)) {
      return null;
    }

    return record;
  }

  /**
   * 记录指定 trigger kind 的当日日内抑制，防止同一标的在同一交易日内重复触发相同语义的换标。
   */
  function markSuppression(
    direction: 'LONG' | 'SHORT',
    seatSymbol: string,
    triggerKind: SuppressibleSwitchTriggerKind,
  ): void {
    const dateKey = getHKDateKey(now());
    if (!dateKey) {
      return;
    }

    const currentRecord = switchSuppressions.get(direction);
    if (currentRecord?.symbol === seatSymbol && currentRecord.dateKey === dateKey) {
      switchSuppressions.set(direction, {
        symbol: seatSymbol,
        dateKey,
        suppressedTriggerKinds: new Set([...currentRecord.suppressedTriggerKinds, triggerKind]),
      });
      return;
    }

    switchSuppressions.set(direction, {
      symbol: seatSymbol,
      dateKey,
      suppressedTriggerKinds: new Set([triggerKind]),
    });
  }

  /**
   * 将当前席位切换为 SWITCHING，并初始化换标上下文，同时提升席位版本用于信号隔离。
   */
  function enterSwitchingSeat({
    direction,
    reason,
  }: {
    direction: 'LONG' | 'SHORT';
    reason: string;
  }): number {
    const timestamp = now().getTime();
    const currentState = symbolRegistry.getSeatState(monitorSymbol, direction);
    const currentSymbol = currentState.symbol;
    const { seatVersion: nextVersion } = symbolRegistry.updateSeatStateWithVersionBump(
      monitorSymbol,
      direction,
      buildSeatState({
        symbol: currentState.symbol ?? null,
        status: 'SWITCHING',
        lastSwitchAt: timestamp,
        lastSearchAt: null,
        lastSeatActivatedAt: currentState.lastSeatActivatedAt,
        callPrice: null,
        searchFailCountToday: currentState.searchFailCountToday,
        frozenTradingDayKey: currentState.frozenTradingDayKey,
      }),
    );
    if (currentSymbol) {
      switchStates.set(direction, {
        direction,
        switchMode: 'DISTANCE',
        seatVersion: nextVersion,
        stage: 'CANCEL_PENDING',
        oldSymbol: currentSymbol,
        nextSymbol: null,
        nextCallPrice: null,
        sellSubmitted: false,
        sellOrderId: null,
        sellNotional: null,
        shouldRebuy: false,
        quoteRetryAttempts: 0,
        quoteRetryNextAt: null,
        quoteRetryExhausted: false,
        cancelRequestSubmitted: false,
      });
    } else {
      switchStates.delete(direction);
    }

    logger.info(
      `${LOG_COLORS.green}[自动换标] ${monitorSymbol} ${direction} 进入换标中状态: ${reason}${LOG_COLORS.reset}`,
    );
    return nextVersion;
  }

  return {
    buildSeatState,
    updateSeatState,
    resolveSuppression,
    markSuppression,
    enterSwitchingSeat,
  };
}
