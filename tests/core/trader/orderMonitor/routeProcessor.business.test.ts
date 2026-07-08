/**
 * orderMonitor routeProcessor 业务测试
 *
 * 功能：
 * - 锁定 quoteFlow 迁移到 routeProcessor 后必须保持的超时与动作选择语义。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import {
  ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
  ORDER_QUOTE_RETRY,
} from '../../../../src/constants/index.js';
import { createOrderStorage } from '../../../../src/core/orderRecorder/orderStorage.js';
import { createRouteProcessor } from '../../../../src/core/trader/orderMonitor/routeProcessor.js';
import { createSettlementFlow } from '../../../../src/core/trader/orderMonitor/settlementFlow.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
  ReplaceOrderOutcome,
  RouteProcessorDeps,
} from '../../../../src/core/trader/orderMonitor/types.js';
import type { OrderMonitorConfig, TrackOrderParams } from '../../../../src/core/trader/types.js';
import type { OrderRecord } from '../../../../src/types/services.js';
import { toDecimal } from '../../../../src/core/trader/utils.js';
import { createTradeContextMock } from '../../../../mock/longbridge/tradeContextMock.js';
import {
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createTradeContextDouble,
} from '../../../helpers/testDoubles.js';

function createRuntimeStore(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map(),
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

function createConfig(params?: {
  readonly buyTimeoutMs?: number;
  readonly sellTimeoutMs?: number;
  readonly priceUpdateIntervalMs?: number;
  readonly allowBuyOrderTrackingAboveInitialPrice?: boolean;
}): OrderMonitorConfig {
  return {
    buyTimeout: {
      enabled: true,
      timeoutMs: params?.buyTimeoutMs ?? 0,
    },
    sellTimeout: {
      enabled: true,
      timeoutMs: params?.sellTimeoutMs ?? 0,
    },
    priceUpdateIntervalMs: params?.priceUpdateIntervalMs ?? 0,
    priceDiffThreshold: 0.001,
    allowBuyOrderTrackingAboveInitialPrice: params?.allowBuyOrderTrackingAboveInitialPrice ?? true,
  };
}

function createTrackedOrder(
  params: Partial<OrderMonitorTrackedOrder> &
    Pick<OrderMonitorTrackedOrder, 'orderId' | 'symbol' | 'side'>,
): OrderMonitorTrackedOrder {
  const now = Date.now();
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    side: params.side,
    isLongSymbol: params.isLongSymbol ?? true,
    monitorSymbol: params.monitorSymbol ?? 'HSI.HK',
    isProtectiveLiquidation: params.isProtectiveLiquidation ?? false,
    liquidationTriggerLimit: params.liquidationTriggerLimit ?? 1,
    liquidationCooldownConfig: params.liquidationCooldownConfig ?? null,
    orderType: params.orderType ?? OrderType.ELO,
    submittedPrice: params.submittedPrice ?? 1,
    initialSubmittedPrice: params.initialSubmittedPrice ?? 1,
    submittedQuantity: params.submittedQuantity ?? 100,
    executedQuantity: params.executedQuantity ?? 0,
    executedPrice: params.executedPrice ?? null,
    lastExecutedTimeMs: params.lastExecutedTimeMs ?? null,
    status: params.status ?? OrderStatus.New,
    submittedAt: params.submittedAt ?? now - 5_000,
    lastPriceUpdateAt: params.lastPriceUpdateAt ?? now - 5_000,
    convertedToMarket: params.convertedToMarket ?? false,
    nextCancelAttemptAt: params.nextCancelAttemptAt ?? now - 1,
    cancelRetryCount: params.cancelRetryCount ?? 0,
    replaceCapability: params.replaceCapability ?? 'SUPPORTED',
    replaceBlockedUntilAt: params.replaceBlockedUntilAt ?? null,
    quoteRetryAttempts: params.quoteRetryAttempts ?? 0,
    quoteRetryNextAt: params.quoteRetryNextAt ?? null,
    quoteRetryExhausted: params.quoteRetryExhausted ?? false,
    replaceTempBlockedCount: params.replaceTempBlockedCount ?? 0,
    replaceResumeMode: params.replaceResumeMode ?? 'TIME_BACKOFF',
    timeoutMarketConversionPending: params.timeoutMarketConversionPending ?? false,
    timeoutMarketConversionTerminalState: params.timeoutMarketConversionTerminalState ?? null,
  };
}

function setLatestReplaceOutcome(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
  outcome: ReplaceOrderOutcome,
): void {
  runtime.latestReplaceOutcomeByOrderId.set(orderId, outcome);
}

function attachTrackedOrders(
  runtime: OrderMonitorRuntimeStore,
  symbol: string,
  orders: ReadonlyArray<OrderMonitorTrackedOrder>,
): void {
  const orderIds = new Set<string>();
  for (const order of orders) {
    runtime.trackedOrders.set(order.orderId, order);
    runtime.trackedOrderLifecycles.set(order.orderId, 'OPEN');
    orderIds.add(order.orderId);
  }

  runtime.trackedOrderIdsBySymbol.set(symbol, orderIds);
  runtime.routeStatesBySymbol.set(symbol, {
    symbol,
    generation: 1,
    inFlight: false,
    dirty: false,
    latestQuote: null,
    pendingWakeupKind: null,
    timerHandles: new Map(),
  });
  runtime.latestRouteGenerationBySymbol.set(symbol, 1);
}

function makeOrderRecord(
  orderId: string,
  executedPrice: number,
  executedQuantity: number,
  executedTime: number,
  symbol = 'BULL.HK',
): OrderRecord {
  return {
    orderId,
    symbol,
    executedPrice,
    executedQuantity,
    executedTime,
    submittedAt: undefined,
    updatedAt: undefined,
  };
}

function createDeferredValue<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
}

function createStorageBackedOrderRecorder(
  storage: ReturnType<typeof createOrderStorage>,
): RouteProcessorDeps['orderRecorder'] {
  return createOrderRecorderDouble({
    recordLocalSell: (
      symbol,
      executedPrice,
      executedQuantity,
      isLongSymbol,
      executedTimeMs,
      orderId,
      relatedBuyOrderIds,
    ) => {
      storage.updateAfterSell(
        symbol,
        executedPrice,
        executedQuantity,
        isLongSymbol,
        executedTimeMs,
        orderId,
        relatedBuyOrderIds,
      );
    },
    getBuyOrdersForSymbol: (symbol, isLongSymbol) => storage.getBuyOrdersList(symbol, isLongSymbol),
    submitSellOrder: (orderId, symbol, direction, quantity, relatedBuyOrderIds, submittedAtMs) => {
      storage.addPendingSell({
        orderId,
        symbol,
        direction,
        submittedQuantity: quantity,
        relatedBuyOrderIds,
        submittedAt: submittedAtMs ?? Date.now(),
      });
    },
    markSellCancelled: (orderId) => storage.markSellCancelled(orderId),
    allocateRelatedBuyOrderIdsForRecovery: (symbol, direction, quantity) =>
      storage.allocateRelatedBuyOrderIdsForRecovery(symbol, direction, quantity),
    getPendingSellSnapshot: () => storage.getPendingSellSnapshot(),
    selectSellableOrders: (params) => storage.selectSellableOrders(params),
  });
}

function createSettlementFlowForRouteProcessor(params: {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly orderRecorder: RouteProcessorDeps['orderRecorder'];
}): ReturnType<typeof createSettlementFlow> {
  return createSettlementFlow({
    runtime: params.runtime,
    orderHoldRegistry: {
      trackOrder: () => {},
      markOrderClosed: () => {},
      seedFromOrders: () => {},
      getHoldSymbols: () => new Set<string>(),
      onOrderHoldSymbolsChanged: () => () => {},
      clear: () => {},
    },
    orderRecorder: params.orderRecorder,
    dailyLossTracker: {
      resetAll: () => {},
      startNewProtectionEpisode: () => {},
      recalculateFromAllOrders: () => {},
      recordFilledOrder: () => {},
      getLossOffset: () => 0,
    },
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: () => {},
    },
    emitOrderStateChanged: () => {},
  });
}

function createTimeoutSellHandoffHarness(orderId: string): {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly storage: ReturnType<typeof createOrderStorage>;
  readonly orderRecorder: RouteProcessorDeps['orderRecorder'];
  readonly settlementFlow: ReturnType<typeof createSettlementFlow>;
} {
  const runtime = createRuntimeStore();
  attachTrackedOrders(runtime, 'BULL.HK', [
    createTrackedOrder({
      orderId,
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.Canceled,
      submittedQuantity: 200,
      executedQuantity: 0,
      submittedAt: Date.now() - 10_000,
      timeoutMarketConversionPending: true,
      timeoutMarketConversionTerminalState: {
        closedReason: 'CANCELED',
        source: 'WS',
        executedPrice: 0,
        executedQuantity: 0,
        executedTimeMs: Date.parse('2026-04-08T09:00:01.000Z'),
      },
    }),
  ]);

  const storage = createOrderStorage();
  storage.setBuyOrdersListForLong('BULL.HK', [
    makeOrderRecord('BUY-1', 1, 100, Date.parse('2026-04-08T08:30:00.000Z')),
    makeOrderRecord('BUY-2', 1.1, 100, Date.parse('2026-04-08T08:31:00.000Z')),
  ]);

  storage.addPendingSell({
    orderId,
    symbol: 'BULL.HK',
    direction: 'LONG',
    submittedQuantity: 200,
    relatedBuyOrderIds: ['BUY-1', 'BUY-2'],
    submittedAt: Date.parse('2026-04-08T09:00:00.000Z'),
  });

  const orderRecorder = createStorageBackedOrderRecorder(storage);
  const settlementFlow = createSettlementFlowForRouteProcessor({ runtime, orderRecorder });

  return {
    runtime,
    storage,
    orderRecorder,
    settlementFlow,
  };
}

function createDeps(params?: {
  readonly runtime?: OrderMonitorRuntimeStore;
  readonly config?: OrderMonitorConfig;
  readonly cancelOrder?: RouteProcessorDeps['cancelOrder'];
  readonly replaceOrderPrice?: RouteProcessorDeps['replaceOrderPrice'];
  readonly settleOrder?: RouteProcessorDeps['settleOrder'];
  readonly trackOrder?: RouteProcessorDeps['trackOrder'];
  readonly isExecutionAllowed?: () => boolean;
  readonly orderRecorder?: RouteProcessorDeps['orderRecorder'];
  readonly ctx?: RouteProcessorDeps['ctx'];
  readonly rateLimiter?: RouteProcessorDeps['rateLimiter'];
}): {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly tradeCtx: ReturnType<typeof createTradeContextMock>;
  readonly deps: RouteProcessorDeps;
} {
  const runtime = params?.runtime ?? createRuntimeStore();
  const config = params?.config ?? createConfig();
  const tradeCtx = createTradeContextMock();
  const deps: RouteProcessorDeps = {
    runtime,
    config,
    thresholdDecimal: toDecimal(config.priceDiffThreshold),
    orderRecorder: params?.orderRecorder ?? createOrderRecorderDouble(),
    ctx: params?.ctx ?? createTradeContextDouble(tradeCtx),
    rateLimiter: params?.rateLimiter ?? {
      throttle: async () => {},
    },
    isExecutionAllowed: params?.isExecutionAllowed ?? (() => true),
    trackOrder:
      params?.trackOrder ??
      ((_trackParams: TrackOrderParams) => {
        throw new Error('trackOrder was not stubbed');
      }),
    cancelOrder:
      params?.cancelOrder ??
      (async (_orderId: string) => ({
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
        message: 'cancelOrder was not stubbed',
      })),
    replaceOrderPrice:
      params?.replaceOrderPrice ??
      (async (_orderId: string, _newPrice: number, _quantity?: number | null) => {}),
    settleOrder:
      params?.settleOrder ??
      ((_params) => ({
        handled: true,
        relatedBuyOrderIds: null,
      })),
  };

  return {
    runtime,
    tradeCtx,
    deps,
  };
}

async function captureTimeoutMarketRouteError(deps: RouteProcessorDeps): Promise<string> {
  const routeProcessor = createRouteProcessor(deps);
  try {
    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  return '';
}

function expectTimeoutSellOccupancyReleased(storage: ReturnType<typeof createOrderStorage>): void {
  expect(storage.getPendingSellSnapshot()).toEqual([]);
  const sellableOrders = storage.selectSellableOrders({
    symbol: 'BULL.HK',
    direction: 'LONG',
    strategy: 'ALL',
    currentPrice: 1.2,
  });
  expect(sellableOrders.orders.map((order) => order.orderId)).toEqual(['BUY-1', 'BUY-2']);
  expect(sellableOrders.totalQuantity).toBe(200);
}

describe('orderMonitor routeProcessor', () => {
  it('买单超时只触发 cancel，不转市价', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-TIMEOUT-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual(['BUY-TIMEOUT-1']);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    const trackedOrder = runtime.trackedOrders.get('BUY-TIMEOUT-1');
    expect(trackedOrder?.nextCancelAttemptAt).toBe(ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS);
  });

  it('普通终态订单不会再次进入 timeout 处理', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-CLOSED-SHOULD-SKIP-TIMEOUT',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual([]);
  });

  it('卖单超时撤单请求成功后进入等待 WS，不立即转市价', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-TIMEOUT-1',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual(['SELL-TIMEOUT-1']);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    const trackedOrder = runtime.trackedOrders.get('SELL-TIMEOUT-1');
    expect(trackedOrder?.timeoutMarketConversionPending).toBe(true);
    expect(trackedOrder?.nextCancelAttemptAt).toBe(ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS);
  });

  it('卖单等待终态快照时会先 settlement，再转 MO', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-CONVERT-1',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: 0,
          executedTimeMs: Date.parse('2026-04-08T09:00:01.000Z'),
        },
      }),
    ]);
    const callSequence: string[] = [];
    const trackedOrders: TrackOrderParams[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      settleOrder: (_params) => {
        callSequence.push('settle');
        return {
          handled: true,
          relatedBuyOrderIds: ['BUY-1'],
        };
      },
      trackOrder: (params) => {
        callSequence.push('track');
        trackedOrders.push(params);
      },
    });
    const originalSubmitOrder = tradeCtx.submitOrder.bind(tradeCtx);
    tradeCtx.submitOrder = async (options) => {
      callSequence.push('submit');
      return originalSubmitOrder(options);
    };
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(callSequence).toEqual(['settle', 'submit', 'track']);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(0);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.orderId).toBe('MOCK-000001');
    expect(trackedOrders[0]?.orderType).toBe(OrderType.MO);
    expect(trackedOrders[0]?.quantity).toBe(100);
  });

  it('卖单 timeout 结算为无剩余量后，同轮仍允许后续订单基于 quote 继续 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-TIMEOUT-NO-REMAINDER',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        submittedAt: Date.now() - 10_000,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: 100,
          executedTimeMs: Date.now(),
        },
        submittedQuantity: 100,
        executedQuantity: 0,
      }),
      createTrackedOrder({
        orderId: 'SELL-REPLACE-AFTER-NO-REMAINDER',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 5_000,
      }),
      settleOrder: () => {
        runtime.trackedOrders.delete('SELL-TIMEOUT-NO-REMAINDER');
        runtime.trackedOrderLifecycles.set('SELL-TIMEOUT-NO-REMAINDER', 'CLOSED');
        runtime.closedOrderIds.add('SELL-TIMEOUT-NO-REMAINDER');
        runtime.trackedOrderIdsBySymbol.get('BULL.HK')?.delete('SELL-TIMEOUT-NO-REMAINDER');
        return {
          handled: true,
          relatedBuyOrderIds: null,
        };
      },
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual(['SELL-REPLACE-AFTER-NO-REMAINDER']);
  });

  it('单次 pass 最多只执行一个 broker mutation', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-TIMEOUT-OLDER',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        submittedAt: Date.parse('2026-04-08T08:59:00.000Z'),
      }),
      createTrackedOrder({
        orderId: 'BUY-TIMEOUT-NEWER',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        submittedAt: Date.parse('2026-04-08T08:59:30.000Z'),
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'RETRYABLE_FAILURE',
          errorCode: 'NETWORK',
          message: 'retry later',
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual(['BUY-TIMEOUT-OLDER']);
  });

  it('同一订单同时满足 timeout 与 replace 时优先走 timeout', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-TIMEOUT-AND-REPLACE',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'RETRYABLE_FAILURE',
          errorCode: 'NETWORK',
          message: 'retry later',
        };
      },
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(cancelOrderIds).toEqual(['BUY-TIMEOUT-AND-REPLACE']);
    expect(replaceOrderIds).toEqual([]);
  });

  it('前序 timeout 订单处于 WAIT_WS_ONLY 时不会饿死后续可改价订单', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-WAIT-WS-ONLY',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        nextCancelAttemptAt: ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
        submittedAt: Date.now() - 10_000,
      }),
      createTrackedOrder({
        orderId: 'SELL-REPLACE-AFTER-WAIT-WS',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 5_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 0,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual(['SELL-REPLACE-AFTER-WAIT-WS']);
  });

  it('超时转出的 MO 新订单不会再次进入 timeout 路径', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-CONVERT-MO-SKIP-TIMEOUT',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: 0,
          executedTimeMs: Date.now(),
        },
      }),
    ]);
    const trackedOrders: TrackOrderParams[] = [];
    const cancelOrderIds: string[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      settleOrder: () => ({
        handled: true,
        relatedBuyOrderIds: ['BUY-1'],
      }),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        };
      },
    });
    const originalSubmitOrder = tradeCtx.submitOrder.bind(tradeCtx);
    tradeCtx.submitOrder = async (options) => originalSubmitOrder(options);
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(trackedOrders).toHaveLength(1);
    const convertedOrder = createTrackedOrder({
      orderId: 'MOCK-000001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      orderType: OrderType.MO,
      submittedPrice: 0,
      initialSubmittedPrice: 0,
      submittedAt: Date.now() - 10_000,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [convertedOrder]);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual([]);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
  });

  it('卖单等待阶段遇到非法终态快照时会阻断本轮后续动作', async () => {
    const runtime = createRuntimeStore();
    const invalidTerminalState = {
      closedReason: 'UNKNOWN',
      source: 'WS',
      executedPrice: null,
      executedQuantity: null,
      executedTimeMs: null,
    } as unknown as NonNullable<OrderMonitorTrackedOrder['timeoutMarketConversionTerminalState']>;
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-PENDING-INVALID-TERMINAL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 10_000,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: invalidTerminalState,
      }),
      createTrackedOrder({
        orderId: 'SELL-SHOULD-NOT-REPLACE-AFTER-INVALID-TERMINAL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 5_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual([]);
    expect(runtime.trackedOrders.get('SELL-PENDING-INVALID-TERMINAL')?.cancelRetryCount).toBe(1);
  });

  it('卖单 timeout 在剩余数量不明确时会保留 timeout conversion owner 并继续等待或重试', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-PENDING-UNKNOWN-REMAINING',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        submittedAt: Date.now() - 10_000,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: null,
          executedTimeMs: Date.now(),
        },
      }),
    ]);
    const trackedOrder = runtime.trackedOrders.get('SELL-PENDING-UNKNOWN-REMAINING');
    if (!trackedOrder) {
      throw new Error('missing tracked order for timeout remaining test');
    }

    trackedOrder.cancelRetryCount = 3;
    trackedOrder.nextCancelAttemptAt = Date.now() - 1;

    const { deps, tradeCtx } = createDeps({
      runtime,
      settleOrder: () => ({
        handled: true,
        relatedBuyOrderIds: ['BUY-1'],
      }),
      trackOrder: (_params) => {
        throw new Error('should not submit market order when remaining quantity is unknown');
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrder.timeoutMarketConversionPending).toBe(true);
    expect(trackedOrder.timeoutMarketConversionTerminalState).not.toBeNull();
    expect(trackedOrder.cancelRetryCount).toBeGreaterThanOrEqual(3);
  });

  it('卖单 timeout 转市价在 broker submit 返回前保持 related buy orders 占用连续', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } =
      createTimeoutSellHandoffHarness('SELL-TIMEOUT-CONTINUOUS');
    const tradeCtx = createTradeContextMock();
    const submitStarted = createDeferredValue<null>();
    const submitFinished = createDeferredValue<null>();
    const originalSubmitOrder = tradeCtx.submitOrder.bind(tradeCtx);
    tradeCtx.submitOrder = async (options) => {
      submitStarted.resolve(null);
      await submitFinished.promise;
      return originalSubmitOrder(options);
    };
    const trackedOrders: TrackOrderParams[] = [];
    const { deps } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      ctx: createTradeContextDouble(tradeCtx),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    await submitStarted.promise;

    const inFlightSellableOrders = storage.selectSellableOrders({
      symbol: 'BULL.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: 1.2,
    });
    expect(inFlightSellableOrders.orders).toEqual([]);
    expect(inFlightSellableOrders.totalQuantity).toBe(0);
    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([
      'SELL-TIMEOUT-CONTINUOUS',
    ]);

    submitFinished.resolve(null);
    await processPromise;

    const pendingSellSnapshot = storage.getPendingSellSnapshot();
    expect(pendingSellSnapshot).toHaveLength(1);
    expect(pendingSellSnapshot[0]).toMatchObject({
      orderId: 'MOCK-000001',
      submittedQuantity: 200,
      relatedBuyOrderIds: ['BUY-1', 'BUY-2'],
    });
    expect(trackedOrders).toHaveLength(1);
  });

  it('卖单 timeout 转市价在 broker submit 抛错前释放 follow-up placeholder', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } = createTimeoutSellHandoffHarness(
      'SELL-TIMEOUT-SUBMIT-FAIL',
    );
    const tradeCtx = createTradeContextMock();
    tradeCtx.submitOrder = async () => {
      throw new Error('submit failed before broker accept');
    };
    const trackedOrders: TrackOrderParams[] = [];
    const { deps } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      ctx: createTradeContextDouble(tradeCtx),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });

    const errorMessage = await captureTimeoutMarketRouteError(deps);
    expect(errorMessage).toContain('submit failed before broker accept');
    expectTimeoutSellOccupancyReleased(storage);
    expect(trackedOrders).toEqual([]);
  });

  it('卖单 timeout 转市价在 rate limiter 抛错时释放 follow-up placeholder', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } = createTimeoutSellHandoffHarness(
      'SELL-TIMEOUT-RATE-LIMITER-FAIL',
    );
    const trackedOrders: TrackOrderParams[] = [];
    const { deps } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      rateLimiter: {
        throttle: async () => {
          throw new Error('rate limiter failed before broker accept');
        },
      },
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });

    const errorMessage = await captureTimeoutMarketRouteError(deps);
    expect(errorMessage).toContain('rate limiter failed before broker accept');
    expectTimeoutSellOccupancyReleased(storage);
    expect(trackedOrders).toEqual([]);
  });

  it('卖单 timeout 转市价在 broker 已接受后若 runtime 停止则拒绝本地写回', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } = createTimeoutSellHandoffHarness(
      'SELL-TIMEOUT-STOPPED-AFTER-SUBMIT',
    );
    const tradeCtx = createTradeContextMock();
    const submitStarted = createDeferredValue<null>();
    const submitFinished = createDeferredValue<null>();
    const trackedOrders: TrackOrderParams[] = [];
    const originalSubmitOrder = tradeCtx.submitOrder.bind(tradeCtx);
    tradeCtx.submitOrder = async (options) => {
      submitStarted.resolve(null);
      await submitFinished.promise;
      return originalSubmitOrder(options);
    };
    const { deps } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      ctx: createTradeContextDouble(tradeCtx),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    await submitStarted.promise;
    runtime.running = false;
    runtime.runtimeState = 'STOPPED';
    submitFinished.resolve(null);

    expect(processPromise).rejects.toThrow(/stale timeout market conversion commit/i);
    expect(trackedOrders).toEqual([]);
    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([]);
  });

  it('卖单 timeout 转市价在 broker 已接受后若 route generation 变化则拒绝本地写回', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } = createTimeoutSellHandoffHarness(
      'SELL-TIMEOUT-GENERATION-CHANGED',
    );
    const tradeCtx = createTradeContextMock();
    const submitStarted = createDeferredValue<null>();
    const submitFinished = createDeferredValue<null>();
    const trackedOrders: TrackOrderParams[] = [];
    const originalSubmitOrder = tradeCtx.submitOrder.bind(tradeCtx);
    tradeCtx.submitOrder = async (options) => {
      submitStarted.resolve(null);
      await submitFinished.promise;
      return originalSubmitOrder(options);
    };
    const { deps } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      ctx: createTradeContextDouble(tradeCtx),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    await submitStarted.promise;
    const routeState = runtime.routeStatesBySymbol.get('BULL.HK');
    if (routeState) {
      routeState.generation = 2;
    }

    runtime.latestRouteGenerationBySymbol.set('BULL.HK', 2);
    submitFinished.resolve(null);

    expect(processPromise).rejects.toThrow(/stale timeout market conversion commit/i);
    expect(trackedOrders).toEqual([]);
    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([]);
  });

  it('ORDER_EVENT 唤醒会基于 latestQuote 继续推进 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-ORDER-EVENT-REPLACE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual(['SELL-ORDER-EVENT-REPLACE']);
  });

  it('TRACKED 唤醒即使带有 latestQuote 也不会触发普通 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-TRACKED-NO-REPLACE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TRACKED',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual([]);
  });

  it('TIMER 唤醒会在 replace backoff 到期后基于缓存 latestQuote 补跑 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-REPLACE-RETRY-TIMER',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
        replaceCapability: 'TEMP_BLOCKED_BY_STATUS',
        replaceBlockedUntilAt: Date.now() - 1,
        replaceResumeMode: 'TIME_BACKOFF',
        replaceTempBlockedCount: 1,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual(['SELL-REPLACE-RETRY-TIMER']);
  });

  it('QUOTE 唤醒遇到不可用行情时会推进 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:00:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        createTrackedOrder({
          orderId: 'SELL-QUOTE-RETRY-STATE',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: nowMs - 1_000,
          submittedPrice: 1,
          initialSubmittedPrice: 1,
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 0,
          quoteRetryNextAt: null,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: null,
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('SELL-QUOTE-RETRY-STATE');
      expect(order?.quoteRetryAttempts).toBe(1);
      expect(order?.quoteRetryNextAt).toBe(nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS);
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('QUOTE 唤醒遇到无效价格时不会推进 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:02:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        createTrackedOrder({
          orderId: 'SELL-INVALID-QUOTE-NO-RETRY',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: nowMs - 1_000,
          submittedPrice: 1,
          initialSubmittedPrice: 1,
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 0,
          quoteRetryNextAt: null,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: createQuoteDouble('BULL.HK', 0),
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('SELL-INVALID-QUOTE-NO-RETRY');
      expect(order?.quoteRetryAttempts).toBe(0);
      expect(order?.quoteRetryNextAt).toBeNull();
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('TIMER 唤醒会在 quote retry 到期后继续推进 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:05:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        createTrackedOrder({
          orderId: 'SELL-QUOTE-RETRY-TIMER',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: nowMs - 1_000,
          submittedPrice: 1,
          initialSubmittedPrice: 1,
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 1,
          quoteRetryNextAt: nowMs - 1,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'TIMER',
        latestQuote: null,
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('SELL-QUOTE-RETRY-TIMER');
      expect(order?.quoteRetryAttempts).toBe(2);
      expect(order?.quoteRetryNextAt).toBe(nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS);
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('QUOTE 唤醒拿到有效行情后会清空 quote retry 状态并继续 replace', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:08:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        createTrackedOrder({
          orderId: 'SELL-QUOTE-RETRY-RESET',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: nowMs - 1_000,
          submittedPrice: 1,
          initialSubmittedPrice: 1,
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 2,
          quoteRetryNextAt: nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: createQuoteDouble('BULL.HK', 1.02),
      });

      expect(replaceOrderIds).toEqual(['SELL-QUOTE-RETRY-RESET']);
      const order = runtime.trackedOrders.get('SELL-QUOTE-RETRY-RESET');
      expect(order?.quoteRetryAttempts).toBe(0);
      expect(order?.quoteRetryNextAt).toBeNull();
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('有效 quote 即使因 guard 未触发 replace 也会清空 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:09:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        createTrackedOrder({
          orderId: 'BUY-QUOTE-RETRY-GUARD-RESET',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          submittedAt: nowMs - 1_000,
          submittedPrice: 1,
          initialSubmittedPrice: 1,
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 2,
          quoteRetryNextAt: nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
          allowBuyOrderTrackingAboveInitialPrice: false,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: createQuoteDouble('BULL.HK', 1.02),
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('BUY-QUOTE-RETRY-GUARD-RESET');
      expect(order?.quoteRetryAttempts).toBe(0);
      expect(order?.quoteRetryNextAt).toBeNull();
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('replace 确认 TERMINAL_CONFIRMED 时会立即结算并消费 outcome', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-REPLACE-TERMINAL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const settlementCalls: Array<{ readonly orderId: string; readonly closedReason: string }> = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        setLatestReplaceOutcome(runtime, orderId, {
          kind: 'TERMINAL_CONFIRMED',
          terminalState: {
            kind: 'TERMINAL',
            closedReason: 'CANCELED',
            executedPrice: null,
            executedQuantity: 0,
            executedTimeMs: Date.now(),
            status: OrderStatus.Canceled,
          },
        });
      },
      settleOrder: (params) => {
        settlementCalls.push({
          orderId: params.orderId,
          closedReason: params.closedReason,
        });
        return {
          handled: true,
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(settlementCalls).toEqual([
      {
        orderId: 'SELL-REPLACE-TERMINAL',
        closedReason: 'CANCELED',
      },
    ]);
    expect(runtime.latestReplaceOutcomeByOrderId.has('SELL-REPLACE-TERMINAL')).toBe(false);
  });

  it('买单 timeout 在 cancel 返回 ALREADY_CLOSED 时会立即结算', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-TIMEOUT-ALREADY-CLOSED',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    ]);

    runtime.queriedTerminalStateByOrderId.set('BUY-TIMEOUT-ALREADY-CLOSED', {
      kind: 'TERMINAL',
      closedReason: 'CANCELED',
      executedPrice: null,
      executedQuantity: 0,
      executedTimeMs: Date.now(),
      status: OrderStatus.Canceled,
    });
    const settlementCalls: Array<{ readonly orderId: string; readonly closedReason: string }> = [];
    const { deps } = createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        source: 'API_ERROR',
        relatedBuyOrderIds: null,
      }),
      settleOrder: (params) => {
        settlementCalls.push({
          orderId: params.orderId,
          closedReason: params.closedReason,
        });
        return {
          handled: true,
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(settlementCalls).toEqual([
      {
        orderId: 'BUY-TIMEOUT-ALREADY-CLOSED',
        closedReason: 'CANCELED',
      },
    ]);
  });

  it('route generation 已推进时，旧的 timeout->market continuation 不会再提交 MO', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-STALE-CONVERT',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: 0,
          executedTimeMs: Date.parse('2026-04-08T09:00:01.000Z'),
        },
      }),
    ]);

    const tradeCtx = createTradeContextMock();
    const deferredThrottle = createDeferredValue<null>();
    const trackedOrders: TrackOrderParams[] = [];
    const { deps } = createDeps({
      runtime,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: {
        throttle: async () => {
          await deferredThrottle.promise;
        },
      },
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
      settleOrder: () => {
        runtime.trackedOrders.delete('SELL-STALE-CONVERT');
        runtime.trackedOrderLifecycles.set('SELL-STALE-CONVERT', 'CLOSED');
        runtime.closedOrderIds.add('SELL-STALE-CONVERT');
        runtime.trackedOrderIdsBySymbol.delete('BULL.HK');
        runtime.routeStatesBySymbol.delete('BULL.HK');

        const nextOrder = createTrackedOrder({
          orderId: 'SELL-NEWER-GENERATION',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: Date.now(),
        });
        runtime.trackedOrders.set(nextOrder.orderId, nextOrder);
        runtime.trackedOrderLifecycles.set(nextOrder.orderId, 'OPEN');
        runtime.trackedOrderIdsBySymbol.set('BULL.HK', new Set([nextOrder.orderId]));
        runtime.routeStatesBySymbol.set('BULL.HK', {
          symbol: 'BULL.HK',
          generation: 2,
          inFlight: false,
          dirty: false,
          latestQuote: null,
          pendingWakeupKind: null,
          timerHandles: new Map(),
        });
        runtime.latestRouteGenerationBySymbol.set('BULL.HK', 2);

        return {
          handled: true,
          relatedBuyOrderIds: ['BUY-1'],
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    deferredThrottle.resolve(null);
    await processPromise;

    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrders).toEqual([]);
  });
});
