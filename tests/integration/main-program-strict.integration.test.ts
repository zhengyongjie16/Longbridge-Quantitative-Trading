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
import type * as TimeModule from '../../src/utils/time/index.js';
import type { LastState, MonitorContext } from '../../src/types/state.js';
import type { Quote } from '../../src/types/quote.js';
import type { MainProgramModule } from './types.js';

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

async function loadMainProgram(): Promise<MainProgramModule> {
  const actualTimeModulePath = '../../src/utils/time/index.js?actual-main-program-strict';
  const actualTimeModuleUnknown: unknown = await import(actualTimeModulePath);
  const actualTimeModule = actualTimeModuleUnknown as typeof TimeModule;

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

  const mainProgramModulePath = '../../src/main/mainProgram/index.js?mocked-main-program-strict';
  const loadedModuleUnknown: unknown = await import(mainProgramModulePath);
  return loadedModuleUnknown as MainProgramModule;
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

    const loadedMainProgram = await loadMainProgram();
    const { mainProgram } = loadedMainProgram;
    await mainProgram({
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map<string, Quote | null>();
        },
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {},
        onQuoteUpdated: () => () => {},
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
      signalProcessor: {
        processSellSignals: (params) => params.signals,
        applyRiskChecks: async (signals) => signals,
        resetRiskCheckCooldown: () => {},
      } as MainProgramContext['signalProcessor'],
      tradingConfig: createTradingConfig({
        monitors: [createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' })],
        global: {
          ...createTradingConfig().global,
          doomsdayProtection: false,
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        startNewProtectionEpisode: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      monitorContexts,
      symbolRegistry: createSymbolRegistryDouble({ monitorSymbol: 'HSI.HK' }),
      ...createQueues(),
      runtimeGateMode: 'strict',
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

  it('subscribes symbols before doomsday clearance and short-circuits after clearance executes', async () => {
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
    let subscribedSymbols: string[] = [];

    const loadedMainProgram = await loadMainProgram();
    const { mainProgram } = loadedMainProgram;
    await mainProgram({
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async () => {
          callSequence.push('getQuotes');
          getQuotesCalls += 1;
          return new Map<string, Quote | null>();
        },
        subscribeSymbols: async (symbols: Iterable<string>) => {
          callSequence.push('subscribeSymbols');
          subscribedSymbols = [...symbols];
        },
        unsubscribeSymbols: async () => {
          callSequence.push('unsubscribeSymbols');
        },
        onQuoteUpdated: () => () => {},
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
      signalProcessor: {
        processSellSignals: (params) => params.signals,
        applyRiskChecks: async (signals) => signals,
        resetRiskCheckCooldown: () => {},
      } as MainProgramContext['signalProcessor'],
      tradingConfig: createTradingConfig({
        monitors: [createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' })],
        global: {
          ...createTradingConfig().global,
          doomsdayProtection: true,
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        startNewProtectionEpisode: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      monitorContexts,
      symbolRegistry: createSymbolRegistryDouble({ monitorSymbol: 'HSI.HK' }),
      ...createQueues(),
      runtimeGateMode: 'strict',
      dayLifecycleManager: {
        tick: async () => {},
      },
    });

    expect(cancelCalls).toBe(1);
    expect(clearanceCalls).toBe(1);
    expect(getQuotesCalls).toBe(0);
    expect(processMonitorCalls).toHaveLength(0);
    expect(subscribedSymbols).toContain('HSI.HK');
    expect(subscribedSymbols).toContain('BULL.HK');
    expect(subscribedSymbols).toContain('BEAR.HK');
    expect(callSequence.slice(0, 3)).toEqual([
      'subscribeSymbols',
      'cancelPendingBuyOrders',
      'executeClearance',
    ]);
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

    const loadedMainProgram = await loadMainProgram();
    const { mainProgram } = loadedMainProgram;
    await mainProgram({
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
      signalProcessor: {
        processSellSignals: (params) => params.signals,
        applyRiskChecks: async (signals) => signals,
        resetRiskCheckCooldown: () => {},
      } as MainProgramContext['signalProcessor'],
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
        startNewProtectionEpisode: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      monitorContexts,
      symbolRegistry: createSymbolRegistryDouble({ monitorSymbol }),
      ...createQueues(),
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
    expect(lastState.allTradingSymbols.has('OLD.HK')).toBeTrue();
  });
});
