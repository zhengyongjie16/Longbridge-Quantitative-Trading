import type { CleanupContext } from '../../../src/app/types.js';
import type { MonitorTaskProcessor } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { MarketDataClient } from '../../../src/types/services.js';
import type { LastState, MonitorState } from '../../../src/types/state.js';

/**
 * 构造单监控标的的 MonitorState，含默认指标快照，供 cleanup 测试使用。
 *
 * @param monitorSymbol 监控标的代码
 * @returns 用于测试的 MonitorState
 */
export function createMonitorState(monitorSymbol: string): MonitorState {
  return {
    monitorSymbol,
    signal: null,
    pendingDelayedSignals: [],
    lastMonitorSnapshot: {
      price: 20_000,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: { k: 50, d: 50, j: 50 },
      macd: { macd: 0, dif: 0, dea: 0 },
      adx: null,
    },
    incrementalIndicatorRuntime: null,
  };
}

/**
 * 构造 LastState，仅填充 monitorStates 与基础字段，其余为测试用占位，供 cleanup 测试使用。
 *
 * @param monitorStates 监控状态 Map
 * @returns 用于测试的 LastState
 */
export function createLastState(monitorStates: ReadonlyMap<string, MonitorState>): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: {
      update: () => {},
      get: () => null,
    },
    cachedTradingDayInfo: null,
    monitorStates,
    allTradingSymbols: new Set(),
  };
}

/**
 * 构造 cleanup 测试依赖的默认实现，并将每个清理步骤写入 steps。
 *
 * @param steps 步骤记录数组
 * @returns 默认 CleanupContext
 */
function defaultDeps(steps: string[]): CleanupContext {
  const monitorTaskProcessor: MonitorTaskProcessor = {
    start: () => {},
    stopAndDrain: async () => {
      steps.push('monitorTask');
    },
    restart: () => {},
  };
  const marketDataClient: MarketDataClient = {
    getQuoteContext: async () => {
      throw new Error('cleanup test should not request quote context');
    },
    getQuotes: async () => new Map(),
    subscribeSymbols: async () => {},
    unsubscribeSymbols: async () => {},
    onQuoteUpdated: () => () => {},
    onCandlestickUpdated: () => () => {},
    subscribeCandlesticks: async () => [],
    getCandlestickSnapshot: () => null,
    isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
    resetRuntimeSubscriptionsAndCaches: async () => {
      steps.push('resetMarketData');
    },
  };

  return {
    timeWakeupRuntime: {
      start: async () => {},
      requestEvaluate: () => {},
      stopAndDrain: async () => {
        steps.push('timeWakeupRuntime');
      },
      getStateSnapshot: () => ({
        running: false,
        inFlight: false,
        dirty: false,
        hasTimer: false,
      }),
    },
    tradingRiskEventRuntime: {
      start: () => {},
      stopAndDrain: async () => {
        steps.push('tradingRiskEventRuntime');
      },
    },
    switchWakeupRuntime: {
      start: () => {},
      stopAndDrain: async () => {
        steps.push('switchWakeupRuntime');
      },
      handoffPendingSwitch: () => {},
    },
    periodicSwitchWakeupRuntime: {
      start: () => {},
      stopAndDrain: async () => {
        steps.push('periodicSwitchWakeupRuntime');
      },
      markWaitingEmpty: () => {},
      clearWaitingEmpty: () => {},
      replanRouteAfterTask: () => {},
    },
    monitorQuoteEventRuntime: {
      start: () => {},
      stopAndDrain: async () => {
        steps.push('monitorQuoteEventRuntime');
      },
    },
    monitorDisplayRuntime: {
      start: () => {},
      requestRender: () => {},
      stopAndDrain: async () => {
        steps.push('monitorDisplayRuntime');
      },
    },
    tradingQuoteDisplayRuntime: {
      start: () => {},
      stopAndDrain: async () => {
        steps.push('tradingQuoteDisplayRuntime');
      },
    },
    seatRuntimeCleanupDispatcher: {
      start: () => {},
      stop: () => {
        steps.push('seatRuntimeCleanupDispatcher');
      },
    },
    quoteSubscriptionRuntime: {
      reconcileFromCurrentTruth: async () => {
        steps.push('quoteSubscriptionRuntime.reconcile');
      },
      reconcilePositionHoldFromCurrentTruth: async () => {},
      start: () => {
        steps.push('quoteSubscriptionRuntime.start');
      },
      stopAndDrain: async () => {
        steps.push('quoteSubscriptionRuntime');
      },
      retainSymbols: async () => () => {},
      releaseRetain: async () => {},
      waitForAdmission: async () => {},
    },
    seatActivationDispatcher: {
      start: () => {
        steps.push('seatActivationDispatcher.start');
      },
      stop: () => {
        steps.push('seatActivationDispatcher');
      },
    },
    autoSearchWakeupRuntime: {
      start: () => {
        steps.push('autoSearchWakeupRuntime.start');
      },
      stopAndDrain: async () => {
        steps.push('autoSearchWakeupRuntime');
      },
    },
    buyProcessor: {
      start: () => {},
      stop: () => {},
      stopAndDrain: async () => {
        steps.push('buy');
      },
      restart: () => {},
    },
    sellProcessor: {
      start: () => {},
      stop: () => {},
      stopAndDrain: async () => {
        steps.push('sell');
      },
      restart: () => {},
    },
    monitorTaskProcessor,
    trader: {
      stopOrderMonitorRuntimeAndDrain: async () => {
        steps.push('stopOrderMonitorRuntimeAndDrain');
      },
    },
    businessEventProgram: {
      start: () => {},
      stopAndDrain: async () => {
        steps.push('businessEventProgram');
      },
    },
    postTradeConsistencyRuntime: {
      bindBusinessDeps: () => {},
      recordSettlementRefreshNeed: () => {},
      getStatus: () => ({
        started: false,
        currentVersion: 0,
        staleVersion: 0,
      }),
      waitForFresh: async () => {},
      onFreshReached: () => () => {},
      abortWaiting: () => {
        steps.push('abortWaiting');
      },
      resetAbort: () => {},
      start: () => {},
      stopAndDrain: async () => {
        steps.push('postTradeConsistencyRuntime');
      },
      midnightClear: () => {},
      completeRebuildBaseline: () => {},
    },
    marketDataClient,
    monitorContexts: new Map(),
    indicatorCache: {
      push: () => {},
      getClosest: () => null,
      clearAll: () => {
        steps.push('clearIndicatorCache');
      },
    },
    lastState: createLastState(new Map()),
  };
}

/**
 * 构建 createCleanup 的入参，默认各步骤向 steps 数组 push 名称；可传 overrides 覆盖 monitorContexts、lastState 或任意处理器。
 *
 * @param steps 记录执行步骤顺序的数组
 * @param overrides 对默认依赖的覆盖项
 * @returns 供 createCleanup 使用的 CleanupContext
 */
export function createCleanupDeps(
  steps: string[],
  overrides: Partial<CleanupContext> = {},
): CleanupContext {
  return { ...defaultDeps(steps), ...overrides };
}
