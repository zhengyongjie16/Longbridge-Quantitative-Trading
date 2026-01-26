import assert from 'node:assert/strict';
import test from 'node:test';
import { OrderSide, OrderStatus } from 'longport';
import { createOrderMonitor } from '../dist/src/core/trader/orderMonitor.js';

test('orderMonitor uses updatedAt and records liquidation cooldown', () => {
  const recordedBuys = [];
  const cooldownCalls = [];
  let handleOrderChanged;
  const noop = () => {};

  const orderRecorder = {
    recordLocalBuy: (...args) => {
      recordedBuys.push(args);
    },
    recordLocalSell: noop,
  };

  const liquidationCooldownTracker = {
    recordCooldown: (payload) => {
      cooldownCalls.push(payload);
    },
    getRemainingMs: () => 0,
  };

  const emitFilled = (orderId, updatedAt) => {
    handleOrderChanged({
      orderId,
      status: OrderStatus.Filled,
      executedPrice: 10,
      executedQuantity: 100,
      updatedAt,
    });
  };

  const orderMonitor = createOrderMonitor({
    ctxPromise: Promise.resolve({
      setOnOrderChanged: noop,
      subscribe: async () => {},
      todayOrders: async () => [],
      historyOrders: async () => [],
      submitOrder: async () => ({ orderId: 'mock' }),
      cancelOrder: async () => {},
      replaceOrder: async () => {},
    }),
    rateLimiter: { throttle: async () => {} },
    cacheManager: { clearCache: () => {} },
    orderRecorder,
    tradingConfig: {
      monitors: [
        {
          longSymbol: '68711.HK',
          shortSymbol: '68712.HK',
        },
      ],
      global: {
        buyOrderTimeout: { enabled: false, timeoutSeconds: 0 },
        sellOrderTimeout: { enabled: false, timeoutSeconds: 0 },
        orderMonitorPriceUpdateInterval: 5,
      },
    },
    liquidationCooldownTracker,
    testHooks: {
      setHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    },
  });

  assert.ok(handleOrderChanged);

  orderMonitor.trackOrder('buy-1', '68711.HK', OrderSide.Buy, 10, 100, true, false);
  orderMonitor.trackOrder('sell-1', '68711.HK', OrderSide.Sell, 10, 100, true, true);

  const buyUpdatedAt = new Date('2026-01-26T10:00:00.000Z');
  emitFilled('buy-1', buyUpdatedAt);

  const sellUpdatedAt = new Date('2026-01-26T10:05:00.000Z');
  emitFilled('sell-1', sellUpdatedAt);

  assert.equal(recordedBuys.length, 1);
  assert.equal(recordedBuys[0]?.[4], buyUpdatedAt.getTime());
  assert.equal(cooldownCalls.length, 1);
  assert.equal(cooldownCalls[0]?.executedTimeMs, sellUpdatedAt.getTime());
  assert.equal(cooldownCalls[0]?.direction, 'LONG');
});
