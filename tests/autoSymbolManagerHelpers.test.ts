import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __test__ as autoSymbolManagerTest } from '../src/services/autoSymbolManager/index.js';
import { getTradingMinutesSinceOpen } from '../src/utils/helpers/tradingTime.js';

import type { QuoteContext } from 'longport';
import type { AutoSearchConfig, MarketDataClient } from '../src/types/index.js';
import type { WarrantListCacheConfig } from '../src/services/autoSymbolFinder/types.js';

test('resolveAutoSearchThresholdInput returns null when thresholds are missing', () => {
  const autoSearchConfig: AutoSearchConfig = {
    autoSearchEnabled: true,
    autoSearchMinPriceBull: null,
    autoSearchMinPriceBear: 1,
    autoSearchMinTurnoverPerMinuteBull: null,
    autoSearchMinTurnoverPerMinuteBear: 1,
    autoSearchExpiryMinMonths: 3,
    autoSearchOpenDelayMinutes: 0,
    switchDistanceRangeBull: { min: 0, max: 1 },
    switchDistanceRangeBear: { min: 0, max: 1 },
  };

  const input = autoSymbolManagerTest.resolveAutoSearchThresholdInput({
    direction: 'LONG',
    monitorSymbol: 'MONITOR.MISSING',
    autoSearchConfig,
    logPrefix: '[自动寻标] 缺少阈值配置，跳过寻标',
  });

  assert.equal(input, null);
});

test('buildFindBestWarrantInput builds consistent findBestWarrant input', async () => {
  const autoSearchConfig: AutoSearchConfig = {
    autoSearchEnabled: true,
    autoSearchMinPriceBull: 1.2,
    autoSearchMinPriceBear: 0.9,
    autoSearchMinTurnoverPerMinuteBull: 500,
    autoSearchMinTurnoverPerMinuteBear: 400,
    autoSearchExpiryMinMonths: 6,
    autoSearchOpenDelayMinutes: 0,
    switchDistanceRangeBull: { min: 0, max: 1 },
    switchDistanceRangeBear: { min: 0, max: 1 },
  };

  const ctx = {} as QuoteContext;
  const marketDataClient: MarketDataClient = {
    _getContext: async () => ctx,
    getQuotes: async () => new Map(),
    subscribeSymbols: async () => {},
    unsubscribeSymbols: async () => {},
    getCandlesticks: async () => [],
    getTradingDays: async () => ({ tradingDays: [], halfTradingDays: [] }),
    isTradingDay: async () => ({ isTradingDay: false, isHalfDay: false }),
    cacheStaticInfo: async () => {},
  };
  const cacheConfig: WarrantListCacheConfig = {
    cache: {
      entries: new Map(),
      inFlight: new Map(),
    },
    ttlMs: 1000,
    nowMs: () => 0,
  };
  const currentTime = new Date('2026-02-02T00:00:00.000Z');

  const input = await autoSymbolManagerTest.buildFindBestWarrantInput({
    direction: 'LONG',
    monitorSymbol: 'MONITOR.INPUT',
    autoSearchConfig,
    currentTime,
    marketDataClient,
    warrantListCacheConfig: cacheConfig,
    minPrice: 1.2,
    minTurnoverPerMinute: 500,
  });

  assert.ok(input);
  assert.equal(input.ctx, ctx);
  assert.equal(input.monitorSymbol, 'MONITOR.INPUT');
  assert.equal(input.isBull, true);
  assert.equal(input.tradingMinutes, getTradingMinutesSinceOpen(currentTime));
  assert.equal(input.minPrice, 1.2);
  assert.equal(input.minTurnoverPerMinute, 500);
  assert.equal(input.expiryMinMonths, 6);
  assert.equal(input.cacheConfig, cacheConfig);
});
