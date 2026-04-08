/**
 * 自动换标管理器
 *
 * 功能：负责席位初始化、自动寻标与换标流程的完整管理。
 * 职责：支持「距离换标 + 周期换标」统一状态机推进，并处理撤单/卖出/买入完整链路。
 * 执行流程：AUTO_SYMBOL_TICK 调用 maybeSearchOnTick 与 maybeSwitchOnInterval；事件驱动 runtime 调用 startSwitchOnDistance / advancePendingSwitch 推进距离换标状态机。
 */
import { OrderSide } from 'longbridge';
import { findBestWarrant } from '../autoSymbolFinder/index.js';
import {
  calculateTradingDurationMsBetween,
  getHKDateKey,
  getTradingMinutesSinceOpen,
  isWithinMorningOpenProtection,
} from '../../utils/time/index.js';
import { logger } from '../../utils/logger/index.js';
import { signalObjectPool } from '../../utils/objectPool/index.js';
import {
  AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
  AUTO_SYMBOL_SEARCH_COOLDOWN_MS,
  PENDING_ORDER_STATUSES,
} from '../../constants/index.js';
import type {
  TradingCalendarDayInfo,
  TradingCalendarSnapshot,
} from '../../types/tradingCalendar.js';
import type { AutoSymbolManagerPort } from '../../types/monitorContextPorts.js';
import type {
  AutoSymbolManagerDeps,
  PeriodicSwitchPendingState,
  SwitchState,
  SwitchSuppression,
} from './types.js';
import { createThresholdResolver } from './thresholdResolver.js';
import {
  calculateBuyQuantityByNotional,
  createSignalBuilder,
  resolveDirectionSymbols,
} from './signalBuilder.js';
import { createSeatStateManager } from './seatStateManager.js';
import { createAutoSearch } from './autoSearch.js';
import { createSwitchStateMachine } from './switchStateMachine.js';

/**
 * 创建自动换标管理器。负责席位初始化、自动寻标与换标流程的完整管理；通过距离阈值触发换标并执行撤单/卖出/买入链路。
 *
 * @param deps 依赖（监控配置、席位注册表、行情客户端、交易器、风控、订单记录等）
 * @returns AutoSymbolManager 实例
 */
export function createAutoSymbolManager(deps: AutoSymbolManagerDeps): AutoSymbolManagerPort {
  const {
    monitorConfig,
    symbolRegistry,
    marketDataClient,
    trader,
    riskChecker,
    orderRecorder,
    warrantListCacheConfig,
  } = deps;
  const now = deps.now ?? (() => new Date());
  const injectedFindBestWarrant = deps.findBestWarrant ?? findBestWarrant;
  const getTradingCalendarSnapshot: () => TradingCalendarSnapshot =
    deps.getTradingCalendarSnapshot ?? (() => new Map<string, TradingCalendarDayInfo>());
  const monitorSymbol = monitorConfig.monitorSymbol;
  const autoSearchConfig = monitorConfig.autoSearchConfig;
  const switchStates = new Map<'LONG' | 'SHORT', SwitchState>();
  const switchSuppressions = new Map<'LONG' | 'SHORT', SwitchSuppression>();
  const periodicSwitchPending = new Map<'LONG' | 'SHORT', PeriodicSwitchPendingState>();
  const thresholdResolver = createThresholdResolver({
    autoSearchConfig,
    monitorSymbol,
    marketDataClient,
    logger,
    getTradingMinutesSinceOpen,
    expiryMinMonths: autoSearchConfig.autoSearchExpiryMinMonths,
    ...(warrantListCacheConfig ? { warrantListCacheConfig } : {}),
  });
  const signalBuilder = createSignalBuilder({ signalObjectPool });
  const seatStateManager = createSeatStateManager({
    monitorSymbol,
    symbolRegistry,
    switchStates,
    switchSuppressions,
    now,
    logger,
    getHKDateKey,
  });
  const autoSearch = createAutoSearch({
    autoSearchConfig,
    monitorSymbol,
    symbolRegistry,
    buildSeatState: seatStateManager.buildSeatState,
    updateSeatState: seatStateManager.updateSeatState,
    resolveDirectionalAutoSearchPolicy: thresholdResolver.resolveDirectionalAutoSearchPolicy,
    buildFindBestWarrantInput: thresholdResolver.buildFindBestWarrantInput,
    findBestWarrant: injectedFindBestWarrant,
    isWithinMorningOpenProtection,
    searchCooldownMs: AUTO_SYMBOL_SEARCH_COOLDOWN_MS,
    getHKDateKey,
    maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
    logger,
  });
  const switchStateMachine = createSwitchStateMachine({
    autoSearchConfig,
    monitorSymbol,
    symbolRegistry,
    trader,
    orderRecorder,
    riskChecker,
    marketDataClient,
    now,
    switchStates,
    periodicSwitchPending,
    resolveSuppression: (direction, seatSymbol, triggerKind) =>
      seatStateManager.resolveSuppression(direction, seatSymbol, triggerKind),
    markSuppression: (direction, seatSymbol, triggerKind) => {
      seatStateManager.markSuppression(direction, seatSymbol, triggerKind);
    },
    enterSwitchingSeat: (params) => seatStateManager.enterSwitchingSeat(params),
    buildSeatState: seatStateManager.buildSeatState,
    updateSeatState: seatStateManager.updateSeatState,
    resolveDirectionalAutoSearchPolicy: thresholdResolver.resolveDirectionalAutoSearchPolicy,
    buildFindBestWarrantInput: thresholdResolver.buildFindBestWarrantInput,
    findBestWarrant: injectedFindBestWarrant,
    resolveDirectionSymbols,
    calculateBuyQuantityByNotional,
    buildOrderSignal: signalBuilder.buildOrderSignal,
    signalObjectPool,
    pendingOrderStatuses: PENDING_ORDER_STATUSES,
    buySide: OrderSide.Buy,
    logger,
    maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
    getHKDateKey,
    calculateTradingDurationMsBetween,
    getTradingCalendarSnapshot,
  });

  /** 清空换标状态与日内抑制记录，用于交易日切换或重新初始化。 */
  function resetAllState(): void {
    switchStates.clear();
    switchSuppressions.clear();
    periodicSwitchPending.clear();
  }
  return {
    maybeSearchOnTick: (params) => autoSearch.maybeSearchOnTick(params),
    maybeSwitchOnInterval: (params) => switchStateMachine.maybeSwitchOnInterval(params),
    startSwitchOnDistance: (params) => switchStateMachine.startSwitchOnDistance(params),
    advancePendingSwitch: (params) => switchStateMachine.advancePendingSwitch(params),
    hasPendingSwitch: (direction) => switchStateMachine.hasPendingSwitch(direction),
    resetAllState,
  };
}
