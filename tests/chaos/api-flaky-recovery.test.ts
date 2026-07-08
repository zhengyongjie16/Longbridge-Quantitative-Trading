/**
 * api-flaky-recovery 混沌测试
 *
 * 功能：
 * - 验证 API 不稳定时的重试与恢复行为期望。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderType, type TradeContext } from 'longbridge';

import { createOrderMonitor } from '../../src/core/trader/orderMonitor/index.js';
import type { OrderMonitorDeps } from '../../src/core/trader/types.js';

import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createSymbolRegistryDouble,
  createQuoteDouble,
} from '../helpers/testDoubles.js';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

type RuntimeTimerHarness = {
  readonly advanceBy: (delayMs: number) => Promise<void>;
  readonly restore: () => void;
};

function createRuntimeTimerHarness(initialNowMs: number): RuntimeTimerHarness {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nowMs = initialNowMs;
  const timers = new Map<unknown, { readonly atMs: number; readonly callback: () => void }>();

  function isTimerCallback(
    handler: Parameters<typeof globalThis.setTimeout>[0],
  ): handler is (...args: ReadonlyArray<unknown>) => void {
    return typeof handler === 'function';
  }

  const fakeSetTimeout = Object.assign(
    (
      handler: Parameters<typeof globalThis.setTimeout>[0],
      timeout?: number,
    ): ReturnType<typeof originalSetTimeout> => {
      if (!isTimerCallback(handler)) {
        throw new TypeError('[测试] fake runtime timer 仅支持函数回调');
      }

      const handle = originalSetTimeout(() => {}, 0);
      originalClearTimeout(handle);
      timers.set(handle, {
        atMs: nowMs + (typeof timeout === 'number' ? timeout : 0),
        callback: () => {
          handler();
        },
      });
      return handle;
    },
    {
      __promisify__: originalSetTimeout.__promisify__,
    },
  );

  const fakeClearTimeout: typeof globalThis.clearTimeout = (handle) => {
    timers.delete(handle);
  };

  Date.now = () => nowMs;
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = fakeClearTimeout;

  return {
    advanceBy: async (delayMs: number) => {
      nowMs += delayMs;
      const dueTimers = [...timers.entries()].filter(([, timer]) => timer.atMs <= nowMs);
      for (const [handle, timer] of dueTimers) {
        timers.delete(handle);
        timer.callback();
      }

      await flushMicrotasks();
      await flushMicrotasks();
    },
    restore: () => {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function createOrderMonitorDeps(params?: {
  readonly sellTimeoutSeconds?: number;
  readonly orderRecorder?: ReturnType<typeof createOrderRecorderDouble>;
}): { deps: OrderMonitorDeps; tradeCtx: ReturnType<typeof createTradeContextMock> } {
  const tradeCtx = createTradeContextMock();
  const deps: OrderMonitorDeps = {
    ctx: tradeCtx as unknown as TradeContext,
    rateLimiter: {
      throttle: async () => {},
    },
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => [],
    },
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.01, 100)]]),
    }),
    orderRecorder: params?.orderRecorder ?? createOrderRecorderDouble(),
    dailyLossTracker: {
      resetAll: () => {},
      startNewProtectionEpisode: () => {},
      recalculateFromAllOrders: () => {},
      recordFilledOrder: () => {},
      getLossOffset: () => 0,
    },
    orderHoldRegistry: {
      trackOrder: () => {},
      markOrderClosed: () => {},
      seedFromOrders: () => {},
      getHoldSymbols: () => new Set<string>(),
      onOrderHoldSymbolsChanged: () => () => {},
      clear: () => {},
    },
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: () => {},
    },
    tradingConfig: createTradingConfig({
      global: {
        ...createTradingConfig().global,
        buyOrderTimeout: {
          enabled: true,
          timeoutSeconds: 999,
        },
        sellOrderTimeout: {
          enabled: true,
          timeoutSeconds: params?.sellTimeoutSeconds ?? 0,
        },
        orderMonitorPriceUpdateInterval: 0,
      },
    }),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
  };

  return { deps, tradeCtx };
}

describe('chaos: api flaky recovery', () => {
  it('retries timeout cancel after backoff and still waits for WS after cancel succeeds', async () => {
    const orderRecorder = createOrderRecorderDouble({
      markSellCancelled: (orderId) => ({
        orderId,
        symbol: 'BULL.HK',
        direction: 'LONG',
        submittedQuantity: 100,
        filledQuantity: 0,
        relatedBuyOrderIds: ['BUY-001'],
        status: 'cancelled',
        submittedAt: Date.now(),
      }),
    });
    const { deps, tradeCtx } = createOrderMonitorDeps({
      sellTimeoutSeconds: 0,
      orderRecorder,
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'transient cancelOrder failure',
    });

    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T03:00:00.000Z'));
    const monitor = createOrderMonitor(deps);
    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'SELL-CHAOS-001',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        price: 1,
        initialSubmittedPrice: 1,
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: OrderType.ELO,
      });
      await flushMicrotasks();

      expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
      expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);

      await flushMicrotasks();
      await flushMicrotasks();
      await runtimeTimers.advanceBy(2_100);

      expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(2);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
      expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    } finally {
      runtimeTimers.restore();
    }
  });
});
