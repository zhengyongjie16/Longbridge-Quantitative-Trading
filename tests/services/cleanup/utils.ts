/**
 * cleanup 业务测试共用工具
 *
 * 供 business.test 使用，抽「准备数据 → 执行清理 → 断言」重复。
 */
import type { CleanupContext } from '../../../src/services/cleanup/types.js';
import type { LastState, MonitorState } from '../../../src/types/state.js';

/**
 * 构造单监控标的的 MonitorState，含默认指标快照，供 cleanup 测试使用。
 *
 * @param monitorSymbol 监控标的
 * @returns 用于测试的 MonitorState
 */
export function createMonitorState(monitorSymbol: string): MonitorState {
  return {
    monitorSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: {
      price: 20_000,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: { k: 50, d: 50, j: 50 },
      macd: { macd: 0, dif: 0, dea: 0 },
    },
    lastMonitorSnapshot: {
      price: 20_000,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: { k: 50, d: 50, j: 50 },
      macd: { macd: 0, dif: 0, dea: 0 },
    },
    lastCandleFingerprint: null,
  };
}

/**
 * 构造 LastState，仅填充 monitorStates 与基础字段，其余为测试用占位，供 cleanup 测试使用。
 *
 * @param monitorStates 监控状态 Map
 * @returns 用于测试的 LastState
 */
export function createLastState(
  monitorStates: ReadonlyMap<string, MonitorState>,
): LastState {
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

function defaultDeps(steps: string[]): CleanupContext {
  return {
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
    monitorTaskProcessor: {
      start: () => {},
      stopAndDrain: async () => {
        steps.push('monitorTask');
      },
    } as never,
    orderMonitorWorker: {
      start: () => {},
      schedule: () => {},
      stopAndDrain: async () => {
        steps.push('orderMonitorWorker');
      },
      clearLatestQuotes: () => {},
    },
    postTradeRefresher: {
      start: () => {},
      enqueue: () => {},
      stopAndDrain: async () => {
        steps.push('postTradeRefresher');
      },
      clearPending: () => {},
    },
    marketDataClient: {
      resetRuntimeSubscriptionsAndCaches: async () => {
        steps.push('resetMarketData');
      },
    } as never,
    monitorContexts: new Map(),
    indicatorCache: {
      push: () => {},
      getAt: () => null,
      clearAll: () => {
        steps.push('clearIndicatorCache');
      },
    },
    lastState: createLastState(new Map()),
  };
}

/**
 * 构建 createCleanup 的入参，默认各步骤向 steps 数组 push 名称；可传 overrides 覆盖 monitorContexts、lastState 或任意处理器。
 */
export function createCleanupDeps(
  steps: string[],
  overrides: Partial<CleanupContext> = {},
): CleanupContext {
  return { ...defaultDeps(steps), ...overrides };
}
