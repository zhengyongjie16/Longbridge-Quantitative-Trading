/**
 * main-program-strict 集成测试
 *
 * 功能：
 * - 验证主程序严格模式端到端场景与业务期望。
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import {
  createDoomsdayProtectionDouble,
  createMonitorConfigDouble,
  createPositionCacheDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

import type { MainProgramContext } from '../../src/main/mainProgram/types.js';
import type { LastState, MonitorContext } from '../../src/types/state.js';
import type { Quote } from '../../src/types/quote.js';

const processMonitorCalls: Array<{
  readonly monitorSymbol: string;
  readonly openProtectionActive: boolean;
  readonly canTradeNow: boolean;
}> = [];

const tradingTimeOverrides = {
  dayKey: null as string | null,
  isInContinuousSession: null as boolean | null,
  morningOpenProtection: null as boolean | null,
  afternoonOpenProtection: null as boolean | null,
};

function getHKDateKeyFallback(now: Date): string {
  const hkDate = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = hkDate.getUTCFullYear();
  const month = String(hkDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(hkDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resolveHKMinuteOfDay(now: Date): number {
  const hkTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return hkTime.getUTCHours() * 60 + hkTime.getUTCMinutes();
}

function isInContinuousHKSessionFallback(now: Date, isHalfDay: boolean): boolean {
  const minuteOfDay = resolveHKMinuteOfDay(now);
  const inMorning = minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 12 * 60;
  if (isHalfDay) {
    return inMorning;
  }
  const inAfternoon = minuteOfDay >= 13 * 60 && minuteOfDay < 16 * 60;
  return inMorning || inAfternoon;
}

function isWithinMorningOpenProtectionFallback(now: Date, minutes: number): boolean {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return false;
  }
  const minuteOfDay = resolveHKMinuteOfDay(now);
  const start = 9 * 60 + 30;
  return minuteOfDay >= start && minuteOfDay < start + minutes;
}

function isWithinAfternoonOpenProtectionFallback(now: Date, minutes: number): boolean {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return false;
  }
  const minuteOfDay = resolveHKMinuteOfDay(now);
  const start = 13 * 60;
  return minuteOfDay >= start && minuteOfDay < start + minutes;
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun:test mock.module 在导入 mainProgram 前同步注册
mock.module('../../src/main/processMonitor/index.js', () => ({
  processMonitor: async ({
    monitorContext,
    runtimeFlags,
  }: {
    readonly monitorContext: { readonly config: { readonly monitorSymbol: string } };
    readonly runtimeFlags: {
      readonly openProtectionActive: boolean;
      readonly canTradeNow: boolean;
    };
  }) => {
    processMonitorCalls.push({
      monitorSymbol: monitorContext.config.monitorSymbol,
      openProtectionActive: runtimeFlags.openProtectionActive,
      canTradeNow: runtimeFlags.canTradeNow,
    });
  },
}));

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun:test mock.module 在导入 mainProgram 前同步注册
mock.module('../../src/utils/helpers/tradingTime.js', () => ({
  getHKDateKey: (now: Date) => tradingTimeOverrides.dayKey ?? getHKDateKeyFallback(now),
  isInContinuousHKSession: (now: Date, isHalfDay: boolean) =>
    tradingTimeOverrides.isInContinuousSession ?? isInContinuousHKSessionFallback(now, isHalfDay),
  isWithinMorningOpenProtection: (now: Date, minutes: number) =>
    tradingTimeOverrides.morningOpenProtection ??
    isWithinMorningOpenProtectionFallback(now, minutes),
  isWithinAfternoonOpenProtection: (now: Date, minutes: number) =>
    tradingTimeOverrides.afternoonOpenProtection ??
    isWithinAfternoonOpenProtectionFallback(now, minutes),
}));

import { mainProgram } from '../../src/main/mainProgram/index.js';

function createLastState(overrides: Partial<LastState> = {}): LastState {
  return {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
    ...overrides,
  };
}

function createMonitorContext(
  monitorSymbol: string,
  pendingCount: number,
  onCancel: (symbol: string) => void,
): MonitorContext {
  const config = createMonitorConfigDouble({ monitorSymbol });
  return {
    config,
    monitorSymbolName: monitorSymbol,
    delayedSignalVerifier: {
      getPendingCount: () => pendingCount,
      cancelAllForSymbol: (symbol: string) => {
        onCancel(symbol);
      },
    },
  } as unknown as MonitorContext;
}

function createQueues(): Pick<
  MainProgramContext,
  'buyTaskQueue' | 'sellTaskQueue' | 'monitorTaskQueue' | 'indicatorCache'
> {
  return {
    indicatorCache: {
      push: () => {},
      getAt: () => null,
      clearAll: () => {},
    },
    buyTaskQueue: {
      push: () => {},
      pop: () => null,
      isEmpty: () => true,
      removeTasks: () => 0,
      clearAll: () => 0,
      onTaskAdded: () => () => {},
    },
    sellTaskQueue: {
      push: () => {},
      pop: () => null,
      isEmpty: () => true,
      removeTasks: () => 0,
      clearAll: () => 0,
      onTaskAdded: () => () => {},
    },
    monitorTaskQueue: {
      scheduleLatest: () => {},
      pop: () => null,
      isEmpty: () => true,
      removeTasks: () => 0,
      clearAll: () => 0,
      onTaskAdded: () => () => {},
    },
  } as const;
}

describe('mainProgram strict-mode integration', () => {
  beforeEach(() => {
    processMonitorCalls.length = 0;
    tradingTimeOverrides.dayKey = null;
    tradingTimeOverrides.isInContinuousSession = null;
    tradingTimeOverrides.morningOpenProtection = null;
    tradingTimeOverrides.afternoonOpenProtection = null;
  });

  afterEach(() => {
    tradingTimeOverrides.dayKey = null;
    tradingTimeOverrides.isInContinuousSession = null;
    tradingTimeOverrides.morningOpenProtection = null;
    tradingTimeOverrides.afternoonOpenProtection = null;
  });

  it('clears pending delayed signals and exits early when leaving continuous session', async () => {
    tradingTimeOverrides.dayKey = '2026-02-16';
    tradingTimeOverrides.isInContinuousSession = false;

    const cancelledSymbols: string[] = [];
    const monitorContext = createMonitorContext('HSI.HK', 2, (symbol) => {
      cancelledSymbols.push(symbol);
    });
    const monitorContexts = new Map<string, MonitorContext>([['HSI.HK', monitorContext]]);
    const lastState = createLastState({
      canTrade: true,
      cachedTradingDayInfo: { isTradingDay: true, isHalfDay: false },
    });

    let getQuotesCalls = 0;
    const dayLifecycleTicks: Array<{
      canTradeNow: boolean;
      isTradingDay: boolean;
      dayKey: string | null;
    }> = [];

    await mainProgram({
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map<string, Quote | null>();
        },
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => [],
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
        resetRuntimeSubscriptionsAndCaches: async () => {},
      },
      trader: createTraderDouble(),
      lastState,
      marketMonitor: {
        monitorPriceChanges: () => false,
        monitorIndicatorChanges: () => false,
      },
      doomsdayProtection: createDoomsdayProtectionDouble(),
      signalProcessor: {
        processSellSignals: (params) => params.signals,
        applyRiskChecks: async (signals) => signals,
        resetRiskCheckCooldown: () => {},
      },
      tradingConfig: createTradingConfig({
        monitors: [createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' })],
        global: {
          ...createTradingConfig().global,
          doomsdayProtection: false,
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      monitorContexts,
      symbolRegistry: createSymbolRegistryDouble({ monitorSymbol: 'HSI.HK' }),
      ...createQueues(),
      orderMonitorWorker: {
        start: () => {},
        schedule: () => {},
        stopAndDrain: async () => {},
        clearLatestQuotes: () => {},
      },
      postTradeRefresher: {
        start: () => {},
        enqueue: () => {},
        stopAndDrain: async () => {},
        clearPending: () => {},
      },
      runtimeGateMode: 'strict',
      dayLifecycleManager: {
        tick: async (_now, runtime) => {
          dayLifecycleTicks.push(runtime);
        },
      },
    });

    expect(cancelledSymbols).toEqual(['HSI.HK']);
    expect(processMonitorCalls).toHaveLength(0);
    expect(getQuotesCalls).toBe(0);
    expect(dayLifecycleTicks).toHaveLength(1);
    expect(dayLifecycleTicks[0]).toEqual({
      canTradeNow: false,
      isTradingDay: true,
      dayKey: '2026-02-16',
    });
  });

  it('short-circuits the loop after doomsday clearance executes', async () => {
    tradingTimeOverrides.dayKey = '2026-02-16';
    tradingTimeOverrides.isInContinuousSession = true;

    const monitorContext = createMonitorContext('HSI.HK', 0, () => {});
    const monitorContexts = new Map<string, MonitorContext>([['HSI.HK', monitorContext]]);
    const lastState = createLastState({
      cachedTradingDayInfo: { isTradingDay: true, isHalfDay: false },
    });

    let cancelCalls = 0;
    let clearanceCalls = 0;
    let getQuotesCalls = 0;
    let orderMonitorScheduleCalls = 0;

    await mainProgram({
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map<string, Quote | null>();
        },
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => [],
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
        resetRuntimeSubscriptionsAndCaches: async () => {},
      },
      trader: createTraderDouble(),
      lastState,
      marketMonitor: {
        monitorPriceChanges: () => false,
        monitorIndicatorChanges: () => false,
      },
      doomsdayProtection: createDoomsdayProtectionDouble({
        cancelPendingBuyOrders: async () => {
          cancelCalls += 1;
          return { executed: true, cancelledCount: 1 };
        },
        executeClearance: async () => {
          clearanceCalls += 1;
          return { executed: true, signalCount: 2 };
        },
      }),
      signalProcessor: {
        processSellSignals: (params) => params.signals,
        applyRiskChecks: async (signals) => signals,
        resetRiskCheckCooldown: () => {},
      },
      tradingConfig: createTradingConfig({
        monitors: [createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' })],
        global: {
          ...createTradingConfig().global,
          doomsdayProtection: true,
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      monitorContexts,
      symbolRegistry: createSymbolRegistryDouble({ monitorSymbol: 'HSI.HK' }),
      ...createQueues(),
      orderMonitorWorker: {
        start: () => {},
        schedule: () => {
          orderMonitorScheduleCalls += 1;
        },
        stopAndDrain: async () => {},
        clearLatestQuotes: () => {},
      },
      postTradeRefresher: {
        start: () => {},
        enqueue: () => {},
        stopAndDrain: async () => {},
        clearPending: () => {},
      },
      runtimeGateMode: 'strict',
      dayLifecycleManager: {
        tick: async () => {},
      },
    });

    expect(cancelCalls).toBe(1);
    expect(clearanceCalls).toBe(1);
    expect(getQuotesCalls).toBe(0);
    expect(processMonitorCalls).toHaveLength(0);
    expect(orderMonitorScheduleCalls).toBe(0);
  });

  it('keeps held symbols from unsubscribe and propagates strict open-protection flag', async () => {
    tradingTimeOverrides.dayKey = '2026-02-16';
    tradingTimeOverrides.isInContinuousSession = true;
    tradingTimeOverrides.morningOpenProtection = true;

    const heldPosition = {
      symbol: 'OLD.HK',
      symbolName: 'OLD.HK',
      quantity: 100,
      availableQuantity: 100,
      accountChannel: 'lb_papertrading',
      currency: 'HKD',
      costPrice: 1,
      market: 'HK',
    };
    const positionCache = createPositionCacheDouble([heldPosition]);

    const lastState = createLastState({
      cachedTradingDayInfo: { isTradingDay: true, isHalfDay: false },
      cachedPositions: [],
      positionCache,
      allTradingSymbols: new Set(['OLD.HK']),
    });

    const monitorSymbol = 'HSI.HK';
    const monitorConfig = createMonitorConfigDouble({ monitorSymbol });
    const monitorContext = createMonitorContext(monitorSymbol, 0, () => {});
    const monitorContexts = new Map<string, MonitorContext>([[monitorSymbol, monitorContext]]);

    const subscribedBatches: string[][] = [];
    const unsubscribedBatches: string[][] = [];
    let getQuotesSymbols: string[] = [];
    let orderMonitorScheduleCalls = 0;
    let postTradeEnqueueCalls = 0;

    await mainProgram({
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async (symbols) => {
          getQuotesSymbols = Array.from(symbols);
          const quotes = new Map<string, Quote | null>();
          for (const symbol of getQuotesSymbols) {
            quotes.set(symbol, createQuoteDouble(symbol, 1, 100));
          }
          return quotes;
        },
        subscribeSymbols: async (symbols) => {
          subscribedBatches.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribedBatches.push([...symbols]);
        },
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => [],
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
        resetRuntimeSubscriptionsAndCaches: async () => {},
      },
      trader: createTraderDouble({
        getOrderHoldSymbols: () => new Set<string>(),
      }),
      lastState,
      marketMonitor: {
        monitorPriceChanges: () => false,
        monitorIndicatorChanges: () => false,
      },
      doomsdayProtection: createDoomsdayProtectionDouble(),
      signalProcessor: {
        processSellSignals: (params) => params.signals,
        applyRiskChecks: async (signals) => signals,
        resetRiskCheckCooldown: () => {},
      },
      tradingConfig: createTradingConfig({
        monitors: [monitorConfig],
        global: {
          ...createTradingConfig().global,
          doomsdayProtection: false,
          openProtection: {
            morning: { enabled: true, minutes: 15 },
            afternoon: { enabled: false, minutes: null },
          },
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      monitorContexts,
      symbolRegistry: createSymbolRegistryDouble({ monitorSymbol }),
      ...createQueues(),
      orderMonitorWorker: {
        start: () => {},
        schedule: () => {
          orderMonitorScheduleCalls += 1;
        },
        stopAndDrain: async () => {},
        clearLatestQuotes: () => {},
      },
      postTradeRefresher: {
        start: () => {},
        enqueue: () => {
          postTradeEnqueueCalls += 1;
        },
        stopAndDrain: async () => {},
        clearPending: () => {},
      },
      runtimeGateMode: 'strict',
      dayLifecycleManager: {
        tick: async () => {},
      },
    });

    expect(processMonitorCalls).toHaveLength(1);
    expect(processMonitorCalls[0]?.openProtectionActive).toBeTrue();
    expect(processMonitorCalls[0]?.canTradeNow).toBeTrue();

    const subscribed = subscribedBatches.flat();
    expect(subscribed).toContain('HSI.HK');
    expect(subscribed).toContain('BULL.HK');
    expect(subscribed).toContain('BEAR.HK');
    expect(unsubscribedBatches.flat()).toHaveLength(0);

    expect(getQuotesSymbols).toContain('OLD.HK');
    expect(orderMonitorScheduleCalls).toBe(1);
    expect(postTradeEnqueueCalls).toBe(1);
    expect(lastState.allTradingSymbols.has('OLD.HK')).toBeTrue();
  });
});
