/**
 * sell-flow 集成测试
 *
 * 功能：
 * - 验证卖出流程端到端场景与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType, type TradeContext } from 'longbridge';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createOrderStorage } from '../../src/core/orderRecorder/orderStorage.js';
import { createOrderExecutor } from '../../src/core/trader/orderExecutor/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
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
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        sweepExpired: () => [],
        resetAllTriggerCounts: () => {},
      },
      syncLossOffsetLifecycle: () => {},
    });

    const storage = createOrderStorage();
    storage.addBuyOrder('BULL.HK', 1, 100, true, Date.now() - 1000);
    storage.addBuyOrder('BULL.HK', 1.2, 200, true, Date.now());

    const sellOrderLinks: Array<{ orderId: string; related: readonly string[] }> = [];
    const recorder = createOrderRecorderDouble({
      getCostAveragePrice: (symbol, isLongSymbol) =>
        storage.getCostAveragePrice(symbol, isLongSymbol),
      selectSellableOrders: (params) => storage.selectSellableOrders(params),
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

    const processed = signalProcessor.processSellSignals({
      signals: [signal],
      longPosition: createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
      shortPosition: null,
      longQuote: createQuoteDouble('BULL.HK', 1.05),
      shortQuote: null,
      orderRecorder: recorder,
      smartCloseEnabled: true,
      smartCloseTimeoutMinutes: null,
      nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
      isHalfDay: false,
      tradingCalendarSnapshot: new Map(),
    });

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
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        }),
        replaceOrderPrice: async () => {},
        processWithLatestQuotes: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
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

  it('runs stage2+stage3 with pending occupancy and submits remaining timeout quantity', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        sweepExpired: () => [],
        resetAllTriggerCounts: () => {},
      },
      syncLossOffsetLifecycle: () => {},
    });

    const storage = createOrderStorage();
    storage.addBuyOrder('BULL.HK', 0.9, 100, true, Date.parse('2026-02-24T01:30:00.000Z'));
    storage.addBuyOrder('BULL.HK', 1.2, 100, true, Date.parse('2026-02-24T01:31:00.000Z'));
    storage.addBuyOrder('BULL.HK', 1.3, 100, true, Date.parse('2026-02-24T01:32:00.000Z'));

    const occupiedOrder = storage
      .getBuyOrdersList('BULL.HK', true)
      .find((order) => order.executedPrice === 1.3);
    if (!occupiedOrder) {
      throw new Error('missing occupied order');
    }

    storage.addPendingSell({
      orderId: 'PENDING-1',
      symbol: 'BULL.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: [occupiedOrder.orderId],
      submittedAt: Date.now(),
    });

    const sellOrderLinks: Array<{ orderId: string; related: readonly string[] }> = [];
    const recorder = createOrderRecorderDouble({
      getCostAveragePrice: (symbol, isLongSymbol) =>
        storage.getCostAveragePrice(symbol, isLongSymbol),
      selectSellableOrders: (params) => storage.selectSellableOrders(params),
      submitSellOrder: (orderId, _symbol, _direction, _quantity, relatedBuyOrderIds) => {
        sellOrderLinks.push({ orderId, related: relatedBuyOrderIds });
      },
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'integration-sell-stage3',
    });

    const processed = signalProcessor.processSellSignals({
      signals: [signal],
      longPosition: createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
      shortPosition: null,
      longQuote: createQuoteDouble('BULL.HK', 1.05),
      shortQuote: null,
      orderRecorder: recorder,
      smartCloseEnabled: true,
      smartCloseTimeoutMinutes: 60,
      nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
      isHalfDay: false,
      tradingCalendarSnapshot: new Map([
        ['2026-02-24', { isTradingDay: true, isHalfDay: false }],
        ['2026-02-25', { isTradingDay: true, isHalfDay: false }],
      ]),
    });

    expect(processed[0]?.action).toBe('SELLCALL');
    expect(processed[0]?.quantity).toBe(200);
    expect(processed[0]?.relatedBuyOrderIds?.length).toBe(2);
    expect(processed[0]?.relatedBuyOrderIds).not.toContain(occupiedOrder.orderId);

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
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        }),
        replaceOrderPrice: async () => {},
        processWithLatestQuotes: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
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
    expect(trackedOrders[0]?.quantity).toBe(200);

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0] as {
      readonly orderType: OrderType;
      readonly side: OrderSide;
      readonly submittedQuantity: { readonly toString: () => string };
    };

    expect(payload.orderType).toBe(OrderType.ELO);
    expect(payload.side).toBe(OrderSide.Sell);
    expect(Number(payload.submittedQuantity.toString())).toBe(200);
    expect(sellOrderLinks[0]?.related.length).toBe(2);
  });

  it('supports SELLPUT symmetry with smart-close stage2+stage3 and submits short sell order', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        sweepExpired: () => [],
        resetAllTriggerCounts: () => {},
      },
      syncLossOffsetLifecycle: () => {},
    });

    const storage = createOrderStorage();
    storage.addBuyOrder('BEAR.HK', 0.9, 100, false, Date.parse('2026-02-24T01:30:00.000Z'));
    storage.addBuyOrder('BEAR.HK', 1.2, 100, false, Date.parse('2026-02-24T01:31:00.000Z'));

    const sellOrderLinks: Array<{ orderId: string; related: readonly string[] }> = [];
    const recorder = createOrderRecorderDouble({
      getCostAveragePrice: (symbol, isLongSymbol) =>
        storage.getCostAveragePrice(symbol, isLongSymbol),
      selectSellableOrders: (params) => storage.selectSellableOrders(params),
      submitSellOrder: (orderId, _symbol, _direction, _quantity, relatedBuyOrderIds) => {
        sellOrderLinks.push({ orderId, related: relatedBuyOrderIds });
      },
    });

    const signal = createSignal({
      symbol: 'BEAR.HK',
      action: 'SELLPUT',
      triggerTimeMs: Date.now(),
      reason: 'integration-sellput-stage3',
    });

    const processed = signalProcessor.processSellSignals({
      signals: [signal],
      longPosition: null,
      shortPosition: createPositionDouble({
        symbol: 'BEAR.HK',
        quantity: 200,
        availableQuantity: 200,
      }),
      longQuote: null,
      shortQuote: createQuoteDouble('BEAR.HK', 1.05),
      orderRecorder: recorder,
      smartCloseEnabled: true,
      smartCloseTimeoutMinutes: 60,
      nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
      isHalfDay: false,
      tradingCalendarSnapshot: new Map([
        ['2026-02-24', { isTradingDay: true, isHalfDay: false }],
        ['2026-02-25', { isTradingDay: true, isHalfDay: false }],
      ]),
    });

    expect(processed[0]?.action).toBe('SELLPUT');
    expect(processed[0]?.quantity).toBe(200);
    expect(processed[0]?.relatedBuyOrderIds?.length).toBe(2);

    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BEAR.HK',
        quantity: 200,
        availableQuantity: 200,
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
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        }),
        replaceOrderPrice: async () => {},
        processWithLatestQuotes: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
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
    expect(trackedOrders[0]?.quantity).toBe(200);

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0] as {
      readonly orderType: OrderType;
      readonly side: OrderSide;
      readonly submittedQuantity: { readonly toString: () => string };
    };

    expect(payload.orderType).toBe(OrderType.ELO);
    expect(payload.side).toBe(OrderSide.Sell);
    expect(Number(payload.submittedQuantity.toString())).toBe(200);
    expect(sellOrderLinks[0]?.related.length).toBe(2);
  });

  it('merges pending sell occupancy on REPLACE without releasing original related buy orders', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const replaceCalls: Array<{
      orderId: string;
      price: number;
      quantity: number | null | undefined;
    }> = [];
    const updatedPendingSells: Array<{
      orderId: string;
      submittedQuantity: number;
      relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    const submittedAt = Date.parse('2026-02-25T03:00:00.000Z');

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
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        }),
        replaceOrderPrice: async (orderId, price, quantity) => {
          replaceCalls.push({ orderId, price, quantity });
        },
        processWithLatestQuotes: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-EXISTING',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            orderType: OrderType.ELO,
            submittedPrice: 1,
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt,
          },
        ],
        getAndClearPendingRefreshSymbols: () => [],
        clearTrackedOrders: () => {},
      },
      orderRecorder: createOrderRecorderDouble({
        getPendingSellSnapshot: () => [
          {
            orderId: 'SELL-EXISTING',
            symbol: 'BULL.HK',
            direction: 'LONG',
            submittedQuantity: 100,
            filledQuantity: 0,
            relatedBuyOrderIds: ['BUY-OLD'],
            status: 'pending',
            submittedAt,
          },
        ],
        updatePendingSell: (orderId, params) => {
          updatedPendingSells.push({
            orderId,
            submittedQuantity: params.submittedQuantity,
            relatedBuyOrderIds: params.relatedBuyOrderIds,
          });
          return null;
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      price: 1.02,
      triggerTimeMs: Date.now(),
      reason: 'replace-merge',
    });
    signal.quantity = 50;
    signal.relatedBuyOrderIds = ['BUY-NEW'];

    const result = await orderExecutor.executeSignals([signal]);

    expect(result).toEqual({
      submittedCount: 0,
      submittedOrderIds: [],
    });

    expect(replaceCalls).toEqual([
      {
        orderId: 'SELL-EXISTING',
        price: 1.02,
        quantity: 150,
      },
    ]);

    expect(updatedPendingSells).toEqual([
      {
        orderId: 'SELL-EXISTING',
        submittedQuantity: 150,
        relatedBuyOrderIds: ['BUY-OLD', 'BUY-NEW'],
      },
    ]);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('does not submit merged sell order before cancel reaches confirmed terminal close', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const cancelCalls: string[] = [];
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
        trackOrder: () => {},
        cancelOrder: async (orderId) => {
          cancelCalls.push(orderId);
          return {
            kind: 'CANCEL_CONFIRMED',
            closedReason: 'CANCELED',
            source: 'API',
            relatedBuyOrderIds: ['BUY-OLD'],
          };
        },
        replaceOrderPrice: async () => {},
        processWithLatestQuotes: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-MARKET-EXISTING',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            orderType: OrderType.MO,
            submittedPrice: 1,
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt: Date.parse('2026-02-25T03:00:00.000Z'),
          },
        ],
        getAndClearPendingRefreshSymbols: () => [],
        clearTrackedOrders: () => {},
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      price: 1.03,
      triggerTimeMs: Date.now(),
      reason: 'cancel-and-submit-wait-terminal',
    });
    signal.quantity = 50;
    signal.relatedBuyOrderIds = ['BUY-NEW'];

    const result = await orderExecutor.executeSignals([signal]);

    expect(result).toEqual({
      submittedCount: 0,
      submittedOrderIds: [],
    });
    expect(cancelCalls).toEqual(['SELL-MARKET-EXISTING']);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('carries original related buy orders into CANCEL_AND_SUBMIT merged sell order', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const cancelCalls: string[] = [];
    const trackedOrders: Array<{ orderId: string; quantity: number }> = [];
    const submittedSellLinks: Array<{
      orderId: string;
      quantity: number;
      relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];

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
        trackOrder: ({ orderId, quantity }) => {
          trackedOrders.push({ orderId, quantity });
        },
        cancelOrder: async (orderId) => {
          cancelCalls.push(orderId);
          return {
            kind: 'ALREADY_CLOSED',
            closedReason: 'CANCELED',
            source: 'API_ERROR',
            relatedBuyOrderIds: ['BUY-OLD'],
          };
        },
        replaceOrderPrice: async () => {},
        processWithLatestQuotes: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-MARKET-EXISTING',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            orderType: OrderType.MO,
            submittedPrice: 1,
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt: Date.parse('2026-02-25T03:00:00.000Z'),
          },
        ],
        getAndClearPendingRefreshSymbols: () => [],
        clearTrackedOrders: () => {},
      },
      orderRecorder: createOrderRecorderDouble({
        submitSellOrder: (orderId, _symbol, _direction, quantity, relatedBuyOrderIds) => {
          submittedSellLinks.push({
            orderId,
            quantity,
            relatedBuyOrderIds,
          });
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      price: 1.03,
      triggerTimeMs: Date.now(),
      reason: 'cancel-and-submit-merge',
    });
    signal.quantity = 50;
    signal.relatedBuyOrderIds = ['BUY-NEW'];

    const result = await orderExecutor.executeSignals([signal]);

    expect(result.submittedCount).toBe(1);
    expect(cancelCalls).toEqual(['SELL-MARKET-EXISTING']);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.quantity).toBe(150);
    expect(submittedSellLinks).toHaveLength(1);
    expect(submittedSellLinks[0]?.quantity).toBe(150);
    expect(submittedSellLinks[0]?.relatedBuyOrderIds).toEqual(['BUY-NEW', 'BUY-OLD']);

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0] as {
      readonly submittedQuantity: { readonly toString: () => string };
    };
    expect(Number(payload.submittedQuantity.toString())).toBe(150);
  });
});
