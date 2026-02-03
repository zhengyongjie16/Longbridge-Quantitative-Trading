import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuyTaskQueue, createSellTaskQueue } from '../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createBuyProcessor } from '../src/main/asyncProgram/buyProcessor/index.js';
import { createSellProcessor } from '../src/main/asyncProgram/sellProcessor/index.js';
import { createOrderMonitorWorker } from '../src/main/asyncProgram/orderMonitorWorker/index.js';
import { createPostTradeRefresher } from '../src/main/asyncProgram/postTradeRefresher/index.js';
import { createMonitorTaskQueue } from '../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskProcessor } from '../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { createSymbolRegistry } from '../src/services/autoSymbolManager/utils.js';
import {
  createMonitorConfig,
  createMonitorContextForTest,
  createSignal,
  createLastState,
  createTradingConfig,
  createQuote,
  createQuotesMap,
} from './utils.js';
import type { BuyTask, SellTask } from '../src/main/asyncProgram/tradeTaskQueue/types.js';
import type { Quote, RiskChecker, Trader } from '../src/types/index.js';
import type { OrderRecorder } from '../src/types/index.js';
import type { AutoSymbolManager } from '../src/services/autoSymbolManager/types.js';
import type { DoomsdayProtection } from '../src/core/doomsdayProtection/types.js';
import type { SignalProcessor } from '../src/core/signalProcessor/types.js';
import type { RefreshGate } from '../src/utils/refreshGate/types.js';
import type { MonitorTaskType, MonitorTaskData } from '../src/main/asyncProgram/monitorTaskProcessor/types.js';

test('BuyProcessor skips execution when risk check rejects', async () => {
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);
  const { context: monitorContext } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
  });

  const taskQueue = createBuyTaskQueue();
  const signal = createSignal({
    symbol: monitorConfig.longSymbol,
    action: 'BUYCALL',
    seatVersion: 1,
  });
  const task: BuyTask = {
    id: 'task-1',
    type: 'IMMEDIATE_BUY',
    data: signal,
    monitorSymbol: monitorConfig.monitorSymbol,
    createdAt: Date.now(),
  };

  taskQueue.push(task);

  let executed = 0;
  const processor = createBuyProcessor({
    taskQueue,
    getMonitorContext: () => monitorContext,
    signalProcessor: {
      applyRiskChecks: async () => [],
    } as unknown as SignalProcessor,
    trader: {
      executeSignals: async () => {
        executed += 1;
      },
    } as unknown as Trader,
    doomsdayProtection: {} as DoomsdayProtection,
    getLastState: () => createLastState(),
    getIsHalfDay: () => false,
  });

  await processor.processNow();

  const stats = processor.getStats();
  assert.equal(stats.processedCount, 1);
  assert.equal(stats.successCount, 1);
  assert.equal(stats.failedCount, 0);
  assert.equal(executed, 0);
});

test('BuyProcessor executes when risk check passes', async () => {
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);
  const { context: monitorContext } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
  });

  const taskQueue = createBuyTaskQueue();
  const signal = createSignal({
    symbol: monitorConfig.longSymbol,
    action: 'BUYCALL',
    seatVersion: 1,
  });
  const task: BuyTask = {
    id: 'task-2',
    type: 'VERIFIED_BUY',
    data: signal,
    monitorSymbol: monitorConfig.monitorSymbol,
    createdAt: Date.now(),
  };

  taskQueue.push(task);

  let executed = 0;
  const processor = createBuyProcessor({
    taskQueue,
    getMonitorContext: () => monitorContext,
    signalProcessor: {
      applyRiskChecks: async () => [signal],
    } as unknown as SignalProcessor,
    trader: {
      executeSignals: async () => {
        executed += 1;
      },
    } as unknown as Trader,
    doomsdayProtection: {} as DoomsdayProtection,
    getLastState: () => createLastState(),
    getIsHalfDay: () => false,
  });

  await processor.processNow();

  const stats = processor.getStats();
  assert.equal(stats.processedCount, 1);
  assert.equal(stats.successCount, 1);
  assert.equal(stats.failedCount, 0);
  assert.equal(executed, 1);
});

test('SellProcessor skips execution for HOLD', async () => {
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);
  const { context: monitorContext } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
  });

  const taskQueue = createSellTaskQueue();
  const signal = createSignal({
    symbol: monitorConfig.longSymbol,
    action: 'SELLCALL',
    seatVersion: 1,
  });
  const task: SellTask = {
    id: 'task-3',
    type: 'IMMEDIATE_SELL',
    data: signal,
    monitorSymbol: monitorConfig.monitorSymbol,
    createdAt: Date.now(),
  };
  taskQueue.push(task);

  let executed = 0;
  const refreshGate: RefreshGate = {
    markStale: () => 1,
    markFresh: () => undefined,
    waitForFresh: async () => undefined,
    getStatus: () => ({ currentVersion: 1, staleVersion: 1 }),
  };

  const processor = createSellProcessor({
    taskQueue,
    getMonitorContext: () => monitorContext,
    signalProcessor: {
      processSellSignals: () => [{ ...signal, action: 'HOLD' }],
    } as unknown as SignalProcessor,
    trader: {
      executeSignals: async () => {
        executed += 1;
      },
    } as unknown as Trader,
    getLastState: () => createLastState(),
    refreshGate,
  });

  await processor.processNow();

  const stats = processor.getStats();
  assert.equal(stats.processedCount, 1);
  assert.equal(stats.successCount, 1);
  assert.equal(stats.failedCount, 0);
  assert.equal(executed, 0);
});

test('SellProcessor executes for normal sell', async () => {
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);
  const { context: monitorContext } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
  });

  const taskQueue = createSellTaskQueue();
  const signal = createSignal({
    symbol: monitorConfig.longSymbol,
    action: 'SELLCALL',
    seatVersion: 1,
  });
  const task: SellTask = {
    id: 'task-4',
    type: 'VERIFIED_SELL',
    data: signal,
    monitorSymbol: monitorConfig.monitorSymbol,
    createdAt: Date.now(),
  };
  taskQueue.push(task);

  let executed = 0;
  const refreshGate: RefreshGate = {
    markStale: () => 1,
    markFresh: () => undefined,
    waitForFresh: async () => undefined,
    getStatus: () => ({ currentVersion: 1, staleVersion: 1 }),
  };

  const processor = createSellProcessor({
    taskQueue,
    getMonitorContext: () => monitorContext,
    signalProcessor: {
      processSellSignals: () => [signal],
    } as unknown as SignalProcessor,
    trader: {
      executeSignals: async () => {
        executed += 1;
      },
    } as unknown as Trader,
    getLastState: () => createLastState(),
    refreshGate,
  });

  await processor.processNow();

  const stats = processor.getStats();
  assert.equal(stats.processedCount, 1);
  assert.equal(stats.successCount, 1);
  assert.equal(stats.failedCount, 0);
  assert.equal(executed, 1);
});

test('OrderMonitorWorker keeps latest quotes', async () => {
  let calls: ReadonlyMap<string, Quote | null>[] = [];
  let resolveFirst: (() => void) | null = null;

  const worker = createOrderMonitorWorker({
    monitorAndManageOrders: async (quotesMap) => {
      calls = calls.concat(quotesMap);
      if (!resolveFirst) {
        await new Promise<void>((resolve) => {
          resolveFirst = () => resolve();
        });
      }
    },
  });

  const firstQuotes = new Map<string, Quote | null>([
    ['AAA.HK', createQuote({ symbol: 'AAA.HK' })],
  ]);
  const secondQuotes = new Map<string, Quote | null>([
    ['BBB.HK', createQuote({ symbol: 'BBB.HK' })],
  ]);

  worker.schedule(firstQuotes);
  worker.schedule(secondQuotes);

  await new Promise((resolve) => setImmediate(resolve));
  (resolveFirst as unknown as (() => void))();

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2);
  assert.equal(calls[0], firstQuotes);
  assert.equal(calls[1], secondQuotes);
});

test('PostTradeRefresher marks fresh after refresh', async () => {
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);
  let refreshUnrealizedCalls = 0;

  const { context: monitorContext } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
    riskChecker: {
      clearWarrantInfo: () => undefined,
      getWarrantDistanceInfo: () => null,
      refreshUnrealizedLossData: async () => {
        refreshUnrealizedCalls += 1;
        return null;
      },
      checkWarrantDistanceLiquidation: () => ({ shouldLiquidate: false }),
      refreshWarrantInfoForSymbol: async () => ({ status: 'ok' }),
    } as unknown as RiskChecker,
  });

  const lastState = createLastState();
  const refreshMarks: number[] = [];
  const refreshGate: RefreshGate = {
    markStale: () => 1,
    markFresh: (version) => {
      refreshMarks.push(version);
    },
    waitForFresh: async () => undefined,
    getStatus: () => ({ currentVersion: 1, staleVersion: 2 }),
  };

  const trader: Trader = {
    _ctxPromise: Promise.resolve({} as unknown as import('longport').TradeContext),
    _orderRecorder: {} as unknown as OrderRecorder,
    getAccountSnapshot: async () => ({ currency: 'HKD', totalCash: 100, netAssets: 100, positionValue: 0, cashInfos: [], buyPower: 100 }),
    getStockPositions: async () => [],
    getPendingOrders: async () => [],
    seedOrderHoldSymbols: () => undefined,
    getOrderHoldSymbols: () => new Set(),
    clearPendingOrdersCache: () => undefined,
    hasPendingBuyOrders: async () => false,
    trackOrder: () => undefined,
    cancelOrder: async () => true,
    replaceOrderPrice: async () => undefined,
    monitorAndManageOrders: async () => undefined,
    getAndClearPendingRefreshSymbols: () => [],
    _canTradeNow: () => ({ canTrade: true }),
    _markBuyAttempt: () => undefined,
    executeSignals: async () => undefined,
  };

  const refresher = createPostTradeRefresher({
    refreshGate,
    trader,
    lastState,
    monitorContexts: new Map([[monitorConfig.monitorSymbol, monitorContext]]),
    displayAccountAndPositions: async () => undefined,
  });

  const quotesMap = createQuotesMap([
    createQuote({ symbol: monitorConfig.longSymbol }),
  ]);

  refresher.enqueue({
    pending: [{ symbol: monitorConfig.longSymbol, isLongSymbol: true, refreshAccount: true, refreshPositions: true }],
    quotesMap,
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(refreshMarks.length, 1);
  assert.equal(refreshUnrealizedCalls, 1);
});

test('MonitorTaskProcessor AUTO_SYMBOL_TICK triggers search', async () => {
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);
  let searchCalls = 0;

  const { context: monitorContext } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
    autoSymbolManager: {
      ensureSeatOnStartup: () => ({ symbol: monitorConfig.longSymbol, status: 'READY', lastSwitchAt: null, lastSearchAt: null }),
      maybeSearchOnTick: async () => {
        searchCalls += 1;
      },
      maybeSwitchOnDistance: async () => undefined,
      hasPendingSwitch: () => false,
      clearSeat: () => 1,
      resetDailySwitchSuppression: () => undefined,
    } as unknown as AutoSymbolManager,
  });

  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
  const refreshGate: RefreshGate = {
    markStale: () => 1,
    markFresh: () => undefined,
    waitForFresh: async () => undefined,
    getStatus: () => ({ currentVersion: 1, staleVersion: 1 }),
  };

  const processor = createMonitorTaskProcessor({
    monitorTaskQueue,
    refreshGate,
    getMonitorContext: () => monitorContext,
    clearQueuesForDirection: () => undefined,
    marketDataClient: {
      _getContext: async () => ({} as unknown as import('longport').QuoteContext),
      getQuotes: async () => new Map(),
      subscribeSymbols: async () => undefined,
      unsubscribeSymbols: async () => undefined,
      getCandlesticks: async () => [],
      getTradingDays: async () => ({ tradingDays: [], halfTradingDays: [] }),
      isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
      cacheStaticInfo: async () => undefined,
    },
    trader: { getAccountSnapshot: async () => null, getStockPositions: async () => [] } as unknown as Trader,
    lastState: createLastState(),
    tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
  });

  processor.start();

  monitorTaskQueue.scheduleLatest({
    type: 'AUTO_SYMBOL_TICK',
    dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG',
    monitorSymbol: monitorConfig.monitorSymbol,
    data: {
      monitorSymbol: monitorConfig.monitorSymbol,
      direction: 'LONG',
      seatVersion: 1,
      symbol: monitorConfig.longSymbol,
      currentTimeMs: Date.now(),
      canTradeNow: true,
    },
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(searchCalls, 1);
  processor.stop();
});
