/**
 * multi-monitor-concurrency 集成测试
 *
 * 功能：
 * - 验证多监控并发端到端场景与业务期望。
 */
import { describe, expect, it, mock } from 'bun:test';

const processCalls: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun:test mock.module 同步注册
mock.module('../../src/main/processMonitor/index.js', () => ({
  processMonitor: async ({
    monitorContext,
  }: {
    monitorContext: { config: { monitorSymbol: string } };
  }) => {
    const symbol = monitorContext.config.monitorSymbol;
    processCalls.push(symbol);
    if (symbol === 'HSI-A.HK') {
      throw new Error('simulated monitor failure');
    }
    await Bun.sleep(10);
  },
}));

import { mainProgram } from '../../src/main/mainProgram/index.js';

import type { LastState, MonitorContext } from '../../src/types/state.js';
import type { SymbolRegistry } from '../../src/types/seat.js';
import type { Quote } from '../../src/types/quote.js';
import type { MultiMonitorTradingConfig } from '../../src/types/config.js';

import { createMonitorConfigDouble, createPositionCacheDouble } from '../helpers/testDoubles.js';

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

function createSymbolRegistry(
  configs: ReadonlyArray<{ monitorSymbol: string; longSymbol: string; shortSymbol: string }>,
): SymbolRegistry {
  const map = new Map<string, { long: string; short: string }>();
  for (const cfg of configs) {
    map.set(cfg.monitorSymbol, { long: cfg.longSymbol, short: cfg.shortSymbol });
  }

  return {
    getSeatState: (monitorSymbol, direction) => {
      const row = map.get(monitorSymbol);
      const symbol = direction === 'LONG' ? (row?.long ?? null) : (row?.short ?? null);
      return {
        symbol,
        status: symbol ? 'READY' : 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      };
    },
    getSeatVersion: () => 1,
    resolveSeatBySymbol: () => null,
    updateSeatState: () => ({
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatReadyAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    }),
    bumpSeatVersion: () => 1,
  };
}

function createMonitorContext(
  config: ReturnType<typeof createMonitorConfigDouble>,
): MonitorContext {
  return {
    config,
    monitorSymbolName: config.monitorSymbol,
  } as unknown as MonitorContext;
}

describe('multi-monitor-concurrency integration', () => {
  it('continues processing other monitors when one monitor fails and still schedules global workers', async () => {
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
        tradingOrderType: 'ELO',
        liquidationOrderType: 'MO',
        buyOrderTimeout: { enabled: true, timeoutSeconds: 180 },
        sellOrderTimeout: { enabled: true, timeoutSeconds: 180 },
      },
    };

    const symbolRegistry = createSymbolRegistry(tradingConfig.monitors);

    let orderMonitorScheduleCalls = 0;
    let postTradeEnqueueCalls = 0;

    await mainProgram({
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
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => [],
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
        resetRuntimeSubscriptionsAndCaches: async () => {},
      },
      trader: {
        orderRecorder: {} as never,
        getAccountSnapshot: async () => null,
        getStockPositions: async () => [],
        getPendingOrders: async () => [],
        seedOrderHoldSymbols: () => {},
        getOrderHoldSymbols: () => new Set<string>(),
        cancelOrder: async () => true,
        monitorAndManageOrders: async () => {},
        getAndClearPendingRefreshSymbols: () => [],
        initializeOrderMonitor: async () => {},
        canTradeNow: () => ({ canTrade: true }),
        recordBuyAttempt: () => {},
        fetchAllOrdersFromAPI: async () => [],
        resetRuntimeState: () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        executeSignals: async () => ({ submittedCount: 0, submittedOrderIds: [] }),
      },
      lastState: createLastState(),
      marketMonitor: {
        monitorPriceChanges: () => false,
        monitorIndicatorChanges: () => false,
      },
      doomsdayProtection: {
        shouldRejectBuy: () => false,
        executeClearance: async () => ({ executed: false, signalCount: 0 }),
        cancelPendingBuyOrders: async () => ({ executed: false, cancelledCount: 0 }),
      },
      signalProcessor: {
        processSellSignals: (params) => params.signals,
        applyRiskChecks: async (signals) => signals,
        resetRiskCheckCooldown: () => {},
      },
      tradingConfig,
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      monitorContexts: new Map([
        [configA.monitorSymbol, createMonitorContext(configA)],
        [configB.monitorSymbol, createMonitorContext(configB)],
      ]),
      symbolRegistry,
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
      runtimeGateMode: 'skip',
      dayLifecycleManager: {
        tick: async () => {},
      },
    });

    expect(processCalls).toContain('HSI-A.HK');
    expect(processCalls).toContain('HSI-B.HK');
    expect(orderMonitorScheduleCalls).toBe(1);
    expect(postTradeEnqueueCalls).toBe(1);
  });
});
