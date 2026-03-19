/**
 * order-monitor 回归测试
 *
 * 功能：
 * - 验证订单监控回归场景与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import {
  OrderSide,
  OrderStatus,
  OrderType,
  type PushOrderChanged,
  type TradeContext,
} from 'longbridge';

import { createOrderMonitor } from '../../src/core/trader/orderMonitor/index.js';
import type { OrderMonitorDeps } from '../../src/core/trader/types.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createPushOrderChanged } from '../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

function createDeps(params?: {
  readonly sellTimeoutSeconds?: number;
  readonly buyTimeoutSeconds?: number;
  readonly allowBuyOrderTrackingAboveInitialPrice?: boolean;
  readonly onHandleOrderChanged?: (handler: (event: PushOrderChanged) => void) => void;
  readonly orderRecorder?: ReturnType<typeof createOrderRecorderDouble>;
}): {
  deps: OrderMonitorDeps;
  tradeCtx: ReturnType<typeof createTradeContextMock>;
  setQuotes: (quotes: ReadonlyMap<string, ReturnType<typeof createQuoteDouble> | null>) => void;
} {
  const tradeCtx = createTradeContextMock();
  let quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>([
    ['BULL.HK', createQuoteDouble('BULL.HK', 1.02)],
  ]);

  const deps: OrderMonitorDeps = {
    ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
    rateLimiter: {
      throttle: async () => {},
    },
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => [],
    },
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => new Map(quotes),
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
      clear: () => {},
    },
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    tradingConfig: createTradingConfig({
      global: {
        ...createTradingConfig().global,
        buyOrderTimeout: {
          enabled: true,
          timeoutSeconds: params?.buyTimeoutSeconds ?? 999,
        },
        sellOrderTimeout: {
          enabled: true,
          timeoutSeconds: params?.sellTimeoutSeconds ?? 999,
        },
        orderMonitorPriceUpdateInterval: 0,
        allowBuyOrderTrackingAboveInitialPrice:
          params?.allowBuyOrderTrackingAboveInitialPrice ?? true,
      },
    }),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
    ...(params?.onHandleOrderChanged
      ? {
          testHooks: {
            setHandleOrderChanged: params.onHandleOrderChanged,
          },
        }
      : {}),
  };

  return {
    deps,
    tradeCtx,
    setQuotes: (nextQuotes) => {
      quotes = new Map(nextQuotes);
    },
  };
}

describe('order monitor regression', () => {
  it('keeps threshold contract at floating-point boundary', async () => {
    const { deps, tradeCtx, setQuotes } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 0.05 + 0.008)]]));

    monitor.trackOrder({
      orderId: 'SELL-REGR-BOUNDARY-EQUAL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 0.059,
      initialSubmittedPrice: 0.059,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await monitor.processWithLatestQuotes();

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 0.0581)]]));

    monitor.trackOrder({
      orderId: 'SELL-REGR-BOUNDARY-LESS',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 0.059,
      initialSubmittedPrice: 0.059,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await monitor.processWithLatestQuotes();

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
  });

  it('blocks buy replace above initial price when chase-above-initial switch is disabled', async () => {
    const { deps, tradeCtx, setQuotes } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
      allowBuyOrderTrackingAboveInitialPrice: false,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 0.51)]]));

    monitor.trackOrder({
      orderId: 'BUY-REGR-CHASE-BLOCK',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 0.5,
      initialSubmittedPrice: 0.5,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await monitor.processWithLatestQuotes();

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
  });

  it('keeps sell replace behavior unchanged when chase-above-initial switch is disabled', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
      allowBuyOrderTrackingAboveInitialPrice: false,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-REGR-CHASE-UNTOUCHED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 0.5,
      initialSubmittedPrice: 0.5,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await monitor.processWithLatestQuotes();

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
  });

  it('does not repeatedly process timeout sells after cancel request succeeds before WS terminal', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-REGR-001',
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

    await monitor.processWithLatestQuotes();
    await monitor.processWithLatestQuotes();

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);

    const pending = monitor.getPendingSellOrders('BULL.HK');
    expect(pending).toHaveLength(1);
  });

  it('releases pending sell tracking once when partial-filled then canceled arrives', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = () => {};
    let partialCount = 0;
    let cancelCount = 0;

    const orderRecorder = createOrderRecorderDouble({
      markSellPartialFilled: () => {
        partialCount += 1;
        return null;
      },
      markSellCancelled: () => {
        cancelCount += 1;
        return null;
      },
    });

    const { deps } = createDeps({
      orderRecorder,
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'SELL-REGR-002',
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

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-REGR-002',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        submittedQuantity: 100,
        executedQuantity: 20,
        submittedPrice: 1,
        executedPrice: 1,
      }),
    );

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-REGR-002',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedQuantity: 100,
        executedQuantity: 20,
        submittedPrice: 1,
        executedPrice: 1,
      }),
    );

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-REGR-002',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedQuantity: 100,
        executedQuantity: 20,
        submittedPrice: 1,
        executedPrice: 1,
      }),
    );

    expect(partialCount).toBe(1);
    expect(cancelCount).toBe(1);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
  });

  it('releases pending sell tracking once when partial-filled then rejected arrives', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = () => {};
    let partialCount = 0;
    let cancelCount = 0;

    const orderRecorder = createOrderRecorderDouble({
      markSellPartialFilled: () => {
        partialCount += 1;
        return null;
      },
      markSellCancelled: () => {
        cancelCount += 1;
        return null;
      },
    });

    const { deps } = createDeps({
      orderRecorder,
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'SELL-REGR-REJECTED',
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

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-REGR-REJECTED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        submittedQuantity: 100,
        executedQuantity: 20,
        submittedPrice: 1,
        executedPrice: 1,
      }),
    );

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-REGR-REJECTED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Rejected,
        orderType: OrderType.ELO,
        submittedQuantity: 100,
        executedQuantity: 20,
        submittedPrice: 1,
        executedPrice: 1,
      }),
    );

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-REGR-REJECTED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Rejected,
        orderType: OrderType.ELO,
        submittedQuantity: 100,
        executedQuantity: 20,
        submittedPrice: 1,
        executedPrice: 1,
      }),
    );

    expect(partialCount).toBe(1);
    expect(cancelCount).toBe(1);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
  });
});
