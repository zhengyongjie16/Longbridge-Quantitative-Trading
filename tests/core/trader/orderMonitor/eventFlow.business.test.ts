/**
 * orderMonitor/eventFlow 业务测试
 *
 * 覆盖：
 * - truth 推进后触发 ORDER_EVENT wakeup
 * - timeoutMarketConversionPending 收到终态后写入 terminal snapshot 并显式唤醒 route
 * - 普通终态结算后若同 symbol route 仍存在，会继续触发 ORDER_EVENT wakeup
 * - 未追踪订单的 closed event 不触发 route wakeup
 */
import { describe, expect, it, mock } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createPushOrderChanged } from '../../../../mock/factories/tradeFactory.js';
import { createEventFlow } from '../../../../src/core/trader/orderMonitor/eventFlow.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';
import { createOrderRecorderDouble } from '../../../helpers/testDoubles.js';

mock.module('../../../../src/utils/logger/index.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

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

function createTrackedOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly status?: OrderStatus;
  readonly timeoutMarketConversionPending?: boolean;
}): OrderMonitorTrackedOrder {
  const now = Date.now();
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    side: params.side,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: false,
    liquidationTriggerLimit: 1,
    liquidationCooldownConfig: null,
    orderType: OrderType.ELO,
    submittedPrice: 1,
    initialSubmittedPrice: 1,
    submittedQuantity: 100,
    executedQuantity: 0,
    executedPrice: null,
    lastExecutedTimeMs: null,
    status: params.status ?? OrderStatus.New,
    submittedAt: now,
    lastPriceUpdateAt: now,
    convertedToMarket: false,
    nextCancelAttemptAt: now,
    cancelRetryCount: 0,
    replaceCapability: 'SUPPORTED',
    replaceBlockedUntilAt: null,
    quoteRetryAttempts: 0,
    quoteRetryNextAt: null,
    quoteRetryExhausted: false,
    replaceTempBlockedCount: 0,
    replaceResumeMode: 'TIME_BACKOFF',
    timeoutMarketConversionPending: params.timeoutMarketConversionPending ?? false,
    timeoutMarketConversionTerminalState: null,
  };
}

describe('orderMonitor eventFlow', () => {
  it('STOPPED 阶段收到订单 WS 时会直接忽略，不缓存也不推进 truth', () => {
    const runtime = createRuntimeStore();
    runtime.runtimeState = 'STOPPED';
    runtime.trackedOrders.set(
      'ORDER-STOPPED-IGNORED-1',
      createTrackedOrder({
        orderId: 'ORDER-STOPPED-IGNORED-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    );
    let cacheCalls = 0;
    let settlementCalls = 0;
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: false, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {
        cacheCalls += 1;
      },
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChanged(
      createPushOrderChanged({
        orderId: 'ORDER-STOPPED-IGNORED-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
      }),
    );

    expect(cacheCalls).toBe(0);
    expect(settlementCalls).toBe(0);
    expect(routeWakeups).toEqual([]);
    expect(runtime.trackedOrders.get('ORDER-STOPPED-IGNORED-1')?.status).toBe(OrderStatus.New);
  });

  it('在 truth 推进后触发 tracked order symbol 的 ORDER_EVENT wakeup', () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-WS-1',
      createTrackedOrder({
        orderId: 'ORDER-WS-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    );
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: 'ORDER-WS-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PendingCancel,
      }),
    );

    expect(routeWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        kind: 'ORDER_EVENT',
      },
    ]);
  });

  it('卖单 timeoutMarketConversionPending 收到终态后写入 terminal snapshot 并显式唤醒 route', () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-SELL-TIMEOUT-1',
      createTrackedOrder({
        orderId: 'ORDER-SELL-TIMEOUT-1',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        timeoutMarketConversionPending: true,
      }),
    );
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: 'ORDER-SELL-TIMEOUT-1',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        executedPrice: 1.02,
        executedQuantity: 0,
      }),
    );

    expect(
      runtime.trackedOrders.get('ORDER-SELL-TIMEOUT-1')?.timeoutMarketConversionTerminalState,
    ).toMatchObject({
      closedReason: 'CANCELED',
      source: 'WS',
    });

    expect(routeWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        kind: 'ORDER_EVENT',
      },
    ]);
  });

  it('tracked order 收到普通终态且 route 已空时不再触发 ORDER_EVENT wakeup', () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-TERMINAL-1',
      createTrackedOrder({
        orderId: 'ORDER-TERMINAL-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    );
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const settlementPayloads: Array<{
      readonly orderId: string;
      readonly closedReason: string;
      readonly source: string;
    }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      settleOrder: (params) => {
        settlementPayloads.push({
          orderId: params.orderId,
          closedReason: params.closedReason,
          source: params.source,
        });
        runtime.trackedOrders.delete(params.orderId);
        runtime.trackedOrderLifecycles.set(params.orderId, 'CLOSED');
        runtime.trackedOrderIdsBySymbol.delete('BULL.HK');
        runtime.routeStatesBySymbol.delete('BULL.HK');
        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: 'ORDER-TERMINAL-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        executedPrice: 1.05,
        executedQuantity: 100,
      }),
    );

    expect(settlementPayloads).toEqual([
      {
        orderId: 'ORDER-TERMINAL-1',
        closedReason: 'FILLED',
        source: 'WS',
      },
    ]);
    expect(routeWakeups).toEqual([]);
  });

  it('tracked order 收到普通终态后若 route 仍存在会继续触发 ORDER_EVENT wakeup', () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-TERMINAL-A',
      createTrackedOrder({
        orderId: 'ORDER-TERMINAL-A',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    );

    runtime.trackedOrders.set(
      'ORDER-TERMINAL-B',
      createTrackedOrder({
        orderId: 'ORDER-TERMINAL-B',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
      }),
    );

    runtime.trackedOrderIdsBySymbol.set(
      'BULL.HK',
      new Set(['ORDER-TERMINAL-A', 'ORDER-TERMINAL-B']),
    );

    runtime.routeStatesBySymbol.set('BULL.HK', {
      symbol: 'BULL.HK',
      generation: 1,
      inFlight: false,
      dirty: false,
      latestQuote: null,
      pendingWakeupKind: null,
      timerHandles: new Map(),
    });
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      settleOrder: (params) => {
        runtime.trackedOrders.delete(params.orderId);
        runtime.trackedOrderLifecycles.set(params.orderId, 'CLOSED');
        const bucket = runtime.trackedOrderIdsBySymbol.get('BULL.HK');
        if (bucket) {
          bucket.delete(params.orderId);
          if (bucket.size === 0) {
            runtime.trackedOrderIdsBySymbol.delete('BULL.HK');
            runtime.routeStatesBySymbol.delete('BULL.HK');
          }
        }

        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: 'ORDER-TERMINAL-A',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        executedPrice: 1.05,
        executedQuantity: 100,
      }),
    );

    expect(routeWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        kind: 'ORDER_EVENT',
      },
    ]);
  });

  it('未追踪订单的 closed event 不触发 route wakeup', () => {
    const runtime = createRuntimeStore();
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: 'UNTRACKED-CLOSED-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
      }),
    );

    expect(routeWakeups).toEqual([]);
  });
});
