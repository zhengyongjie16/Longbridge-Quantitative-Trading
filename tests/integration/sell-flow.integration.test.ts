import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderType, type TradeContext } from 'longport';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createOrderStorage } from '../../src/core/orderRecorder/orderStorage.js';
import { createOrderExecutor } from '../../src/core/trader/orderExecutor.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createTradeContextMock } from '../../mock/longport/tradeContextMock.js';
import { createStockPositionsResponse } from '../../mock/factories/tradeFactory.js';
import {
  createOrderRecorderDouble,
  createPositionDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

describe('sell-flow integration', () => {
  it('runs smart-close sell quantity resolution then submits sell order with capped quantity', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordCooldown: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
      },
    });

    const storage = createOrderStorage();
    storage.addBuyOrder('BULL.HK', 1, 100, true, Date.now() - 1000);
    storage.addBuyOrder('BULL.HK', 1.2, 200, true, Date.now());

    const sellOrderLinks: Array<{ orderId: string; related: readonly string[] }> = [];
    const recorder = createOrderRecorderDouble({
      getCostAveragePrice: (symbol, isLongSymbol) => storage.getCostAveragePrice(symbol, isLongSymbol),
      getSellableOrders: (symbol, direction, currentPrice, maxSellQuantity, options) =>
        storage.getSellableOrders(symbol, direction, currentPrice, maxSellQuantity, options),
      submitSellOrder: (orderId, _symbol, _direction, _quantity, relatedBuyOrderIds) => {
        sellOrderLinks.push({ orderId, related: relatedBuyOrderIds });
      },
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'integration-sell',
    });

    const processed = signalProcessor.processSellSignals(
      [signal],
      createPositionDouble({ symbol: 'BULL.HK', quantity: 300, availableQuantity: 300 }),
      null,
      createQuoteDouble('BULL.HK', 1.05),
      null,
      recorder,
      true,
    );

    expect(processed[0]?.action).toBe('SELLCALL');
    expect(processed[0]?.quantity).toBe(100);
    expect(processed[0]?.relatedBuyOrderIds?.length).toBe(1);

    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    const orderExecutor = createOrderExecutor({
      ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
      rateLimiter: {
        throttle: async () => {},
      },
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, side }) => {
          trackedOrders.push({ orderId, quantity, side });
        },
        cancelOrder: async () => true,
        replaceOrderPrice: async () => {},
        processWithLatestQuotes: async () => {},
        recoverTrackedOrders: async () => {},
        getPendingSellOrders: () => [],
        getAndClearPendingRefreshSymbols: () => [],
        clearTrackedOrders: () => {},
      },
      orderRecorder: recorder,
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const executeResult = await orderExecutor.executeSignals(processed);

    expect(executeResult.submittedCount).toBe(1);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.side).toBe(OrderSide.Sell);
    expect(trackedOrders[0]?.quantity).toBe(100);

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0] as {
      readonly orderType: OrderType;
      readonly side: OrderSide;
      readonly submittedQuantity: { readonly toString: () => string };
    };

    expect(payload.orderType).toBe(OrderType.ELO);
    expect(payload.side).toBe(OrderSide.Sell);
    expect(Number(payload.submittedQuantity.toString())).toBe(100);
    expect(sellOrderLinks[0]?.related.length).toBe(1);
  });
});
