import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderSide, OrderStatus, OrderType } from 'longport';
import { createDoomsdayProtection } from '../src/core/doomsdayProtection/index.js';
import { createSymbolRegistry } from '../src/services/autoSymbolManager/utils.js';
import {
  createLastState,
  createMonitorConfig,
  createMonitorContextForTest,
  createQuote,
} from './utils.js';
import type {
  MonitorContext,
  OrderRecorder,
  PendingOrder,
  Position,
  Quote,
  Trader,
} from '../src/types/index.js';
import type { MarketDataClient } from '../src/types/index.js';

const createDateFromHk = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number = 0,
): Date => {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
};

const createPosition = (symbol: string, quantity: number): Position => ({
  symbol,
  costPrice: 1,
  quantity,
  availableQuantity: quantity,
  accountChannel: 'cash',
  symbolName: symbol,
  currency: 'HKD',
  market: 'HK',
});

test('doomsdayProtection shouldRejectBuy matches close window', () => {
  const protection = createDoomsdayProtection();
  const normalCases = [
    { date: createDateFromHk(2025, 1, 2, 15, 44, 59), halfDay: false, expected: false },
    { date: createDateFromHk(2025, 1, 2, 15, 45, 0), halfDay: false, expected: true },
    { date: createDateFromHk(2025, 1, 2, 15, 59, 59), halfDay: false, expected: true },
    { date: createDateFromHk(2025, 1, 2, 16, 0, 0), halfDay: false, expected: false },
  ];

  for (const item of normalCases) {
    assert.equal(protection.shouldRejectBuy(item.date, item.halfDay), item.expected);
  }

  const halfDayCases = [
    { date: createDateFromHk(2025, 1, 2, 11, 44, 59), halfDay: true, expected: false },
    { date: createDateFromHk(2025, 1, 2, 11, 45, 0), halfDay: true, expected: true },
    { date: createDateFromHk(2025, 1, 2, 11, 59, 59), halfDay: true, expected: true },
    { date: createDateFromHk(2025, 1, 2, 12, 0, 0), halfDay: true, expected: false },
  ];

  for (const item of halfDayCases) {
    assert.equal(protection.shouldRejectBuy(item.date, item.halfDay), item.expected);
  }
});

test('doomsdayProtection cancelPendingBuyOrders is idempotent and cancels buys only', async () => {
  const protection = createDoomsdayProtection();
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);
  const { context: monitorContext } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
  });

  const monitorContexts = new Map<string, MonitorContext>([
    [monitorConfig.monitorSymbol, monitorContext],
  ]);

  const pendingOrders: PendingOrder[] = [
    {
      orderId: 'buy-1',
      symbol: monitorConfig.longSymbol,
      side: OrderSide.Buy,
      submittedPrice: 1.01,
      quantity: 100,
      executedQuantity: 0,
      status: OrderStatus.New,
      orderType: OrderType.LO,
    },
    {
      orderId: 'sell-1',
      symbol: monitorConfig.shortSymbol,
      side: OrderSide.Sell,
      submittedPrice: 1.02,
      quantity: 200,
      executedQuantity: 0,
      status: OrderStatus.New,
      orderType: OrderType.LO,
    },
  ];

  let getPendingCount = 0;
  const cancelled: string[] = [];

  const trader = {
    getPendingOrders: async () => {
      getPendingCount += 1;
      return pendingOrders;
    },
    cancelOrder: async (orderId: string) => {
      cancelled.push(orderId);
      return true;
    },
  } as unknown as Trader;

  const inWindowTime = createDateFromHk(2025, 1, 2, 15, 46, 0);

  const first = await protection.cancelPendingBuyOrders({
    currentTime: inWindowTime,
    isHalfDay: false,
    monitorConfigs: [monitorConfig],
    monitorContexts,
    trader,
  });

  assert.equal(first.executed, true);
  assert.equal(first.cancelledCount, 1);
  assert.deepEqual(cancelled, ['buy-1']);
  assert.equal(getPendingCount, 1);

  const second = await protection.cancelPendingBuyOrders({
    currentTime: inWindowTime,
    isHalfDay: false,
    monitorConfigs: [monitorConfig],
    monitorContexts,
    trader,
  });

  assert.equal(second.executed, false);
  assert.equal(second.cancelledCount, 0);
  assert.equal(getPendingCount, 1);
});

test('doomsdayProtection cancelPendingBuyOrders skips outside window', async () => {
  const protection = createDoomsdayProtection();
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);
  const { context: monitorContext } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
  });

  const monitorContexts = new Map<string, MonitorContext>([
    [monitorConfig.monitorSymbol, monitorContext],
  ]);

  let getPendingCount = 0;

  const trader = {
    getPendingOrders: async () => {
      getPendingCount += 1;
      return [];
    },
    cancelOrder: async () => true,
  } as unknown as Trader;

  const timeOutside = createDateFromHk(2025, 1, 2, 15, 30, 0);

  const result = await protection.cancelPendingBuyOrders({
    currentTime: timeOutside,
    isHalfDay: false,
    monitorConfigs: [monitorConfig],
    monitorContexts,
    trader,
  });

  assert.equal(result.executed, false);
  assert.equal(result.cancelledCount, 0);
  assert.equal(getPendingCount, 0);
});

test('doomsdayProtection executeClearance generates unique signals and clears caches', async () => {
  const protection = createDoomsdayProtection();
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);

  let clearCalls: Array<{ symbol: string; isLong: boolean }> = [];
  const orderRecorder = {
    clearBuyOrders: (symbol: string, isLong: boolean) => {
      clearCalls.push({ symbol, isLong });
    },
  };

  const { context: monitorContext } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
    orderRecorder: orderRecorder as unknown as OrderRecorder,
  });

  const monitorContexts = new Map<string, MonitorContext>([
    [monitorConfig.monitorSymbol, monitorContext],
  ]);

  const positions: Position[] = [
    createPosition(monitorConfig.longSymbol, 100),
    createPosition(monitorConfig.longSymbol, 50),
    createPosition(monitorConfig.shortSymbol, 200),
  ];

  const lastState = createLastState({ positions });

  const quotes: Quote[] = [
    createQuote({ symbol: monitorConfig.longSymbol, price: 1.11 }),
    createQuote({ symbol: monitorConfig.shortSymbol, price: 1.22 }),
  ];
  const quoteMap = new Map<string, Quote | null>();
  for (const quote of quotes) {
    quoteMap.set(quote.symbol, quote);
  }

  const marketDataClient = {
    getQuotes: async () => quoteMap,
  } as unknown as MarketDataClient;

  let executedSignals: Array<{ symbol: string; action: string }> = [];
  const trader = {
    executeSignals: async (signals: Array<{ symbol: string; action: string }>) => {
      executedSignals = signals.map((sig) => ({ symbol: sig.symbol, action: sig.action }));
    },
  } as unknown as Trader;

  const result = await protection.executeClearance({
    currentTime: createDateFromHk(2025, 1, 2, 15, 56, 0),
    isHalfDay: false,
    positions,
    monitorConfigs: [monitorConfig],
    monitorContexts,
    trader,
    marketDataClient,
    lastState,
  });

  assert.equal(result.executed, true);
  assert.equal(result.signalCount, 2);
  assert.deepEqual(executedSignals, [
    { symbol: monitorConfig.longSymbol, action: 'SELLCALL' },
    { symbol: monitorConfig.shortSymbol, action: 'SELLPUT' },
  ]);
  assert.equal(lastState.cachedAccount, null);
  assert.equal(lastState.cachedPositions.length, 0);
  assert.equal(lastState.positionCache.get(monitorConfig.longSymbol), null);
  assert.equal(lastState.positionCache.get(monitorConfig.shortSymbol), null);

  assert.deepEqual(clearCalls, [
    { symbol: monitorConfig.longSymbol, isLong: true },
    { symbol: monitorConfig.shortSymbol, isLong: false },
  ]);
});

test('doomsdayProtection executeClearance skips when seat not ready', async () => {
  const protection = createDoomsdayProtection();
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
  const { context: monitorContext } = createMonitorContextForTest({
    monitorConfig,
    symbolRegistry,
  });

  const monitorContexts = new Map<string, MonitorContext>([
    [monitorConfig.monitorSymbol, monitorContext],
  ]);

  const positions: Position[] = [
    createPosition(monitorConfig.longSymbol, 100),
  ];

  const lastState = createLastState({ positions });

  const marketDataClient = {
    getQuotes: async () => new Map<string, Quote | null>(),
  } as unknown as MarketDataClient;

  let executedCount = 0;
  const trader = {
    executeSignals: async () => {
      executedCount += 1;
    },
  } as unknown as Trader;

  const result = await protection.executeClearance({
    currentTime: createDateFromHk(2025, 1, 2, 15, 56, 0),
    isHalfDay: false,
    positions,
    monitorConfigs: [monitorConfig],
    monitorContexts,
    trader,
    marketDataClient,
    lastState,
  });

  assert.equal(result.executed, false);
  assert.equal(result.signalCount, 0);
  assert.equal(executedCount, 0);
});
