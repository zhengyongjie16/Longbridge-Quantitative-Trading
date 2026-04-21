/**
 * time-driver-program-strict 集成测试
 *
 * 功能：
 * - 验证 timeDriverProgram 严格模式端到端场景与业务期望。
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import {
  createDoomsdayProtectionDouble,
  createMonitorConfigDouble,
  createPositionCacheDouble,
  createQuoteSubscriptionRuntimeDouble,
  createQuoteDouble,
  createTradingGateEventRuntimeDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

import type { TimeDriverProgramContext } from '../../src/main/timeDriverProgram/types.js';
import type * as TimeModule from '../../src/utils/time/index.js';
import type { LastState, MonitorContext } from '../../src/types/state.js';
import type { Quote } from '../../src/types/quote.js';
import type { TimeDriverProgramModule } from './types.js';

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

async function loadTimeDriverProgram(): Promise<TimeDriverProgramModule> {
  const actualTimeModulePath = '../../src/utils/time/index.js?actual-time-driver-program-strict';
  const actualTimeModuleUnknown: unknown = await import(actualTimeModulePath);
  const actualTimeModule = actualTimeModuleUnknown as typeof TimeModule;

  // eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun:test mock.module 在导入 timeDriverProgram 前同步注册
  mock.module('../../src/main/processMonitor/index.js', () => ({
    processMonitor: ({
      monitorContext,
      runtimeFlags,
    }: {
      readonly monitorContext: { readonly config: { readonly monitorSymbol: string } };
      readonly runtimeFlags: {
        readonly openProtectionActive: boolean;
        readonly canTradeNow: boolean;
      };
    }): void => {
      processMonitorCalls.push({
        monitorSymbol: monitorContext.config.monitorSymbol,
        openProtectionActive: runtimeFlags.openProtectionActive,
        canTradeNow: runtimeFlags.canTradeNow,
      });
    },
  }));

  // eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun:test mock.module 在导入 timeDriverProgram 前同步注册
  mock.module('../../src/utils/time/index.js', () => ({
    ...actualTimeModule,
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

  const timeDriverProgramModulePath =
    '../../src/main/timeDriverProgram/index.js?mocked-time-driver-program-strict';
  const loadedModuleUnknown: unknown = await import(timeDriverProgramModulePath);
  return loadedModuleUnknown as TimeDriverProgramModule;
}

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
    state: {
      lastMonitorSnapshot: null,
    },
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
  TimeDriverProgramContext,
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

describe('timeDriverProgram strict-mode integration', () => {
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
    mock.restore();
  });

  it('clears pending delayed signals and exits early without enqueueing post-trade refresh when leaving continuous session', async () => {
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

    const loadedTimeDriverProgram = await loadTimeDriverProgram();
    const { timeDriverProgram } = loadedTimeDriverProgram;
    await timeDriverProgram({
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map<string, Quote | null>();
        },
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {},
        onQuoteUpdated: () => () => {},
        onCandlestickUpdated: () => () => {},
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => [],
        getCandlestickSnapshot: () => null,
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
      tradingConfig: createTradingConfig({
        monitors: [createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' })],
        global: {
          ...createTradingConfig().global,
          doomsdayProtection: false,
        },
      }),
      monitorContexts,
      ...createQueues(),
      runtimeGateMode: 'strict',
      tradingGateEventRuntime: createTradingGateEventRuntimeDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      dayLifecycleManager: {
        tick: async (
          _now: Date,
          runtime: {
            readonly canTradeNow: boolean;
            readonly isTradingDay: boolean;
            readonly dayKey: string | null;
          },
        ) => {
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

  it('uses committed quote set for doomsday clearance and short-circuits after clearance executes', async () => {
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
    const callSequence: string[] = [];

    const loadedTimeDriverProgram = await loadTimeDriverProgram();
    const { timeDriverProgram } = loadedTimeDriverProgram;
    await timeDriverProgram({
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async () => {
          callSequence.push('getQuotes');
          getQuotesCalls += 1;
          return new Map<string, Quote | null>();
        },
        subscribeSymbols: async () => {
          callSequence.push('subscribeSymbols');
        },
        unsubscribeSymbols: async () => {
          callSequence.push('unsubscribeSymbols');
        },
        onQuoteUpdated: () => () => {},
        onCandlestickUpdated: () => () => {},
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => [],
        getCandlestickSnapshot: () => null,
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
          callSequence.push('cancelPendingBuyOrders');
          cancelCalls += 1;
          return { executed: true, cancelRequestAcceptedCount: 1 };
        },
        executeClearance: async () => {
          callSequence.push('executeClearance');
          clearanceCalls += 1;
          return { executed: true, signalCount: 2 };
        },
      }),
      tradingConfig: createTradingConfig({
        monitors: [createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' })],
        global: {
          ...createTradingConfig().global,
          doomsdayProtection: true,
        },
      }),
      monitorContexts,
      ...createQueues(),
      runtimeGateMode: 'strict',
      tradingGateEventRuntime: createTradingGateEventRuntimeDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      dayLifecycleManager: {
        tick: async () => {},
      },
    });

    expect(cancelCalls).toBe(1);
    expect(clearanceCalls).toBe(1);
    expect(getQuotesCalls).toBe(0);
    expect(processMonitorCalls).toHaveLength(0);
    expect(callSequence.slice(0, 2)).toEqual(['cancelPendingBuyOrders', 'executeClearance']);
  });

  it('projects only verification sample values into indicatorCache on tick', async () => {
    tradingTimeOverrides.dayKey = '2026-02-16';
    tradingTimeOverrides.isInContinuousSession = true;

    const pushes: Array<{
      readonly monitorSymbol: string;
      readonly values: Record<string, { readonly kind: string; readonly value?: number }>;
      readonly sampleTimestampMs: number;
    }> = [];

    const monitorContext = createMonitorContext('HSI.HK', 0, () => {});
    monitorContext.state.lastMonitorSnapshot = {
      price: 100,
      changePercent: 0,
      ema: { 5: 105 },
      rsi: { 6: 60 },
      psy: { 12: 70 },
      mfi: 50,
      kdj: { k: 80, d: 70, j: 90 },
      macd: { macd: 1, dif: 2, dea: 3 },
      adx: null,
    };

    Object.assign(monitorContext.indicatorProfile, {
      requiredFamilies: { mfi: true, kdj: true, macd: true, adx: false },
      requiredPeriods: { rsi: [6], ema: [5], psy: [12] },
      actionSignalIndicators: {
        BUYCALL: ['K'],
        SELLCALL: ['K'],
        BUYPUT: ['K'],
        SELLPUT: ['K'],
      },
      verificationIndicatorsBySide: {
        buy: ['K', 'EMA:5'],
        sell: ['ADX', 'PSY:12'],
      },
      displayPlan: ['price'],
    });
    const monitorContexts = new Map<string, MonitorContext>([['HSI.HK', monitorContext]]);
    const lastState = createLastState({
      cachedTradingDayInfo: { isTradingDay: true, isHalfDay: false },
      allTradingSymbols: new Set(['HSI.HK']),
    });

    const queues = createQueues();
    const loadedTimeDriverProgram = await loadTimeDriverProgram();
    const { timeDriverProgram } = loadedTimeDriverProgram;
    await timeDriverProgram({
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async () =>
          new Map<string, Quote | null>([['HSI.HK', createQuoteDouble('HSI.HK', 1, 100)]]),
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {},
        onQuoteUpdated: () => () => {},
        onCandlestickUpdated: () => () => {},
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => [],
        getCandlestickSnapshot: () => null,
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
      tradingConfig: createTradingConfig({
        monitors: [createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' })],
        global: {
          ...createTradingConfig().global,
          doomsdayProtection: false,
        },
      }),
      monitorContexts,
      buyTaskQueue: queues.buyTaskQueue,
      sellTaskQueue: queues.sellTaskQueue,
      monitorTaskQueue: queues.monitorTaskQueue,
      indicatorCache: {
        push: (monitorSymbol, values, sampleTimestampMs) => {
          pushes.push({
            monitorSymbol,
            values: values as Record<string, { readonly kind: string; readonly value?: number }>,
            sampleTimestampMs,
          });
        },
        getAt: () => null,
        clearAll: () => {},
      },
      runtimeGateMode: 'strict',
      tradingGateEventRuntime: createTradingGateEventRuntimeDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      dayLifecycleManager: {
        tick: async () => {},
      },
    });

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.monitorSymbol).toBe('HSI.HK');
    expect(pushes[0]?.values).toEqual({
      K: { kind: 'value', value: 80 },
      'EMA:5': { kind: 'value', value: 105 },
      ADX: { kind: 'missing' },
      'PSY:12': { kind: 'value', value: 70 },
    });
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

    const loadedTimeDriverProgram = await loadTimeDriverProgram();
    const { timeDriverProgram } = loadedTimeDriverProgram;
    await timeDriverProgram({
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async (symbols: Iterable<string>) => {
          getQuotesSymbols = [...symbols];
          const quotes = new Map<string, Quote | null>();
          for (const symbol of getQuotesSymbols) {
            quotes.set(symbol, createQuoteDouble(symbol, 1, 100));
          }

          return quotes;
        },
        subscribeSymbols: async (symbols: Iterable<string>) => {
          subscribedBatches.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols: Iterable<string>) => {
          unsubscribedBatches.push([...symbols]);
        },
        onQuoteUpdated: () => () => {},
        onCandlestickUpdated: () => () => {},
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => [],
        getCandlestickSnapshot: () => null,
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
      monitorContexts,
      ...createQueues(),
      runtimeGateMode: 'strict',
      tradingGateEventRuntime: createTradingGateEventRuntimeDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      dayLifecycleManager: {
        tick: async () => {},
      },
    });

    expect(processMonitorCalls).toHaveLength(1);
    expect(processMonitorCalls[0]?.openProtectionActive).toBeTrue();
    expect(processMonitorCalls[0]?.canTradeNow).toBeTrue();

    expect(subscribedBatches.flat()).toHaveLength(0);
    expect(unsubscribedBatches.flat()).toHaveLength(0);

    expect(getQuotesSymbols).toContain('OLD.HK');
    expect(lastState.allTradingSymbols.has('OLD.HK')).toBeTrue();
  });
});
