import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainProgram } from '../src/main/mainProgram/index.js';
import { createIndicatorCache } from '../src/main/asyncProgram/indicatorCache/index.js';
import { createBuyTaskQueue, createSellTaskQueue } from '../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createSymbolRegistry } from '../src/services/autoSymbolManager/utils.js';
import { createTradingConfig, createLastState, withMockedDate } from './utils.js';
import type {
  MarketDataClient,
  Trader,
} from '../src/types/index.js';
import type { DoomsdayProtection } from '../src/core/doomsdayProtection/types.js';
import type { SignalProcessor } from '../src/core/signalProcessor/types.js';
import type { DailyLossTracker } from '../src/core/risk/types.js';
import type { MarketMonitor } from '../src/services/marketMonitor/types.js';
import type { OrderMonitorWorker } from '../src/main/asyncProgram/orderMonitorWorker/types.js';
import type { PostTradeRefresher } from '../src/main/asyncProgram/postTradeRefresher/types.js';
import type { MonitorTaskData, MonitorTaskType } from '../src/main/asyncProgram/monitorTaskProcessor/types.js';

const createMarketDataClientStub = (overrides: Partial<MarketDataClient> = {}): MarketDataClient => ({
  _getContext: async () => ({} as unknown as import('longport').QuoteContext),
  getQuotes: async () => new Map(),
  subscribeSymbols: async () => undefined,
  unsubscribeSymbols: async () => undefined,
  getCandlesticks: async () => [],
  getTradingDays: async () => ({ tradingDays: [], halfTradingDays: [] }),
  isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
  cacheStaticInfo: async () => undefined,
  ...overrides,
});

test('mainProgram returns early on non-trading day in strict mode', async () => {
  let getQuotesCalled = 0;
  let doomsdayCalled = 0;

  const baseConfig = createTradingConfig({ monitors: [] });
  const tradingConfig = {
    ...baseConfig,
    global: { ...baseConfig.global, doomsdayProtection: true },
  };
  const symbolRegistry = createSymbolRegistry(tradingConfig.monitors);
  const lastState = createLastState({
    tradingDayInfo: null,
    monitorStates: new Map(),
  });

  const marketDataClient = createMarketDataClientStub({
    isTradingDay: async () => ({ isTradingDay: false, isHalfDay: false }),
    getQuotes: async () => {
      getQuotesCalled += 1;
      return new Map();
    },
  });

  const doomsdayProtection = {
    cancelPendingBuyOrders: async () => {
      doomsdayCalled += 1;
      return { executed: false, cancelledCount: 0 };
    },
    executeClearance: async () => {
      doomsdayCalled += 1;
      return { executed: false };
    },
  } as unknown as DoomsdayProtection;

  await mainProgram({
    marketDataClient,
    trader: { getOrderHoldSymbols: () => new Set(), getAndClearPendingRefreshSymbols: () => [] } as unknown as Trader,
    lastState,
    marketMonitor: { monitorPriceChanges: () => false, monitorIndicatorChanges: () => false } as unknown as MarketMonitor,
    doomsdayProtection,
    signalProcessor: {} as SignalProcessor,
    tradingConfig,
    dailyLossTracker: {
      initializeFromOrders: () => undefined,
      recalculateFromAllOrders: () => undefined,
      recordFilledOrder: () => undefined,
      getLossOffset: () => 0,
      resetIfNewDay: () => undefined,
    } as unknown as DailyLossTracker,
    monitorContexts: new Map(),
    symbolRegistry,
    indicatorCache: createIndicatorCache(),
    buyTaskQueue: createBuyTaskQueue(),
    sellTaskQueue: createSellTaskQueue(),
    monitorTaskQueue: createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>(),
    orderMonitorWorker: { schedule: () => undefined, stop: () => undefined } as OrderMonitorWorker,
    postTradeRefresher: { enqueue: () => undefined, stop: () => undefined } as PostTradeRefresher,
    runtimeGateMode: 'strict',
  });

  assert.equal(lastState.canTrade, false);
  assert.equal(getQuotesCalled, 0);
  assert.equal(doomsdayCalled, 0);
});

test('mainProgram skips downstream steps after doomsday clearance', async () => {
  let getQuotesCalled = 0;
  let scheduled = 0;
  let refreshed = 0;

  const baseConfig = createTradingConfig({ monitors: [] });
  const tradingConfig = {
    ...baseConfig,
    global: { ...baseConfig.global, doomsdayProtection: true },
  };
  const symbolRegistry = createSymbolRegistry(tradingConfig.monitors);
  const lastState = createLastState({
    tradingDayInfo: { isTradingDay: true, isHalfDay: false },
    monitorStates: new Map(),
  });

  const marketDataClient = createMarketDataClientStub({
    getQuotes: async () => {
      getQuotesCalled += 1;
      return new Map();
    },
  });

  const doomsdayProtection = {
    cancelPendingBuyOrders: async () => ({ executed: false, cancelledCount: 0 }),
    executeClearance: async () => ({ executed: true }),
  } as unknown as DoomsdayProtection;

  await mainProgram({
    marketDataClient,
    trader: { getOrderHoldSymbols: () => new Set(), getAndClearPendingRefreshSymbols: () => [] } as unknown as Trader,
    lastState,
    marketMonitor: { monitorPriceChanges: () => false, monitorIndicatorChanges: () => false } as unknown as MarketMonitor,
    doomsdayProtection,
    signalProcessor: {} as SignalProcessor,
    tradingConfig,
    dailyLossTracker: {
      initializeFromOrders: () => undefined,
      recalculateFromAllOrders: () => undefined,
      recordFilledOrder: () => undefined,
      getLossOffset: () => 0,
      resetIfNewDay: () => undefined,
    } as unknown as DailyLossTracker,
    monitorContexts: new Map(),
    symbolRegistry,
    indicatorCache: createIndicatorCache(),
    buyTaskQueue: createBuyTaskQueue(),
    sellTaskQueue: createSellTaskQueue(),
    monitorTaskQueue: createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>(),
    orderMonitorWorker: { schedule: () => { scheduled += 1; }, stop: () => undefined } as OrderMonitorWorker,
    postTradeRefresher: { enqueue: () => { refreshed += 1; }, stop: () => undefined } as PostTradeRefresher,
    runtimeGateMode: 'skip',
  });

  assert.equal(getQuotesCalled, 0);
  assert.equal(scheduled, 0);
  assert.equal(refreshed, 0);
});

test('mainProgram updates openProtectionActive during open protection', async () => {
  const baseConfig = createTradingConfig({ monitors: [] });
  const tradingConfig = {
    ...baseConfig,
    global: { ...baseConfig.global, openProtection: { enabled: true, minutes: 5 } },
  };
  const symbolRegistry = createSymbolRegistry(tradingConfig.monitors);
  const lastState = createLastState({
    tradingDayInfo: { isTradingDay: true, isHalfDay: false },
    monitorStates: new Map(),
    currentDayKey: '2025-01-02',
  });

  const marketDataClient = createMarketDataClientStub({
    getQuotes: async () => new Map(),
  });

  const doomsdayProtection = {
    cancelPendingBuyOrders: async () => ({ executed: false, cancelledCount: 0 }),
    executeClearance: async () => ({ executed: false }),
  } as unknown as DoomsdayProtection;

  const utcTime = Date.UTC(2025, 0, 2, 1, 32, 0);
  await withMockedDate(utcTime, async () => {
    await mainProgram({
      marketDataClient,
      trader: { getOrderHoldSymbols: () => new Set(), getAndClearPendingRefreshSymbols: () => [] } as unknown as Trader,
      lastState,
      marketMonitor: { monitorPriceChanges: () => false, monitorIndicatorChanges: () => false } as unknown as MarketMonitor,
      doomsdayProtection,
      signalProcessor: {} as SignalProcessor,
      tradingConfig,
      dailyLossTracker: {
        initializeFromOrders: () => undefined,
        recalculateFromAllOrders: () => undefined,
        recordFilledOrder: () => undefined,
        getLossOffset: () => 0,
        resetIfNewDay: () => undefined,
      } as unknown as DailyLossTracker,
      monitorContexts: new Map(),
      symbolRegistry,
      indicatorCache: createIndicatorCache(),
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      monitorTaskQueue: createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>(),
      orderMonitorWorker: { schedule: () => undefined, stop: () => undefined } as OrderMonitorWorker,
      postTradeRefresher: { enqueue: () => undefined, stop: () => undefined } as PostTradeRefresher,
      runtimeGateMode: 'strict',
    });
  });

  assert.equal(lastState.openProtectionActive, true);
});
