/**
 * orderMonitor 业务测试
 *
 * 功能：
 * - 验证订单监控相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import {
  OrderSide,
  OrderStatus,
  OrderType,
  TopicType,
  type PushOrderChanged,
  type TradeContext,
} from 'longport';
import { createOrderMonitor } from '../../../src/core/trader/orderMonitor/index.js';
import type { OrderMonitorDeps } from '../../../src/core/trader/types.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createPushOrderChanged } from '../../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../../mock/longport/tradeContextMock.js';
import {
  createLiquidationCooldownTrackerDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import type { PendingSellInfo, RawOrderFromAPI } from '../../../src/types/services.js';

function createDeps(params?: {
  readonly sellTimeoutSeconds?: number;
  readonly buyTimeoutSeconds?: number;
  readonly gateOpen?: () => boolean;
  readonly onHandleOrderChanged?: (handler: (event: PushOrderChanged) => void) => void;
  readonly allocateRelatedBuyOrderIdsForRecovery?: () => readonly string[];
}): { deps: OrderMonitorDeps; tradeCtx: ReturnType<typeof createTradeContextMock> } {
  const tradeCtx = createTradeContextMock();
  const pendingSellSnapshot = new Map<string, PendingSellInfo>();
  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: 'HSI.HK',
    longSeat: {
      symbol: 'BULL.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatReadyAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatReadyAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });

  const orderRecorder = createOrderRecorderDouble({
    allocateRelatedBuyOrderIdsForRecovery:
      params?.allocateRelatedBuyOrderIdsForRecovery ?? (() => ['BUY-1']),
    submitSellOrder: (
      orderId: string,
      symbol: string,
      direction: 'LONG' | 'SHORT',
      quantity: number,
      relatedBuyOrderIds: readonly string[],
      submittedAtMs?: number,
    ) => {
      pendingSellSnapshot.set(orderId, {
        orderId,
        symbol,
        direction,
        submittedQuantity: quantity,
        filledQuantity: 0,
        relatedBuyOrderIds,
        status: 'pending',
        submittedAt: submittedAtMs ?? Date.now(),
      });
    },
    markSellPartialFilled: (orderId: string, filledQuantity: number) => {
      const current = pendingSellSnapshot.get(orderId);
      if (!current) {
        return null;
      }
      const next: PendingSellInfo = {
        ...current,
        filledQuantity,
        status: filledQuantity >= current.submittedQuantity ? 'filled' : 'partial',
      };
      if (next.status === 'filled') {
        pendingSellSnapshot.delete(orderId);
      } else {
        pendingSellSnapshot.set(orderId, next);
      }
      return next;
    },
    markSellFilled: (orderId: string) => {
      const current = pendingSellSnapshot.get(orderId);
      if (!current) {
        return null;
      }
      const filled: PendingSellInfo = {
        ...current,
        filledQuantity: current.submittedQuantity,
        status: 'filled',
      };
      pendingSellSnapshot.delete(orderId);
      return filled;
    },
    markSellCancelled: (orderId: string) => {
      const current = pendingSellSnapshot.get(orderId);
      if (!current) {
        return null;
      }
      const cancelled: PendingSellInfo = {
        ...current,
        status: 'cancelled',
      };
      pendingSellSnapshot.delete(orderId);
      return cancelled;
    },
    getPendingSellSnapshot: () => [...pendingSellSnapshot.values()],
  });

  const baseConfig = createTradingConfig();
  const baseMonitor = baseConfig.monitors[0];
  if (!baseMonitor) {
    throw new Error('missing monitor config for orderMonitor test');
  }
  const tradingConfig = createTradingConfig({
    monitors: [
      {
        ...baseMonitor,
        orderOwnershipMapping: ['HSI'],
      },
    ],
    global: {
      ...baseConfig.global,
      buyOrderTimeout: {
        enabled: true,
        timeoutSeconds: params?.buyTimeoutSeconds ?? 180,
      },
      sellOrderTimeout: {
        enabled: true,
        timeoutSeconds: params?.sellTimeoutSeconds ?? 180,
      },
      orderMonitorPriceUpdateInterval: 0,
    },
  });

  const deps: OrderMonitorDeps = {
    ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
    rateLimiter: {
      throttle: async () => {},
    },
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => [],
    },
    orderRecorder,
    dailyLossTracker: {
      resetAll: () => {},
      recalculateFromAllOrders: () => {},
      recordFilledOrder: () => {},
      getLossOffset: () => 0,
    },
    orderHoldRegistry: {
      trackOrder: () => {},
      markOrderClosed: () => {},
      seedFromOrders: () => {},
      getHoldSymbols: () => new Set<string>(),
      clear: () => {},
    },
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    tradingConfig,
    symbolRegistry,
    ...(params?.onHandleOrderChanged
      ? {
          testHooks: {
            setHandleOrderChanged: params.onHandleOrderChanged,
          },
        }
      : {}),
    isExecutionAllowed: params?.gateOpen ?? (() => true),
  };

  return {
    deps,
    tradeCtx,
  };
}

function createPendingRecoveryOrder(params: Partial<RawOrderFromAPI>): RawOrderFromAPI {
  return {
    orderId: params.orderId ?? 'RECOVER-ORDER',
    symbol: params.symbol ?? 'BULL.HK',
    stockName: params.stockName ?? 'HSI RC SAMPLE',
    side: params.side ?? OrderSide.Buy,
    status: params.status ?? OrderStatus.New,
    orderType: params.orderType ?? OrderType.ELO,
    price: params.price ?? 1,
    quantity: params.quantity ?? 100,
    executedPrice: params.executedPrice ?? 0,
    executedQuantity: params.executedQuantity ?? 0,
    submittedAt: params.submittedAt ?? new Date('2026-02-25T03:00:00.000Z'),
    updatedAt: params.updatedAt ?? new Date('2026-02-25T03:00:10.000Z'),
  };
}

async function executeReplaceScenario(params: {
  readonly initialPrice: number;
  readonly quotePrice: number;
  readonly processTimes?: number;
}): Promise<{
  readonly replaceCalls: number;
  readonly submittedPrice: number | null;
}> {
  const { deps, tradeCtx } = createDeps({
    sellTimeoutSeconds: 999,
    buyTimeoutSeconds: 999,
  });
  const monitor = createOrderMonitor(deps);
  await monitor.initialize();

  monitor.trackOrder({
    orderId: 'SELL-PRICE-DIFF-CASE',
    symbol: 'BULL.HK',
    side: OrderSide.Sell,
    price: params.initialPrice,
    quantity: 100,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: false,
    orderType: OrderType.ELO,
  });

  const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', params.quotePrice)]]);
  const processTimes = params.processTimes ?? 1;
  for (let index = 0; index < processTimes; index += 1) {
    await monitor.processWithLatestQuotes(quotes);
  }

  const pendingOrders = monitor.getPendingSellOrders('BULL.HK');
  return {
    replaceCalls: tradeCtx.getCalls('replaceOrder').length,
    submittedPrice: pendingOrders[0]?.submittedPrice ?? null,
  };
}

describe('orderMonitor business flow', () => {
  it('replaces order when price diff equals threshold on downward move', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.059,
      quotePrice: 0.058,
    });

    expect(result.replaceCalls).toBe(1);
    expect(result.submittedPrice).toBe(0.058);
  });

  it('replaces order when price diff equals threshold on upward move', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.058,
      quotePrice: 0.059,
    });

    expect(result.replaceCalls).toBe(1);
    expect(result.submittedPrice).toBe(0.059);
  });

  it('does not replace order when price diff is lower than threshold', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.059,
      quotePrice: 0.0581,
    });

    expect(result.replaceCalls).toBe(0);
    expect(result.submittedPrice).toBe(0.059);
  });

  it('replaces order when price diff is greater than threshold', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.059,
      quotePrice: 0.057,
    });

    expect(result.replaceCalls).toBe(1);
    expect(result.submittedPrice).toBe(0.057);
  });

  it('does not repeatedly replace when quote price does not change', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.058,
      quotePrice: 0.058,
      processTimes: 2,
    });

    expect(result.replaceCalls).toBe(0);
    expect(result.submittedPrice).toBe(0.058);
  });

  it('normalizes tracked submitted price after replace', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.059,
      quotePrice: 0.05 + 0.008,
    });

    expect(result.replaceCalls).toBe(1);
    expect(result.submittedPrice).toBe(0.058);
  });

  it('converts timed-out sell order to market order after cancel', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    expect(tradeCtx.getSubscribedTopics().has(TopicType.Private)).toBe(true);

    monitor.trackOrder({
      orderId: 'SELL-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await monitor.processWithLatestQuotes(
      new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
    );

    const cancelCalls = tradeCtx.getCalls('cancelOrder');
    const submitCalls = tradeCtx.getCalls('submitOrder');

    expect(cancelCalls).toHaveLength(1);
    expect(submitCalls).toHaveLength(1);

    const submitPayload = submitCalls[0]?.args[0] as { readonly orderType: OrderType };
    expect(submitPayload.orderType).toBe(OrderType.MO);
    expect(monitor.getPendingSellOrders('BULL.HK').length).toBeGreaterThan(0);
  });

  it('reuses cancelled pending-sell relatedBuyOrderIds when converting timeout sells to market', async () => {
    let allocateCalls = 0;
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      buyTimeoutSeconds: 999,
      allocateRelatedBuyOrderIdsForRecovery: () => {
        allocateCalls += 1;
        return ['BUY-ALLOC'];
      },
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'SELL-RECOVER-ALLOC',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
      }),
    ]);

    await monitor.processWithLatestQuotes(
      new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
    );

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
    expect(allocateCalls).toBe(1);
  });

  it('cancels timed-out buy order without market conversion', async () => {
    const { deps, tradeCtx } = createDeps({
      buyTimeoutSeconds: 0,
      sellTimeoutSeconds: 999,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();

    monitor.trackOrder({
      orderId: 'BUY-001',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await monitor.processWithLatestQuotes(
      new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
    );

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('blocks timeout->market conversion when execution gate is closed', async () => {
    let gateOpen = false;
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      gateOpen: () => gateOpen,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();

    monitor.trackOrder({
      orderId: 'SELL-002',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await monitor.processWithLatestQuotes(
      new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
    );

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);

    gateOpen = true;
  });

  it('does not replace orders when status/type is non-replaceable', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();

    monitor.trackOrder({
      orderId: 'SELL-003',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.MO,
    });

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-003',
        symbol: 'BULL.HK',
        status: OrderStatus.WaitToReplace,
        side: OrderSide.Sell,
        orderType: OrderType.MO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
      }),
    );

    await monitor.processWithLatestQuotes(
      new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1)]]),
    );

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
  });

  it('recovers from snapshot without calling todayOrders and cancels mismatched pending buys', async () => {
    const { deps, tradeCtx } = createDeps();
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'BUY-MISMATCH',
        symbol: 'OTHER.HK',
        side: OrderSide.Buy,
        status: OrderStatus.New,
      }),
    ]);

    expect(tradeCtx.getCalls('todayOrders')).toHaveLength(0);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
  });

  it('replays bootstrapping filled events after snapshot recovery', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    const { deps } = createDeps({
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-BOOTSTRAP-FILLED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        executedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:00:20.000Z'),
      }),
    );

    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'SELL-BOOTSTRAP-FILLED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        updatedAt: new Date('2026-02-25T03:00:10.000Z'),
      }),
    ]);

    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
  });

  it('fails fast when pending sell ownership cannot be resolved', async () => {
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    expect(
      monitor.recoverOrderTrackingFromSnapshot([
        createPendingRecoveryOrder({
          orderId: 'SELL-UNRESOLVED',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          stockName: 'UNKNOWN-ORDER-NAME',
          status: OrderStatus.New,
        }),
      ]),
    ).rejects.toThrow(/无法解析归属/);
  });

  it('clears recovered sell runtime state when mismatched buy cancel fails, then allows retry', async () => {
    const { deps, tradeCtx } = createDeps();
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'simulated cancel failure',
    });

    const pendingSell = createPendingRecoveryOrder({
      orderId: 'SELL-RECOVER-FAIL-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.New,
    });
    const mismatchedPendingBuy = createPendingRecoveryOrder({
      orderId: 'BUY-RECOVER-FAIL-001',
      symbol: 'OTHER.HK',
      side: OrderSide.Buy,
      status: OrderStatus.New,
    });

    expect(
      monitor.recoverOrderTrackingFromSnapshot([pendingSell, mismatchedPendingBuy]),
    ).rejects.toThrow(/撤单失败/);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);

    tradeCtx.clearFailureRules();
    await monitor.recoverOrderTrackingFromSnapshot([pendingSell, mismatchedPendingBuy]);

    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(2);
  });

  it('restores submittedAt from snapshot when recovering pending sells', async () => {
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    const submittedAt = new Date('2026-02-25T01:23:45.000Z');
    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'SELL-RESTORE-TIME',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        submittedAt,
      }),
    ]);

    const pending = monitor.getPendingSellOrders('BULL.HK');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.submittedAt).toBe(submittedAt.getTime());
  });

  it('keeps wait-to-replace status from snapshot to avoid replace during recovery window', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'BUY-WAIT-TO-REPLACE',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.WaitToReplace,
        submittedAt: new Date(),
      }),
    ]);

    await monitor.processWithLatestQuotes(
      new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.2)]]),
    );

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
  });
});
