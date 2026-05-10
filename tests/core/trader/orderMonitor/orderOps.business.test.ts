/**
 * orderMonitor/orderOps 业务测试
 *
 * 覆盖：
 * - trackOrder 会把 orderId 挂到 symbol bucket，并在 ACTIVE 运行态触发 TRACKED wakeup
 * - 恢复阶段 trackOrder 只重建 truth，不触发 TRACKED wakeup
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createOrderOps } from '../../../../src/core/trader/orderMonitor/orderOps.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';
import { createTradeContextDouble } from '../../../helpers/testDoubles.js';
import type { OrderHoldRegistry, OrderCacheManager } from '../../../../src/core/trader/types.js';
import type { RateLimiter } from '../../../../src/types/services.js';
import { createTradeContextMock } from '../../../../mock/longbridge/tradeContextMock.js';

function createRuntimeStore(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceOutcomeByOrderId: new Map(),
    orderStateChangedListeners: new Set(),
    trackedOrderIdsBySymbol: new Map(),
    routeStatesBySymbol: new Map(),
    latestRouteGenerationBySymbol: new Map(),
    runtimeState: 'ACTIVE',
    running: true,
    unsubscribeQuoteUpdated: null,
  };
}

function createOrderHoldRegistry(): OrderHoldRegistry {
  return {
    trackOrder: () => {},
    markOrderClosed: () => {},
    seedFromOrders: () => {},
    getHoldSymbols: () => new Set<string>(),
    onOrderHoldSymbolsChanged: () => () => {},
    clear: () => {},
  };
}

function createRateLimiter(): RateLimiter {
  return {
    throttle: async () => {},
  };
}

function createCacheManager(): OrderCacheManager {
  return {
    getPendingOrders: async () => [],
    clearCache: () => {},
  };
}

function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
}

describe('orderMonitor orderOps', () => {
  it('trackOrder 会建立 symbol bucket、route state，并在 ACTIVE 运行态触发 TRACKED wakeup', () => {
    const runtime = createRuntimeStore();
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const deps = {
      runtime,
      ctx: createTradeContextDouble(),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
        }),
      },
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    };
    const orderOps = createOrderOps(deps);

    orderOps.trackOrder({
      orderId: 'ORDER-TRACK-1',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    expect([...(runtime.trackedOrderIdsBySymbol.get('BULL.HK') ?? new Set()).values()]).toEqual([
      'ORDER-TRACK-1',
    ]);
    expect(runtime.routeStatesBySymbol.get('BULL.HK')).not.toBeUndefined();
    expect(routeWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        kind: 'TRACKED',
      },
    ]);
  });

  it('recovery restore 期间的 trackOrder 不触发 TRACKED wakeup', () => {
    const runtime = createRuntimeStore();
    runtime.runtimeState = 'BOOTSTRAPPING';
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const deps = {
      runtime,
      ctx: createTradeContextDouble(),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
        }),
      },
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    };
    const orderOps = createOrderOps(deps);

    orderOps.trackOrder({
      orderId: 'ORDER-RECOVERY-1',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    expect([...(runtime.trackedOrderIdsBySymbol.get('BULL.HK') ?? new Set()).values()]).toEqual([
      'ORDER-RECOVERY-1',
    ]);
    expect(routeWakeups).toEqual([]);
  });

  it('cancelOrder retries repeated request failures and rethrows ExternalApiRequestError', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let cancelCallCount = 0;
    tradeCtx.cancelOrder = async () => {
      cancelCallCount += 1;
      throw new Error('network unavailable');
    };
    const orderOps = createOrderOps({
      runtime,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
        }),
      },
      triggerRoute: () => {},
    });

    try {
      await orderOps.cancelOrder('ORDER-CANCEL-RETRY');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.cancelOrder',
      });
      expect(cancelCallCount).toBeGreaterThan(1);
    }
  });

  it('cancelOrder retries coded transient rate-limit errors', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let cancelCallCount = 0;
    tradeCtx.cancelOrder = async () => {
      cancelCallCount += 1;
      throw new Error('openapi error: code=429: rate limit exceeded');
    };
    const orderOps = createOrderOps({
      runtime,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
        }),
      },
      triggerRoute: () => {},
    });

    try {
      await orderOps.cancelOrder('ORDER-CANCEL-CODED-TRANSIENT');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.cancelOrder',
      });
      expect(cancelCallCount).toBeGreaterThan(1);
    }
  });

  it('cancelOrder does not retry known business error codes even when message contains retry hints', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let cancelCallCount = 0;
    tradeCtx.cancelOrder = async () => {
      cancelCallCount += 1;
      throw new Error('openapi error: code=601011: order already cancelled after network delay');
    };
    const orderOps = createOrderOps({
      runtime,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'TERMINAL' as const,
          closedReason: 'CANCELED' as const,
          status: 15,
          executedPrice: null,
          executedQuantity: null,
          executedTimeMs: null,
        }),
      },
      triggerRoute: () => {},
    });

    const outcome = await orderOps.cancelOrder('ORDER-CANCEL-BUSINESS-NO-RETRY');

    expect(cancelCallCount).toBe(1);
    expect(outcome.kind).toBe('ALREADY_CLOSED');
  });

  it('replaceOrderPrice does not retry known business error codes even when message contains retry hints', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let replaceCallCount = 0;
    tradeCtx.replaceOrder = async () => {
      replaceCallCount += 1;
      throw new Error('openapi error: code=602012: unsupported order type after timeout');
    };
    const orderOps = createOrderOps({
      runtime,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'ORDER-REPLACE-BUSINESS-NO-RETRY',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await orderOps.replaceOrderPrice('ORDER-REPLACE-BUSINESS-NO-RETRY', 1.23);

    expect(replaceCallCount).toBe(1);
    expect(runtime.latestReplaceOutcomeByOrderId.get('ORDER-REPLACE-BUSINESS-NO-RETRY')).toEqual({
      kind: 'SKIPPED',
      reason: 'UNSUPPORTED_BY_TYPE',
    });
  });

  it('replaceOrderPrice retries coded transient service errors', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let replaceCallCount = 0;
    tradeCtx.replaceOrder = async () => {
      replaceCallCount += 1;
      throw new Error('openapi error: code=503: service unavailable');
    };
    const orderOps = createOrderOps({
      runtime,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'ORDER-REPLACE-CODED-TRANSIENT',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    try {
      await orderOps.replaceOrderPrice('ORDER-REPLACE-CODED-TRANSIENT', 1.23);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.replaceOrder',
      });
      expect(replaceCallCount).toBeGreaterThan(1);
    }
  });

  it('replaceOrderPrice retries repeated request failures and rethrows ExternalApiRequestError', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let replaceCallCount = 0;
    tradeCtx.replaceOrder = async () => {
      replaceCallCount += 1;
      throw new Error('network unavailable');
    };
    const orderOps = createOrderOps({
      runtime,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'ORDER-REPLACE-RETRY',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    try {
      await orderOps.replaceOrderPrice('ORDER-REPLACE-RETRY', 1.23, 1000);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.replaceOrder',
      });
      expect(replaceCallCount).toBeGreaterThan(1);
    }
  });

  it('replaceOrderPrice 在订单脱离追踪后不会写回过期结果', async () => {
    const runtime = createRuntimeStore();
    const replaceStarted = createDeferred();
    const releaseReplace = createDeferred();
    const tradeCtx = createTradeContextMock();
    let replaceCallCount = 0;
    tradeCtx.replaceOrder = async () => {
      replaceCallCount += 1;
      replaceStarted.resolve();
      await releaseReplace.promise;
    };
    const deps = {
      runtime,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
        }),
      },
      triggerRoute: () => {},
    };
    const orderOps = createOrderOps(deps);
    orderOps.trackOrder({
      orderId: 'ORDER-STALE-REPLACE-1',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    const trackedOrder = runtime.trackedOrders.get('ORDER-STALE-REPLACE-1');
    if (!trackedOrder) {
      throw new Error('missing tracked order for stale replace test');
    }

    const replacePromise = orderOps.replaceOrderPrice('ORDER-STALE-REPLACE-1', 1.23);
    await replaceStarted.promise;
    runtime.trackedOrders.delete('ORDER-STALE-REPLACE-1');
    runtime.trackedOrderLifecycles.set('ORDER-STALE-REPLACE-1', 'CLOSED');
    runtime.trackedOrderIdsBySymbol.delete('BULL.HK');
    runtime.routeStatesBySymbol.delete('BULL.HK');
    runtime.closedOrderIds.add('ORDER-STALE-REPLACE-1');
    releaseReplace.resolve();
    await replacePromise;

    expect(replaceCallCount).toBe(1);
    expect(runtime.latestReplaceOutcomeByOrderId.has('ORDER-STALE-REPLACE-1')).toBe(false);
    expect(runtime.queriedTerminalStateByOrderId.has('ORDER-STALE-REPLACE-1')).toBe(false);
    expect(trackedOrder.submittedPrice).toBe(1.01);
    expect(trackedOrder.submittedQuantity).toBe(100);
  });
});
