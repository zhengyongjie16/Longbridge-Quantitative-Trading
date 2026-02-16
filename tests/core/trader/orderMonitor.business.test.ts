import { describe, expect, it } from 'bun:test';
import {
  OrderSide,
  OrderStatus,
  OrderType,
  TopicType,
  type PushOrderChanged,
  type TradeContext,
} from 'longport';
import { createOrderMonitor } from '../../../src/core/trader/orderMonitor.js';
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

function createDeps(params?: {
  readonly sellTimeoutSeconds?: number;
  readonly buyTimeoutSeconds?: number;
  readonly gateOpen?: () => boolean;
  readonly onHandleOrderChanged?: (handler: (event: PushOrderChanged) => void) => void;
}): { deps: OrderMonitorDeps; tradeCtx: ReturnType<typeof createTradeContextMock> } {
  const tradeCtx = createTradeContextMock();
  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: 'HSI.HK',
    longSeat: {
      symbol: 'BULL.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });

  const orderRecorder = createOrderRecorderDouble({
    allocateRelatedBuyOrderIdsForRecovery: () => ['BUY-1'],
    markSellCancelled: (orderId: string) => ({
      orderId,
      symbol: 'BULL.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      filledQuantity: 0,
      relatedBuyOrderIds: ['BUY-1'],
      status: 'cancelled',
      submittedAt: Date.now(),
    }),
  });

  const tradingConfig = createTradingConfig({
    global: {
      ...createTradingConfig().global,
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
      markOrderFilled: () => {},
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

describe('orderMonitor business flow', () => {
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

    await monitor.processWithLatestQuotes(new Map([
      ['BULL.HK', createQuoteDouble('BULL.HK', 1.02)],
    ]));

    const cancelCalls = tradeCtx.getCalls('cancelOrder');
    const submitCalls = tradeCtx.getCalls('submitOrder');

    expect(cancelCalls).toHaveLength(1);
    expect(submitCalls).toHaveLength(1);

    const submitPayload = submitCalls[0]?.args[0] as { readonly orderType: OrderType };
    expect(submitPayload.orderType).toBe(OrderType.MO);
    expect(monitor.getPendingSellOrders('BULL.HK').length).toBeGreaterThan(0);
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

    await monitor.processWithLatestQuotes(new Map([
      ['BULL.HK', createQuoteDouble('BULL.HK', 1.02)],
    ]));

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

    await monitor.processWithLatestQuotes(new Map([
      ['BULL.HK', createQuoteDouble('BULL.HK', 1.02)],
    ]));

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);

    gateOpen = true;
  });

  it('does not replace orders when status/type is non-replaceable', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = () => {
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

    handleOrderChanged(createPushOrderChanged({
      orderId: 'SELL-003',
      symbol: 'BULL.HK',
      status: OrderStatus.WaitToReplace,
      side: OrderSide.Sell,
      orderType: OrderType.MO,
      submittedPrice: 1,
      submittedQuantity: 100,
      executedQuantity: 0,
      executedPrice: 0,
    }));

    await monitor.processWithLatestQuotes(new Map([
      ['BULL.HK', createQuoteDouble('BULL.HK', 1.1)],
    ]));

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
  });
});
