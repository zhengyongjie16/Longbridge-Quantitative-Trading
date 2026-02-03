import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processMonitor } from '../src/main/processMonitor/index.js';
import { createIndicatorCache } from '../src/main/asyncProgram/indicatorCache/index.js';
import { createBuyTaskQueue, createSellTaskQueue } from '../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../src/main/asyncProgram/monitorTaskQueue/index.js';
import {
  createMonitorContextForTest,
  createMonitorConfig,
  createSignal,
  createLastState,
  createTradingConfig,
} from './utils.js';
import { createSymbolRegistry } from '../src/services/autoSymbolManager/utils.js';
import type { CandleData, Quote } from '../src/types/index.js';
import type { MarketDataClient, Trader } from '../src/types/index.js';
import type { MarketMonitor } from '../src/services/marketMonitor/types.js';
import type { DoomsdayProtection } from '../src/core/doomsdayProtection/types.js';
import type { SignalProcessor } from '../src/core/signalProcessor/types.js';
import type { DailyLossTracker } from '../src/core/risk/types.js';
import type { OrderMonitorWorker } from '../src/main/asyncProgram/orderMonitorWorker/types.js';
import type { PostTradeRefresher } from '../src/main/asyncProgram/postTradeRefresher/types.js';
import type { MonitorTaskData, MonitorTaskType } from '../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTaskQueue } from '../src/main/asyncProgram/monitorTaskQueue/types.js';

const createCandles = (count: number): CandleData[] => {
  const candles: CandleData[] = [];
  for (let i = 0; i < count; i += 1) {
    candles.push({
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 1000 + i,
    });
  }
  return candles;
};

const createMarketDataClientStub = (quotesMap: ReadonlyMap<string, Quote | null>): MarketDataClient => ({
  _getContext: async () => ({} as unknown as import('longport').QuoteContext),
  getQuotes: async () => new Map(quotesMap),
  subscribeSymbols: async () => undefined,
  unsubscribeSymbols: async () => undefined,
  getCandlesticks: async () => createCandles(20) as unknown as import('longport').Candlestick[],
  getTradingDays: async () => ({ tradingDays: [], halfTradingDays: [] }),
  isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
  cacheStaticInfo: async () => undefined,
});

const createMainContext = (overrides: {
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
  readonly marketMonitor: MarketMonitor;
  readonly indicatorCache: ReturnType<typeof createIndicatorCache>;
  readonly buyTaskQueue: ReturnType<typeof createBuyTaskQueue>;
  readonly sellTaskQueue: ReturnType<typeof createSellTaskQueue>;
  readonly monitorTaskQueue: MonitorTaskQueue<MonitorTaskType, MonitorTaskData>;
  readonly symbolRegistry: ReturnType<typeof createSymbolRegistry>;
  readonly lastState: ReturnType<typeof createLastState>;
}): Parameters<typeof processMonitor>[0]['context'] => ({
  marketDataClient: createMarketDataClientStub(overrides.quotesMap),
  trader: { getOrderHoldSymbols: () => new Set(), getAndClearPendingRefreshSymbols: () => [] } as unknown as Trader,
  lastState: overrides.lastState,
  marketMonitor: overrides.marketMonitor,
  doomsdayProtection: {} as DoomsdayProtection,
  signalProcessor: {} as SignalProcessor,
  tradingConfig: createTradingConfig({ monitors: [] }),
  dailyLossTracker: {
    initializeFromOrders: () => undefined,
    recalculateFromAllOrders: () => undefined,
    recordFilledOrder: () => undefined,
    getLossOffset: () => 0,
    resetIfNewDay: () => undefined,
  } as unknown as DailyLossTracker,
  monitorContexts: new Map(),
  symbolRegistry: overrides.symbolRegistry,
  indicatorCache: overrides.indicatorCache,
  buyTaskQueue: overrides.buyTaskQueue,
  sellTaskQueue: overrides.sellTaskQueue,
  monitorTaskQueue: overrides.monitorTaskQueue,
  orderMonitorWorker: { schedule: () => undefined, stop: () => undefined } as OrderMonitorWorker,
  postTradeRefresher: { enqueue: () => undefined, stop: () => undefined } as PostTradeRefresher,
  runtimeGateMode: 'strict',
});

test('processMonitor routes immediate signals and enriches quote info', async () => {
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);

  const buySignal = createSignal({
    symbol: monitorConfig.longSymbol,
    action: 'BUYCALL',
    symbolName: null,
    price: null,
    lotSize: null,
  });
  const sellSignal = createSignal({
    symbol: monitorConfig.shortSymbol,
    action: 'SELLPUT',
    symbolName: null,
    price: null,
    lotSize: null,
  });

  const strategy = {
    generateCloseSignals: () => ({
      immediateSignals: [buySignal, sellSignal],
      delayedSignals: [],
    }),
  };

  const { context: monitorContext, quotesMap } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
    strategy,
  });

  const indicatorCache = createIndicatorCache();
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
  const lastState = createLastState();

  const marketMonitor: MarketMonitor = {
    monitorPriceChanges: () => false,
    monitorIndicatorChanges: () => false,
  };

  await processMonitor(
    {
      context: createMainContext({
        quotesMap,
        marketMonitor,
        indicatorCache,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        symbolRegistry,
        lastState,
      }),
      monitorContext,
      runtimeFlags: {
        currentTime: new Date(),
        isHalfDay: false,
        canTradeNow: true,
        openProtectionActive: false,
      },
    },
    quotesMap,
  );

  assert.equal(buyTaskQueue.size(), 1);
  assert.equal(sellTaskQueue.size(), 1);

  const queuedBuy = buyTaskQueue.peek()?.data;
  const queuedSell = sellTaskQueue.peek()?.data;

  assert.ok(queuedBuy);
  assert.ok(queuedSell);
  assert.equal(queuedBuy.symbolName, 'LongSymbol');
  assert.equal(queuedSell.symbolName, 'ShortSymbol');
  assert.equal(queuedBuy.seatVersion, 1);
  assert.equal(queuedSell.seatVersion, 1);
});

test('processMonitor skips signal generation during open protection', async () => {
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);

  const strategy = {
    generateCloseSignals: () => ({
      immediateSignals: [createSignal({ symbol: monitorConfig.longSymbol })],
      delayedSignals: [createSignal({ symbol: monitorConfig.longSymbol, action: 'SELLCALL' })],
    }),
  };

  let delayedAdded = 0;
  const delayedSignalVerifier = {
    addSignal: () => {
      delayedAdded += 1;
    },
    cancelSignal: () => false,
    cancelAllForSymbol: () => undefined,
    cancelAllForDirection: () => 0,
    getPendingCount: () => delayedAdded,
    onVerified: () => undefined,
    onRejected: () => undefined,
    destroy: () => undefined,
  };

  const { context: monitorContext, quotesMap } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
    strategy,
    delayedSignalVerifier,
  });

  const indicatorCache = createIndicatorCache();
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
  const lastState = createLastState();

  const marketMonitor: MarketMonitor = {
    monitorPriceChanges: () => false,
    monitorIndicatorChanges: () => false,
  };

  await processMonitor(
    {
      context: createMainContext({
        quotesMap,
        marketMonitor,
        indicatorCache,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        symbolRegistry,
        lastState,
      }),
      monitorContext,
      runtimeFlags: {
        currentTime: new Date(),
        isHalfDay: false,
        canTradeNow: true,
        openProtectionActive: true,
      },
    },
    quotesMap,
  );

  assert.equal(buyTaskQueue.size(), 0);
  assert.equal(sellTaskQueue.size(), 0);
  assert.equal(delayedAdded, 0);
});

test('processMonitor skips queueing when not tradable', async () => {
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);

  const strategy = {
    generateCloseSignals: () => ({
      immediateSignals: [createSignal({ symbol: monitorConfig.longSymbol })],
      delayedSignals: [createSignal({ symbol: monitorConfig.longSymbol, action: 'SELLCALL' })],
    }),
  };

  let delayedAdded = 0;
  const delayedSignalVerifier = {
    addSignal: () => {
      delayedAdded += 1;
    },
    cancelSignal: () => false,
    cancelAllForSymbol: () => undefined,
    cancelAllForDirection: () => 0,
    getPendingCount: () => delayedAdded,
    onVerified: () => undefined,
    onRejected: () => undefined,
    destroy: () => undefined,
  };

  const { context: monitorContext, quotesMap } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
    strategy,
    delayedSignalVerifier,
  });

  const indicatorCache = createIndicatorCache();
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
  const lastState = createLastState();

  const marketMonitor: MarketMonitor = {
    monitorPriceChanges: () => false,
    monitorIndicatorChanges: () => false,
  };

  await processMonitor(
    {
      context: createMainContext({
        quotesMap,
        marketMonitor,
        indicatorCache,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        symbolRegistry,
        lastState,
      }),
      monitorContext,
      runtimeFlags: {
        currentTime: new Date(),
        isHalfDay: false,
        canTradeNow: false,
        openProtectionActive: false,
      },
    },
    quotesMap,
  );

  assert.equal(buyTaskQueue.size(), 0);
  assert.equal(sellTaskQueue.size(), 0);
  assert.equal(delayedAdded, 0);
});

test('processMonitor skips signals when seat not ready', async () => {
  const monitorConfig = createMonitorConfig({
    autoSearchConfig: {
      autoSearchEnabled: true,
      autoSearchMinPriceBull: null,
      autoSearchMinPriceBear: null,
      autoSearchMinTurnoverPerMinuteBull: null,
      autoSearchMinTurnoverPerMinuteBear: null,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 5,
      switchDistanceRangeBull: null,
      switchDistanceRangeBear: null,
    },
  });
  const symbolRegistry = createSymbolRegistry([monitorConfig]);

  const strategy = {
    generateCloseSignals: () => ({
      immediateSignals: [createSignal({ symbol: monitorConfig.longSymbol })],
      delayedSignals: [],
    }),
  };

  const { context: monitorContext, quotesMap } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
    strategy,
  });

  const indicatorCache = createIndicatorCache();
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
  const lastState = createLastState();

  const marketMonitor: MarketMonitor = {
    monitorPriceChanges: () => false,
    monitorIndicatorChanges: () => false,
  };

  await processMonitor(
    {
      context: createMainContext({
        quotesMap,
        marketMonitor,
        indicatorCache,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        symbolRegistry,
        lastState,
      }),
      monitorContext,
      runtimeFlags: {
        currentTime: new Date(),
        isHalfDay: false,
        canTradeNow: true,
        openProtectionActive: false,
      },
    },
    quotesMap,
  );

  assert.equal(buyTaskQueue.size(), 0);
  assert.equal(sellTaskQueue.size(), 0);
});
