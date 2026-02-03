import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiquidationCooldownTracker } from '../src/services/liquidationCooldown/index.js';
import { createSignalProcessor } from '../src/core/signalProcessor/index.js';
import {
  createLastState,
  createMonitorConfig,
  createSignal,
  createTradingConfig,
} from './utils.js';
import type { LiquidationCooldownConfig } from '../src/types/index.js';
import type { LiquidationCooldownTracker } from '../src/services/liquidationCooldown/types.js';
import type {
  OrderRecorder,
  RiskCheckContext,
  Trader,
  RiskChecker,
  Quote,
} from '../src/types/index.js';

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

const createTracker = (nowRef: { current: number }): LiquidationCooldownTracker => {
  return createLiquidationCooldownTracker({
    nowMs: () => nowRef.current,
  });
};

test('liquidationCooldown minutes mode returns remaining ms', () => {
  const nowRef = { current: 0 };
  const tracker = createTracker(nowRef);
  const config: LiquidationCooldownConfig = { mode: 'minutes', minutes: 30 };

  const executedTime = 1_000_000;
  tracker.recordCooldown({
    symbol: 'HSI.HK',
    direction: 'LONG',
    executedTimeMs: executedTime,
  });

  nowRef.current = executedTime + 10 * 60_000;
  const remaining = tracker.getRemainingMs({
    symbol: 'HSI.HK',
    direction: 'LONG',
    cooldownConfig: config,
  });

  assert.equal(remaining, 20 * 60_000);
});

test('liquidationCooldown one-day mode ends at next day 00:00 HKT', () => {
  const nowRef = { current: 0 };
  const tracker = createTracker(nowRef);
  const config: LiquidationCooldownConfig = { mode: 'one-day' };

  const executedTime = createDateFromHk(2025, 1, 2, 22, 0, 0).getTime();
  tracker.recordCooldown({
    symbol: 'HSI.HK',
    direction: 'LONG',
    executedTimeMs: executedTime,
  });

  nowRef.current = createDateFromHk(2025, 1, 2, 23, 0, 0).getTime();
  const remaining = tracker.getRemainingMs({
    symbol: 'HSI.HK',
    direction: 'LONG',
    cooldownConfig: config,
  });

  assert.equal(remaining, 60 * 60_000);
});

test('liquidationCooldown half-day mode uses 13:00 or next day 00:00', () => {
  const nowRef = { current: 0 };
  const tracker = createTracker(nowRef);
  const config: LiquidationCooldownConfig = { mode: 'half-day' };

  const morningTime = createDateFromHk(2025, 1, 2, 11, 0, 0).getTime();
  tracker.recordCooldown({
    symbol: 'HSI.HK',
    direction: 'LONG',
    executedTimeMs: morningTime,
  });

  nowRef.current = createDateFromHk(2025, 1, 2, 12, 0, 0).getTime();
  const remainingMorning = tracker.getRemainingMs({
    symbol: 'HSI.HK',
    direction: 'LONG',
    cooldownConfig: config,
  });

  assert.equal(remainingMorning, 60 * 60_000);

  const afternoonTime = createDateFromHk(2025, 1, 2, 14, 0, 0).getTime();
  tracker.recordCooldown({
    symbol: 'HSI.HK',
    direction: 'SHORT',
    executedTimeMs: afternoonTime,
  });

  nowRef.current = createDateFromHk(2025, 1, 2, 15, 0, 0).getTime();
  const remainingAfternoon = tracker.getRemainingMs({
    symbol: 'HSI.HK',
    direction: 'SHORT',
    cooldownConfig: config,
  });

  assert.equal(remainingAfternoon, 9 * 60 * 60_000);
});

test('liquidationCooldown returns 0 after expiry and clears invalid inputs', () => {
  const nowRef = { current: 0 };
  const tracker = createTracker(nowRef);
  const config: LiquidationCooldownConfig = { mode: 'minutes', minutes: 10 };

  tracker.recordCooldown({
    symbol: 'HSI.HK',
    direction: 'LONG',
    executedTimeMs: -1,
  });

  nowRef.current = 1_000_000;
  const remainingInvalid = tracker.getRemainingMs({
    symbol: 'HSI.HK',
    direction: 'LONG',
    cooldownConfig: config,
  });
  assert.equal(remainingInvalid, 0);

  const executedTime = 2_000_000;
  tracker.recordCooldown({
    symbol: 'HSI.HK',
    direction: 'LONG',
    executedTimeMs: executedTime,
  });

  nowRef.current = executedTime + 11 * 60_000;
  const remainingExpired = tracker.getRemainingMs({
    symbol: 'HSI.HK',
    direction: 'LONG',
    cooldownConfig: config,
  });

  assert.equal(remainingExpired, 0);
});

test('signalProcessor blocks buy signals during liquidation cooldown', async () => {
  const monitorConfig = createMonitorConfig({
    liquidationCooldown: { mode: 'minutes', minutes: 30 },
  });
  const tradingConfig = createTradingConfig({ monitors: [monitorConfig] });
  const longQuote: Quote = {
    symbol: monitorConfig.longSymbol,
    name: 'LongSymbol',
    price: 1.23,
    prevClose: 1.2,
    timestamp: Date.now(),
    lotSize: 100,
  };

  const nowRef = { current: Date.now() };
  const tracker = createTracker(nowRef);
  tracker.recordCooldown({
    symbol: monitorConfig.monitorSymbol,
    direction: 'LONG',
    executedTimeMs: nowRef.current - 60_000,
  });

  const processor = createSignalProcessor({
    tradingConfig,
    liquidationCooldownTracker: tracker,
  });

  const trader = {
    getAccountSnapshot: async () => ({
      currency: 'HKD',
      totalCash: 100,
      netAssets: 100,
      positionValue: 0,
      cashInfos: [],
      buyPower: 100,
    }),
    getStockPositions: async () => [],
    _canTradeNow: () => ({ canTrade: true, waitSeconds: 0 }),
    _markBuyAttempt: () => undefined,
  } as unknown as Trader;

  const riskChecker = {
    checkWarrantRisk: () => ({ allowed: true, reason: null, warrantInfo: null }),
    checkBeforeOrder: () => ({ allowed: true, reason: null }),
  } as unknown as RiskChecker;

  const signal = createSignal({
    action: 'BUYCALL',
    symbol: monitorConfig.longSymbol,
    symbolName: 'LongSymbol',
  });

  const context: RiskCheckContext = {
    trader,
    riskChecker,
    orderRecorder: {
      getLatestBuyOrderPrice: () => null,
    } as unknown as OrderRecorder,
    longQuote,
    shortQuote: null,
    monitorQuote: null,
    monitorSnapshot: null,
    longSymbol: monitorConfig.longSymbol,
    shortSymbol: monitorConfig.shortSymbol,
    longSymbolName: 'LongSymbol',
    shortSymbolName: 'ShortSymbol',
    account: null,
    positions: [],
    lastState: createLastState(),
    config: monitorConfig,
    currentTime: new Date(nowRef.current),
    isHalfDay: false,
    doomsdayProtection: { shouldRejectBuy: () => false } as unknown as RiskCheckContext['doomsdayProtection'],
  };

  const result = await processor.applyRiskChecks([signal], context);

  assert.equal(result.length, 0);
  assert.ok(signal.reason);
});
