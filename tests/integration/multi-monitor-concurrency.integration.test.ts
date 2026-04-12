/**
 * multi-monitor-concurrency 集成测试
 *
 * 功能：
 * - 验证 timeDriverProgram 在单个 monitor 处理失败时仍继续处理其他 monitor。
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { TimeDriverProgramModule } from './types.js';

const processCalls: string[] = [];

async function loadTimeDriverProgram(): Promise<TimeDriverProgramModule> {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun:test mock.module 同步注册
  mock.module('../../src/main/processMonitor/index.js', () => ({
    processMonitor: ({
      monitorContext,
    }: {
      monitorContext: { config: { monitorSymbol: string } };
    }): void => {
      const symbol = monitorContext.config.monitorSymbol;
      processCalls.push(symbol);
      if (symbol === 'HSI-A.HK') {
        throw new Error('simulated monitor failure');
      }
    },
  }));

  const timeDriverProgramModulePath =
    '../../src/main/timeDriverProgram/index.js?mocked-multi-monitor-concurrency';
  const loadedModuleUnknown: unknown = await import(timeDriverProgramModulePath);
  return loadedModuleUnknown as TimeDriverProgramModule;
}

import type { LastState } from '../../src/types/state.js';
import type { Quote } from '../../src/types/quote.js';
import type { MultiMonitorTradingConfig } from '../../src/types/config.js';

import {
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createPositionCacheDouble,
  createQuoteSubscriptionRuntimeDouble,
  createTradingGateEventRuntimeDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

function createLastState(): LastState {
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
  };
}

describe('multi-monitor isolation integration', () => {
  afterEach(() => {
    if (typeof mock.restore === 'function') {
      mock.restore();
    }
  });

  it('continues processing other monitors when one monitor fails', async () => {
    processCalls.length = 0;

    const configA = createMonitorConfigDouble({
      monitorSymbol: 'HSI-A.HK',
      longSymbol: 'BULL-A.HK',
      shortSymbol: 'BEAR-A.HK',
    });
    const configB = createMonitorConfigDouble({
      originalIndex: 2,
      monitorSymbol: 'HSI-B.HK',
      longSymbol: 'BULL-B.HK',
      shortSymbol: 'BEAR-B.HK',
    });

    const tradingConfig: MultiMonitorTradingConfig = {
      monitors: [configA, configB],
      global: {
        doomsdayProtection: false,
        debug: false,
        openProtection: {
          morning: { enabled: false, minutes: null },
          afternoon: { enabled: false, minutes: null },
        },
        orderMonitorPriceUpdateInterval: 5,
        allowBuyOrderTrackingAboveInitialPrice: true,
        tradingOrderType: 'ELO',
        liquidationOrderType: 'MO',
        buyOrderTimeout: { enabled: true, timeoutSeconds: 180 },
        sellOrderTimeout: { enabled: true, timeoutSeconds: 180 },
      },
    };
    const loadedMainProgram = await loadTimeDriverProgram();
    const timeDriverProgram = loadedMainProgram.timeDriverProgram;
    await timeDriverProgram({
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async (symbols: Iterable<string>) => {
          const map = new Map<string, Quote | null>();
          for (const symbol of symbols) {
            map.set(symbol, {
              symbol,
              name: symbol,
              price: 1,
              prevClose: 1,
              timestamp: Date.now(),
              lotSize: 100,
            });
          }

          return map;
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
      lastState: createLastState(),
      marketMonitor: {
        monitorPriceChanges: () => false,
        monitorIndicatorChanges: () => false,
      },
      doomsdayProtection: {
        isBuyCutoffWindowActive: () => false,
        executeClearance: async () => ({ executed: false, signalCount: 0 }),
        cancelPendingBuyOrders: async () => ({ executed: false, cancelRequestAcceptedCount: 0 }),
      },
      tradingConfig,
      monitorContexts: new Map([
        [configA.monitorSymbol, createMonitorContextDouble({ config: configA })],
        [configB.monitorSymbol, createMonitorContextDouble({ config: configB })],
      ]),
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
      runtimeGateMode: 'skip',
      tradingGateEventRuntime: createTradingGateEventRuntimeDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      dayLifecycleManager: {
        tick: async () => {},
      },
    });

    expect(processCalls).toContain('HSI-A.HK');
    expect(processCalls).toContain('HSI-B.HK');
  });
});
