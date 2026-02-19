/**
 * 自动换标管理器
 *
 * 功能/职责：负责席位初始化、自动寻标与换标流程；通过阈值与风险距离判断触发换标，并处理撤单/卖出/买入的完整链路。
 * 执行流程：主循环每 tick 调用 maybeSearchOnTick、maybeSwitchOnDistance，内部由 AutoSearch 与换标状态机分别处理空席位寻标与距回收价越界换标。
 */
import { OrderSide } from 'longport';
import { findBestWarrant } from '../autoSymbolFinder/index.js';
import {
  getHKDateKey,
  getTradingMinutesSinceOpen,
  isWithinMorningOpenProtection,
} from '../../utils/helpers/tradingTime.js';
import { logger } from '../../utils/logger/index.js';
import { signalObjectPool } from '../../utils/objectPool/index.js';
import {
  AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
  AUTO_SYMBOL_SEARCH_COOLDOWN_MS,
  PENDING_ORDER_STATUSES,
} from '../../constants/index.js';
import type {
  AutoSymbolManager,
  AutoSymbolManagerDeps,
  SwitchState,
  SwitchSuppression,
} from './types.js';
import {
  createThresholdResolver,
  resolveAutoSearchThresholds,
} from './thresholdResolver.js';
import { calculateBuyQuantityByNotional, createSignalBuilder, resolveDirectionSymbols } from './signalBuilder.js';
import { createSeatStateManager } from './seatStateManager.js';
import { createAutoSearch } from './autoSearch.js';
import { createSwitchStateMachine } from './switchStateMachine.js';

/**
 * 创建自动换标管理器
 *
 * 负责席位初始化、自动寻标与换标流程的完整管理。
 * 通过距离阈值判断触发换标，执行撤单/卖出/买入的完整链路。
 */
export function createAutoSymbolManager(deps: AutoSymbolManagerDeps): AutoSymbolManager {
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

  const monitorSymbol = monitorConfig.monitorSymbol;
  const autoSearchConfig = monitorConfig.autoSearchConfig;

  const switchStates = new Map<'LONG' | 'SHORT', SwitchState>();
  const switchSuppressions = new Map<'LONG' | 'SHORT', SwitchSuppression>();

  const thresholdResolver = createThresholdResolver({
    autoSearchConfig,
    monitorSymbol,
    marketDataClient,
    logger,
    getTradingMinutesSinceOpen,
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
    resolveAutoSearchThresholdInput: thresholdResolver.resolveAutoSearchThresholdInput,
    buildFindBestWarrantInput: thresholdResolver.buildFindBestWarrantInput,
    findBestWarrant,
    isWithinMorningOpenProtection,
    searchCooldownMs: AUTO_SYMBOL_SEARCH_COOLDOWN_MS,
    getHKDateKey,
    maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
    logger,
  });

  const switchStateMachine = createSwitchStateMachine({
    autoSearchConfig,
    monitorConfig,
    monitorSymbol,
    symbolRegistry,
    trader,
    orderRecorder,
    riskChecker,
    now,
    switchStates,
    resolveSuppression: seatStateManager.resolveSuppression,
    markSuppression: seatStateManager.markSuppression,
    clearSeat: seatStateManager.clearSeat,
    buildSeatState: seatStateManager.buildSeatState,
    updateSeatState: seatStateManager.updateSeatState,
    resolveAutoSearchThresholds,
    resolveAutoSearchThresholdInput: thresholdResolver.resolveAutoSearchThresholdInput,
    buildFindBestWarrantInput: thresholdResolver.buildFindBestWarrantInput,
    findBestWarrant,
    resolveDirectionSymbols,
    calculateBuyQuantityByNotional,
    buildOrderSignal: signalBuilder.buildOrderSignal,
    signalObjectPool,
    pendingOrderStatuses: PENDING_ORDER_STATUSES,
    buySide: OrderSide.Buy,
    logger,
    maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
    getHKDateKey,
  });

  /** 清空换标状态与日内抑制记录，用于交易日切换或重新初始化。 */
  function resetAllState(): void {
    switchStates.clear();
    switchSuppressions.clear();
  }

  return {
    maybeSearchOnTick: autoSearch.maybeSearchOnTick,
    maybeSwitchOnDistance: switchStateMachine.maybeSwitchOnDistance,
    hasPendingSwitch: switchStateMachine.hasPendingSwitch,
    resetAllState,
  };
}
