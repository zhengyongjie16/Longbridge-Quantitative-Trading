/**
 * orderMonitor 业务测试
 *
 * 功能：
 * - 验证订单监控相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import {
  OrderSide,
  type Order,
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
import type { OrderRecord, PendingSellInfo, RawOrderFromAPI } from '../../../src/types/services.js';

async function expectPromiseRejectsToMatch(
  operation: () => Promise<unknown>,
  expectedMessagePattern: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw new Error(`[测试] 预期 Promise 以 Error 拒绝，实际为: ${String(error)}`, {
        cause: error,
      });
    }

    expect(error.message).toMatch(expectedMessagePattern);
    return;
  }

  throw new Error('[测试] 预期 Promise 拒绝，但实际成功');
}

function createDeps(params?: {
  readonly sellTimeoutSeconds?: number;
  readonly buyTimeoutSeconds?: number;
  readonly gateOpen?: () => boolean;
  readonly onHandleOrderChanged?: (handler: (event: PushOrderChanged) => void) => void;
  readonly allocateRelatedBuyOrderIdsForRecovery?: () => readonly string[];
  readonly liquidationTriggerLimit?: number;
  readonly liquidationCooldownTrackerOverride?: OrderMonitorDeps['liquidationCooldownTracker'];
  readonly orderRecorderOverride?: OrderMonitorDeps['orderRecorder'];
  readonly dailyLossTrackerOverride?: OrderMonitorDeps['dailyLossTracker'];
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

  const orderRecorder =
    params?.orderRecorderOverride ??
    createOrderRecorderDouble({
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
      updatePendingSell: (orderId, nextPendingSell) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        let status: PendingSellInfo['status'] = 'pending';
        if (current.filledQuantity >= nextPendingSell.submittedQuantity) {
          status = 'filled';
        } else if (current.filledQuantity > 0) {
          status = 'partial';
        }

        const updated: PendingSellInfo = {
          ...current,
          submittedQuantity: nextPendingSell.submittedQuantity,
          relatedBuyOrderIds: [...nextPendingSell.relatedBuyOrderIds],
          status,
        };
        pendingSellSnapshot.set(orderId, updated);
        return updated;
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
        liquidationTriggerLimit: params?.liquidationTriggerLimit ?? 1,
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
    dailyLossTracker:
      params?.dailyLossTrackerOverride ?? {
        resetAll: () => {},
        resetDirectionSegment: () => {},
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
    liquidationCooldownTracker:
      params?.liquidationCooldownTrackerOverride ?? createLiquidationCooldownTrackerDouble(),
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
    remark: params.remark ?? null,
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

  it('waits for WS after timed-out sell cancel request success and does not convert immediately', async () => {
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
    expect(submitCalls).toHaveLength(0);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
    expect(monitor.getPendingSellOrders('BULL.HK')[0]?.orderType).toBe(OrderType.ELO);
  });

  it('does not retry cancel when timed-out sell receives PendingCancel after cancel request success', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-PENDING-CANCEL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]);
    await monitor.processWithLatestQuotes(quotes);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-TIMEOUT-PENDING-CANCEL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PendingCancel,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );
    await monitor.processWithLatestQuotes(quotes);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
  });

  it('does not retry cancel when timed-out buy receives PendingCancel after cancel request success', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    const { deps, tradeCtx } = createDeps({
      buyTimeoutSeconds: 0,
      sellTimeoutSeconds: 999,
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'BUY-TIMEOUT-PENDING-CANCEL',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]);
    await monitor.processWithLatestQuotes(quotes);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'BUY-TIMEOUT-PENDING-CANCEL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PendingCancel,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:12:00.000Z'),
      }),
    );
    await monitor.processWithLatestQuotes(quotes);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
  });

  it('does not retry cancel when timed-out sell receives WaitToCancel after cancel request success', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-WAIT-TO-CANCEL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]);
    await monitor.processWithLatestQuotes(quotes);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-TIMEOUT-WAIT-TO-CANCEL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.WaitToCancel,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:13:00.000Z'),
      }),
    );
    await monitor.processWithLatestQuotes(quotes);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
  });

  it('does not retry cancel when timed-out buy receives WaitToCancel after cancel request success', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    const { deps, tradeCtx } = createDeps({
      buyTimeoutSeconds: 0,
      sellTimeoutSeconds: 999,
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'BUY-TIMEOUT-WAIT-TO-CANCEL',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]);
    await monitor.processWithLatestQuotes(quotes);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'BUY-TIMEOUT-WAIT-TO-CANCEL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.WaitToCancel,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:14:00.000Z'),
      }),
    );
    await monitor.processWithLatestQuotes(quotes);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
  });

  it('keeps protective sell tracked and does not submit market order before WS confirmation', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-TIMEOUT',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
      liquidationTriggerLimit: 3,
    });

    await monitor.processWithLatestQuotes(
      new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
    );

    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
    const pending = monitor.getPendingSellOrders('BULL.HK');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.orderId).toBe('SELL-PROTECTIVE-TIMEOUT');
  });

  it('converts timed-out sell to market order after WS confirms non-filled terminal', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-CONVERT-WS',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]);
    await monitor.processWithLatestQuotes(quotes);

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-TIMEOUT-CONVERT-WS',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );

    await monitor.processWithLatestQuotes(quotes);

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0] as {
      readonly orderType: OrderType;
      readonly side: OrderSide;
      readonly submittedQuantity: { readonly toString: () => string };
    };
    expect(payload.orderType).toBe(OrderType.MO);
    expect(payload.side).toBe(OrderSide.Sell);
    expect(Number(payload.submittedQuantity.toString())).toBe(100);
  });

  it('does not allocate replacement relatedBuyOrderIds when timeout sell cancel request succeeds', async () => {
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
    const allocateCallsBeforeTimeoutProcessing = allocateCalls;

    await monitor.processWithLatestQuotes(
      new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
    );

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
    expect(allocateCalls).toBe(allocateCallsBeforeTimeoutProcessing);
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

  it('recovery keeps strict mode when mismatched buy cancel request succeeds without WS terminal', async () => {
    const { deps, tradeCtx } = createDeps();
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await expectPromiseRejectsToMatch(
      () =>
        monitor.recoverOrderTrackingFromSnapshot([
          createPendingRecoveryOrder({
            orderId: 'BUY-MISMATCH',
            symbol: 'OTHER.HK',
            side: OrderSide.Buy,
            status: OrderStatus.New,
          }),
        ]),
      /终态未确认/,
    );

    expect(tradeCtx.getCalls('todayOrders')).toHaveLength(0);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
  });

  it('recovery blocks when mismatched buy terminal has executed quantity but ownership is unresolved', async () => {
    const { deps, tradeCtx } = createDeps();
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=603001: Order not found',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'BUY-MISMATCH-PARTIAL',
        symbol: 'OTHER.HK',
        stockName: 'UNKNOWN-ORDER-NAME',
        side: OrderSide.Buy,
        status: OrderStatus.PartialWithdrawal,
        quantity: 100,
        executedQuantity: 20,
        executedPrice: 1.02,
      }) as unknown as Order,
    ]);
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await expectPromiseRejectsToMatch(
      () =>
        monitor.recoverOrderTrackingFromSnapshot([
          createPendingRecoveryOrder({
            orderId: 'BUY-MISMATCH-PARTIAL',
            symbol: 'OTHER.HK',
            stockName: 'UNKNOWN-ORDER-NAME',
            side: OrderSide.Buy,
            status: OrderStatus.New,
          }),
        ]),
      /终态已确认但结算失败/,
    );

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
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

  it('restores protective liquidation semantics for recovered pending sells and keeps monitor trigger limit', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    const triggerCalls: Array<{ triggerLimit: number; symbol: string; direction: string }> = [];
    const { deps } = createDeps({
      liquidationTriggerLimit: 3,
      liquidationCooldownTrackerOverride: createLiquidationCooldownTrackerDouble({
        recordLiquidationTrigger: (params) => {
          triggerCalls.push({
            triggerLimit: params.triggerLimit,
            symbol: params.symbol,
            direction: params.direction,
          });
          return {
            currentCount: 1,
            cooldownActivated: false,
          };
        },
      }),
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'SELL-RECOVER-PROTECTIVE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        remark: 'QuantDemo|PL',
      }),
    ]);

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-RECOVER-PROTECTIVE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedPrice: 1,
        executedQuantity: 100,
        updatedAtMs: Date.now(),
      }),
    );

    expect(triggerCalls).toHaveLength(1);
    expect(triggerCalls[0]).toEqual({
      triggerLimit: 3,
      symbol: 'HSI.HK',
      direction: 'LONG',
    });
  });

  it('fails fast when pending sell ownership cannot be resolved', async () => {
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await expectPromiseRejectsToMatch(
      () =>
        monitor.recoverOrderTrackingFromSnapshot([
          createPendingRecoveryOrder({
            orderId: 'SELL-UNRESOLVED',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            stockName: 'UNKNOWN-ORDER-NAME',
            status: OrderStatus.New,
          }),
        ]),
      /无法解析归属/,
    );
  });

  it('clears recovered sell runtime state when mismatched buy cancel fails, and remains strict on later cancel success', async () => {
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

    await expectPromiseRejectsToMatch(
      () => monitor.recoverOrderTrackingFromSnapshot([pendingSell, mismatchedPendingBuy]),
      /撤单失败|终态未确认/,
    );
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);

    tradeCtx.clearFailureRules();
    await expectPromiseRejectsToMatch(
      () => monitor.recoverOrderTrackingFromSnapshot([pendingSell, mismatchedPendingBuy]),
      /终态未确认/,
    );
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
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

  it('does not submit market sell when timeout cancel returns already-filled (601012)', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      buyTimeoutSeconds: 999,
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=601012: Order has been filled',
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-ALREADY-FILLED',
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
  });

  it('records local buy when timeout cancel fails by network error and filled event arrives later', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    let localBuyCount = 0;
    const { deps, tradeCtx } = createDeps({
      buyTimeoutSeconds: 0,
      sellTimeoutSeconds: 999,
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
      orderRecorderOverride: createOrderRecorderDouble({
        recordLocalBuy: () => {
          localBuyCount += 1;
        },
      }),
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'network timeout',
    });

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'BUY-TIMEOUT-NETWORK-FAIL',
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

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'BUY-TIMEOUT-NETWORK-FAIL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedPrice: 1,
        executedQuantity: 100,
      }),
    );

    expect(localBuyCount).toBe(1);
  });

  it('settles filled quantity when sell is canceled after partial fill', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    const pendingSellSnapshot = new Map<string, PendingSellInfo>();
    const buyOrders: ReadonlyArray<OrderRecord> = [
      {
        orderId: 'BUY-1',
        symbol: 'BULL.HK',
        executedPrice: 1,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
        submittedAt: new Date('2026-02-25T03:00:00.000Z'),
        updatedAt: new Date('2026-02-25T03:00:00.000Z'),
      },
      {
        orderId: 'BUY-2',
        symbol: 'BULL.HK',
        executedPrice: 1.2,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
        submittedAt: new Date('2026-02-25T03:05:00.000Z'),
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      },
    ];
    const recordLocalSellCalls: Array<{ relatedBuyOrderIds: ReadonlyArray<string> | null }> = [];
    let dailyLossCalls = 0;
    const orderRecorder = createOrderRecorderDouble({
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

        const updated: PendingSellInfo = {
          ...current,
          filledQuantity,
          status: 'partial',
        };
        pendingSellSnapshot.set(orderId, updated);
        return updated;
      },
      markSellCancelled: (orderId: string) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        pendingSellSnapshot.delete(orderId);
        return {
          ...current,
          status: 'cancelled',
        };
      },
      getBuyOrdersForSymbol: () => buyOrders,
      recordLocalSell: (
        _symbol,
        _executedPrice,
        _executedQuantity,
        _isLongSymbol,
        _executedTimeMs,
        _orderId,
        relatedBuyOrderIds,
      ) => {
        recordLocalSellCalls.push({
          relatedBuyOrderIds: relatedBuyOrderIds ?? null,
        });
      },
    });
    const { deps } = createDeps({
      orderRecorderOverride: orderRecorder,
      dailyLossTrackerOverride: {
        resetAll: () => {},
        resetDirectionSegment: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {
          dailyLossCalls += 1;
        },
        getLossOffset: () => 0,
      },
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    orderRecorder.submitSellOrder('SELL-PARTIAL-CANCELED', 'BULL.HK', 'LONG', 200, [
      'BUY-1',
      'BUY-2',
    ]);

    monitor.trackOrder({
      orderId: 'SELL-PARTIAL-CANCELED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 200,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-CANCELED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 200,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:10:00.000Z'),
      }),
    );

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-CANCELED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 200,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );

    expect(recordLocalSellCalls).toHaveLength(1);
    expect(recordLocalSellCalls[0]?.relatedBuyOrderIds).toEqual(['BUY-1']);
    expect(dailyLossCalls).toBe(1);
    expect(monitor.getAndClearPendingRefreshSymbols()).toEqual([
      {
        symbol: 'BULL.HK',
        isLongSymbol: true,
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);
  });

  it('settles filled quantity when sell is rejected after partial fill', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    const pendingSellSnapshot = new Map<string, PendingSellInfo>();
    const buyOrders: ReadonlyArray<OrderRecord> = [
      {
        orderId: 'BUY-1',
        symbol: 'BULL.HK',
        executedPrice: 1,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
        submittedAt: new Date('2026-02-25T03:00:00.000Z'),
        updatedAt: new Date('2026-02-25T03:00:00.000Z'),
      },
      {
        orderId: 'BUY-2',
        symbol: 'BULL.HK',
        executedPrice: 1.2,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
        submittedAt: new Date('2026-02-25T03:05:00.000Z'),
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      },
    ];
    const recordLocalSellCalls: Array<{ relatedBuyOrderIds: ReadonlyArray<string> | null }> = [];
    let dailyLossCalls = 0;
    const orderRecorder = createOrderRecorderDouble({
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

        const updated: PendingSellInfo = {
          ...current,
          filledQuantity,
          status: 'partial',
        };
        pendingSellSnapshot.set(orderId, updated);
        return updated;
      },
      markSellCancelled: (orderId: string) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        pendingSellSnapshot.delete(orderId);
        return {
          ...current,
          status: 'cancelled',
        };
      },
      getBuyOrdersForSymbol: () => buyOrders,
      recordLocalSell: (
        _symbol,
        _executedPrice,
        _executedQuantity,
        _isLongSymbol,
        _executedTimeMs,
        _orderId,
        relatedBuyOrderIds,
      ) => {
        recordLocalSellCalls.push({
          relatedBuyOrderIds: relatedBuyOrderIds ?? null,
        });
      },
    });
    const { deps } = createDeps({
      orderRecorderOverride: orderRecorder,
      dailyLossTrackerOverride: {
        resetAll: () => {},
        resetDirectionSegment: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {
          dailyLossCalls += 1;
        },
        getLossOffset: () => 0,
      },
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    orderRecorder.submitSellOrder('SELL-PARTIAL-REJECTED', 'BULL.HK', 'LONG', 200, [
      'BUY-1',
      'BUY-2',
    ]);

    monitor.trackOrder({
      orderId: 'SELL-PARTIAL-REJECTED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 200,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-REJECTED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 200,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:10:00.000Z'),
      }),
    );

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-REJECTED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Rejected,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 200,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );

    expect(recordLocalSellCalls).toHaveLength(1);
    expect(recordLocalSellCalls[0]?.relatedBuyOrderIds).toEqual(['BUY-1']);
    expect(dailyLossCalls).toBe(1);
    expect(monitor.getAndClearPendingRefreshSymbols()).toEqual([
      {
        symbol: 'BULL.HK',
        isLongSymbol: true,
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);
  });

  it('falls back to quantity-based local settlement when partial fill cannot be mapped to exact buy orders', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    const pendingSellSnapshot = new Map<string, PendingSellInfo>();
    const buyOrders: ReadonlyArray<OrderRecord> = [
      {
        orderId: 'BUY-A',
        symbol: 'BULL.HK',
        executedPrice: 1,
        executedQuantity: 70,
        executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
        submittedAt: new Date('2026-02-25T03:00:00.000Z'),
        updatedAt: new Date('2026-02-25T03:00:00.000Z'),
      },
      {
        orderId: 'BUY-B',
        symbol: 'BULL.HK',
        executedPrice: 1.2,
        executedQuantity: 70,
        executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
        submittedAt: new Date('2026-02-25T03:05:00.000Z'),
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      },
    ];
    const recordLocalSellCalls: Array<{ relatedBuyOrderIds: ReadonlyArray<string> | null }> = [];
    const orderRecorder = createOrderRecorderDouble({
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

        const updated: PendingSellInfo = {
          ...current,
          filledQuantity,
          status: 'partial',
        };
        pendingSellSnapshot.set(orderId, updated);
        return updated;
      },
      markSellCancelled: (orderId: string) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        pendingSellSnapshot.delete(orderId);
        return {
          ...current,
          status: 'cancelled',
        };
      },
      getBuyOrdersForSymbol: () => buyOrders,
      recordLocalSell: (
        _symbol,
        _executedPrice,
        _executedQuantity,
        _isLongSymbol,
        _executedTimeMs,
        _orderId,
        relatedBuyOrderIds,
      ) => {
        recordLocalSellCalls.push({
          relatedBuyOrderIds: relatedBuyOrderIds ?? null,
        });
      },
    });
    const { deps } = createDeps({
      orderRecorderOverride: orderRecorder,
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    orderRecorder.submitSellOrder('SELL-PARTIAL-FALLBACK', 'BULL.HK', 'LONG', 140, [
      'BUY-A',
      'BUY-B',
    ]);

    monitor.trackOrder({
      orderId: 'SELL-PARTIAL-FALLBACK',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 140,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-FALLBACK',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 140,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:10:00.000Z'),
      }),
    );

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-FALLBACK',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 140,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );

    expect(recordLocalSellCalls).toHaveLength(1);
    expect(recordLocalSellCalls[0]?.relatedBuyOrderIds).toBeNull();
  });

  it('cleans tracked order when cancel returns already-canceled (601011) and orderDetail confirms terminal', async () => {
    const originalNow = Date.now;
    let nowMs = Date.parse('2026-02-25T03:00:00.000Z');
    Date.now = () => nowMs;
    try {
      const { deps, tradeCtx } = createDeps({
        buyTimeoutSeconds: 0,
        sellTimeoutSeconds: 999,
      });
      tradeCtx.setFailureRule('cancelOrder', {
        failAtCalls: [1],
        maxFailures: 1,
        errorMessage: 'openapi error: code=601011: Order has been cancelled',
      });

      tradeCtx.seedTodayOrders([
        createPendingRecoveryOrder({
          orderId: 'BUY-TIMEOUT-601011',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.Canceled,
          quantity: 100,
          executedQuantity: 0,
          executedPrice: 0,
          updatedAt: new Date('2026-02-25T03:00:05.000Z'),
        }) as unknown as Order,
      ]);
      const monitor = createOrderMonitor(deps);
      await monitor.initialize();

      monitor.trackOrder({
        orderId: 'BUY-TIMEOUT-601011',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        price: 1,
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: OrderType.ELO,
      });

      const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]);
      await monitor.processWithLatestQuotes(quotes);
      nowMs += 2_000;
      await monitor.processWithLatestQuotes(quotes);

      expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
    } finally {
      Date.now = originalNow;
    }
  });

  it('marks 602012 as permanently unsupported and skips further replace attempts', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    tradeCtx.setFailureRule('replaceOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=602012: not supported by type',
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    monitor.trackOrder({
      orderId: 'SELL-REPLACE-602012',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1)]]);
    await monitor.processWithLatestQuotes(quotes);
    await monitor.processWithLatestQuotes(quotes);

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
  });

  it('marks 602013 as temporarily blocked and escalates to orderDetail on 5th consecutive hit', async () => {
    const originalNow = Date.now;
    let nowMs = Date.parse('2026-02-25T03:00:00.000Z');
    Date.now = () => nowMs;

    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    tradeCtx.setFailureRule('replaceOrder', {
      failAtCalls: [1, 2, 3, 4, 5],
      maxFailures: 5,
      errorMessage: 'openapi error: code=602013: status does not allow amendment',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'SELL-REPLACE-602013',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PendingReplace,
        quantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
      }) as unknown as Order,
    ]);
    const monitor = createOrderMonitor(deps);
    try {
      await monitor.initialize();

      monitor.trackOrder({
        orderId: 'SELL-REPLACE-602013',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        price: 1,
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: OrderType.ELO,
      });

      const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1)]]);
      await monitor.processWithLatestQuotes(quotes);
      expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);

      nowMs += 1_000;
      await monitor.processWithLatestQuotes(quotes);
      expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(2);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);

      nowMs += 2_000;
      await monitor.processWithLatestQuotes(quotes);
      expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(3);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);

      nowMs += 4_000;
      await monitor.processWithLatestQuotes(quotes);
      expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(4);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);

      nowMs += 8_000;
      await monitor.processWithLatestQuotes(quotes);
      expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(5);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);

      nowMs += 60_000;
      await monitor.processWithLatestQuotes(quotes);
      expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(5);
    } finally {
      Date.now = originalNow;
    }
  });

  it('resets 602013 consecutive counter after ws status progression and re-escalates only after next 5 hits', async () => {
    const originalNow = Date.now;
    let nowMs = Date.parse('2026-02-25T04:00:00.000Z');
    Date.now = () => nowMs;

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
    tradeCtx.setFailureRule('replaceOrder', {
      failAtCalls: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      maxFailures: 10,
      errorMessage: 'openapi error: code=602013: status does not allow amendment',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'SELL-REPLACE-602013-RESET',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PendingReplace,
        quantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
      }) as unknown as Order,
    ]);

    const monitor = createOrderMonitor(deps);
    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);

      monitor.trackOrder({
        orderId: 'SELL-REPLACE-602013-RESET',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        price: 1,
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: OrderType.ELO,
      });

      const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1)]]);

      await monitor.processWithLatestQuotes(quotes);
      nowMs += 1_000;
      await monitor.processWithLatestQuotes(quotes);
      nowMs += 2_000;
      await monitor.processWithLatestQuotes(quotes);
      nowMs += 4_000;
      await monitor.processWithLatestQuotes(quotes);
      nowMs += 8_000;
      await monitor.processWithLatestQuotes(quotes);

      expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(5);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);

      handleOrderChanged(
        createPushOrderChanged({
          orderId: 'SELL-REPLACE-602013-RESET',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.PendingReplace,
          orderType: OrderType.ELO,
          submittedPrice: 1,
          submittedQuantity: 100,
          executedPrice: 0,
          executedQuantity: 0,
        }),
      );

      handleOrderChanged(
        createPushOrderChanged({
          orderId: 'SELL-REPLACE-602013-RESET',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
          submittedPrice: 1,
          submittedQuantity: 100,
          executedPrice: 0,
          executedQuantity: 0,
        }),
      );

      await monitor.processWithLatestQuotes(quotes);
      expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(6);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);

      nowMs += 1_000;
      await monitor.processWithLatestQuotes(quotes);
      nowMs += 2_000;
      await monitor.processWithLatestQuotes(quotes);
      nowMs += 4_000;
      await monitor.processWithLatestQuotes(quotes);
      nowMs += 8_000;
      await monitor.processWithLatestQuotes(quotes);

      expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(10);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(2);
    } finally {
      Date.now = originalNow;
    }
  });

  it('public cancelOrder settles state-checked sell close and returns remaining related buy order ids', async () => {
    const pendingSellSnapshot = new Map<string, PendingSellInfo>();
    const buyOrders: ReadonlyArray<OrderRecord> = [
      {
        orderId: 'BUY-1',
        symbol: 'BULL.HK',
        executedPrice: 1,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
        submittedAt: new Date('2026-02-25T03:00:00.000Z'),
        updatedAt: new Date('2026-02-25T03:00:00.000Z'),
      },
      {
        orderId: 'BUY-2',
        symbol: 'BULL.HK',
        executedPrice: 1.2,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
        submittedAt: new Date('2026-02-25T03:05:00.000Z'),
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      },
    ];
    const recordLocalSellCalls: Array<ReadonlyArray<string> | null> = [];
    const orderRecorder = createOrderRecorderDouble({
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
      markSellCancelled: (orderId: string) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        pendingSellSnapshot.delete(orderId);
        return {
          ...current,
          status: 'cancelled' as const,
        };
      },
      getPendingSellSnapshot: () => [...pendingSellSnapshot.values()],
      getBuyOrdersForSymbol: () => buyOrders,
      recordLocalSell: (
        _symbol,
        _executedPrice,
        _executedQuantity,
        _isLongSymbol,
        _executedTimeMs,
        _orderId,
        relatedBuyOrderIds,
      ) => {
        recordLocalSellCalls.push(relatedBuyOrderIds ?? null);
      },
    });
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: orderRecorder,
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=603001: Order not found',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'SELL-CANCEL-SETTLED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialWithdrawal,
        quantity: 200,
        executedQuantity: 100,
        executedPrice: 1.05,
        updatedAt: new Date('2026-02-25T03:11:00.000Z'),
      }) as unknown as Order,
    ]);

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    orderRecorder.submitSellOrder('SELL-CANCEL-SETTLED', 'BULL.HK', 'LONG', 200, ['BUY-1', 'BUY-2']);
    monitor.trackOrder({
      orderId: 'SELL-CANCEL-SETTLED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 200,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    const outcome = await monitor.cancelOrder('SELL-CANCEL-SETTLED');

    expect(outcome.kind).toBe('ALREADY_CLOSED');
    if (outcome.kind === 'ALREADY_CLOSED') {
      expect(outcome.closedReason).toBe('CANCELED');
      expect(outcome.relatedBuyOrderIds).toEqual(['BUY-2']);
    }

    expect(recordLocalSellCalls).toEqual([['BUY-1']]);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(monitor.getAndClearPendingRefreshSymbols()).toEqual([
      {
        symbol: 'BULL.HK',
        isLongSymbol: true,
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);
  });

  it('public cancelOrder returns already-closed for untracked filled order (601012)', async () => {
    const { deps, tradeCtx } = createDeps();
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=601012: Order has been filled',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'UNTRACKED-601012-FILLED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        quantity: 100,
        executedQuantity: 100,
        executedPrice: 1.03,
      }) as unknown as Order,
    ]);

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    const outcome = await monitor.cancelOrder('UNTRACKED-601012-FILLED');

    expect(outcome.kind).toBe('ALREADY_CLOSED');
    if (outcome.kind === 'ALREADY_CLOSED') {
      expect(outcome.closedReason).toBe('FILLED');
      expect(outcome.relatedBuyOrderIds).toBeNull();
    }

    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
  });

  it('does not enter close sync on 603001 and keeps timeout conversion blocked', async () => {
    let fetchAllOrdersCalls = 0;
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      buyTimeoutSeconds: 999,
      orderRecorderOverride: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => {
          fetchAllOrdersCalls += 1;
          return [
            createPendingRecoveryOrder({
              orderId: 'SELL-NOT-FOUND-CLOSE-SYNC',
              symbol: 'BULL.HK',
              side: OrderSide.Sell,
              status: OrderStatus.Canceled,
              quantity: 100,
              executedQuantity: 0,
              executedPrice: 0,
            }),
          ];
        },
      }),
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=603001: Order not found',
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    monitor.trackOrder({
      orderId: 'SELL-NOT-FOUND-CLOSE-SYNC',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.01)]]);
    await monitor.processWithLatestQuotes(quotes);
    await monitor.processWithLatestQuotes(quotes);

    expect(fetchAllOrdersCalls).toBe(0);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('keeps close sink idempotent when duplicate filled events are received', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    let localBuyCount = 0;
    const { deps } = createDeps({
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
      orderRecorderOverride: createOrderRecorderDouble({
        recordLocalBuy: () => {
          localBuyCount += 1;
        },
      }),
    });

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'BUY-DUP-FILLED',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    const filledEvent = createPushOrderChanged({
      orderId: 'BUY-DUP-FILLED',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      status: OrderStatus.Filled,
      orderType: OrderType.ELO,
      submittedPrice: 1,
      submittedQuantity: 100,
      executedPrice: 1,
      executedQuantity: 100,
      updatedAtMs: Date.now(),
    });
    handleOrderChanged(filledEvent);
    handleOrderChanged(filledEvent);

    expect(localBuyCount).toBe(1);
  });

  it('records executed buy quantity when PartialWithdrawal closes remaining quantity', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('handleOrderChanged hook was not captured');
    };
    let localBuyCount = 0;
    let dailyLossCount = 0;
    const { deps } = createDeps({
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
      orderRecorderOverride: createOrderRecorderDouble({
        recordLocalBuy: () => {
          localBuyCount += 1;
        },
      }),
      dailyLossTrackerOverride: {
        resetAll: () => {},
        resetDirectionSegment: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {
          dailyLossCount += 1;
        },
        getLossOffset: () => 0,
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'BUY-PARTIAL-WITHDRAWAL',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'BUY-PARTIAL-WITHDRAWAL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PartialWithdrawal,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedPrice: 1.01,
        executedQuantity: 20,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );

    expect(localBuyCount).toBe(1);
    expect(dailyLossCount).toBe(1);
    expect(monitor.getAndClearPendingRefreshSymbols()).toEqual([
      {
        symbol: 'BULL.HK',
        isLongSymbol: true,
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);
  });
});
