import assert from 'node:assert/strict';
import test from 'node:test';
import { createSignalProcessor } from '../dist/src/core/signalProcessor/index.js';

function buildQuote(symbol) {
  return {
    symbol,
    name: null,
    price: 1,
    prevClose: 1,
    timestamp: 0,
  };
}

test('applyRiskChecks blocks buy signals during liquidation cooldown', async () => {
  let markCalled = false;
  const liquidationCooldownTracker = {
    getRemainingMs() {
      return 60_000;
    },
  };
  const tradingConfig = {
    monitors: [],
    global: {
      doomsdayProtection: false,
    },
  };

  const signalProcessor = createSignalProcessor({
    tradingConfig,
    liquidationCooldownTracker,
  });

  const trader = {
    getAccountSnapshot: async () => null,
    getStockPositions: async () => [],
    _canTradeNow: () => ({ canTrade: true, waitSeconds: 0 }),
    _markBuyAttempt: () => {
      markCalled = true;
    },
  };

  const riskChecker = {
    checkBeforeOrder: () => ({ allowed: true }),
    checkWarrantRisk: () => ({ allowed: true }),
  };

  const orderRecorder = {
    getLatestBuyOrderPrice: () => null,
  };

  const doomsdayProtection = {
    shouldRejectBuy: () => false,
  };

  const monitorConfig = {
    buyIntervalSeconds: 60,
    liquidationCooldownMinutes: 30,
    targetNotional: 10000,
  };

  const result = await signalProcessor.applyRiskChecks(
    [
      {
        symbol: '68711.HK',
        action: 'BUYCALL',
      },
    ],
    {
      trader,
      riskChecker,
      orderRecorder,
      longQuote: buildQuote('68711.HK'),
      shortQuote: buildQuote('68712.HK'),
      monitorQuote: null,
      monitorSnapshot: null,
      longSymbol: '68711.HK',
      shortSymbol: '68712.HK',
      longSymbolName: null,
      shortSymbolName: null,
      account: null,
      positions: [],
      currentTime: new Date('2026-01-26T00:00:00Z'),
      isHalfDay: false,
      doomsdayProtection,
      config: monitorConfig,
    },
  );

  assert.equal(result.length, 0);
  assert.equal(markCalled, false);
});
