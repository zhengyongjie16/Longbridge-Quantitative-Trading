/**
 * buy-flow 集成测试
 *
 * 功能：
 * - 验证买入流程风险管道与下单执行的端到端场景与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderType, TimeInForceType, type TradeContext } from 'longbridge';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createOrderExecutor } from '../../src/core/trader/orderExecutor/index.js';
import { VERIFICATION } from '../../src/constants/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createAccountSnapshotDouble,
  createDoomsdayProtectionDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';
import type { ExecutableSignal } from '../../src/types/signal.js';

function withMockedNow<T>(nowMs: number, run: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  return run().finally(() => {
    Date.now = originalNow;
  });
}

function createRiskContext(params: {
  readonly trader: ReturnType<typeof createTraderDouble>;
  readonly riskChecker: ReturnType<typeof createRiskCheckerDouble>;
  readonly orderRecorder: ReturnType<typeof createOrderRecorderDouble>;
}) {
  const cachedAccount = createAccountSnapshotDouble(100000);
  const monitorConfig = createTradingConfig().monitors[0];
  if (!monitorConfig) {
    throw new Error('missing monitor config for integration test');
  }

  return {
    trader: params.trader,
    riskChecker: params.riskChecker,
    orderRecorder: params.orderRecorder,
    longQuote: createQuoteDouble('BULL.HK', 5, 100),
    shortQuote: createQuoteDouble('BEAR.HK', 5, 100),
    monitorQuote: createQuoteDouble('HSI.HK', 20000),
    monitorSnapshot: {
      price: 20000,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: { k: 50, d: 50, j: 50 },
      macd: { macd: 0, dif: 0, dea: 0 },
      adx: null,
    },
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    account: cachedAccount,
    positions: [],
    lastState: {
      cachedAccount,
      cachedPositions: [],
      positionCache: createPositionCacheDouble([]),
    },
    currentTime: new Date(),
    isHalfDay: false,
    doomsdayProtection: createDoomsdayProtectionDouble(),
    config: monitorConfig,
  };
}

describe('buy-flow integration', () => {
  it('rejects broker success responses that do not contain a real orderId', async () => {
    const tradingConfig = createTradingConfig();
    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    const orderExecutor = createOrderExecutor({
      ctx: {
        submitOrder: async () => ({}),
      } as unknown as TradeContext,
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
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      price: 5,
      lotSize: 100,
      reason: 'missing-order-id-should-fail',
    });

    let missingOrderIdError: unknown = null;
    try {
      await orderExecutor.executeSignals([signal]);
    } catch (error) {
      missingOrderIdError = error;
    }

    expect(missingOrderIdError).toBeInstanceOf(Error);
    expect((missingOrderIdError as Error).message).toContain('orderId');
    expect(trackedOrders).toHaveLength(0);
  });

  it('surfaces local tracking failures after broker submit succeeds', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const orderExecutor = createOrderExecutor({
      ctx: tradeCtx as unknown as TradeContext,
      rateLimiter: {
        throttle: async () => {},
      },
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {
          throw new Error('track failed after submit');
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        }),
        replaceOrderPrice: async () => {},
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      price: 5,
      lotSize: 100,
      reason: 'track-order-failure-should-surface',
    });

    let localSyncError: unknown = null;
    try {
      await orderExecutor.executeSignals([signal]);
    } catch (error) {
      localSyncError = error;
    }

    expect(localSyncError).toBeInstanceOf(Error);
    expect((localSyncError as Error).message).toContain(
      'order submitted but local sync failed: MOCK-000001',
    );
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
  });

  it('skips stale seatVersion at final order execution gate', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    let trackedOrderCount = 0;
    const orderExecutor = createOrderExecutor({
      ctx: tradeCtx as unknown as TradeContext,
      rateLimiter: {
        throttle: async () => {},
      },
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {
          trackedOrderCount += 1;
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        }),
        replaceOrderPrice: async () => {},
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble({ longVersion: 2 }),
      isExecutionAllowed: () => true,
    });

    const staleSignal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        triggerTimeMs: Date.now(),
        price: 5,
        lotSize: 100,
        reason: 'stale-seat-version',
      }),
      seatVersion: 1,
    };

    const result = await orderExecutor.executeSignals([staleSignal]);

    expect(result).toEqual({ submittedCount: 0, submittedOrderIds: [] });
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrderCount).toBe(0);
  });

  it('rejects missing seatVersion at final order execution gate', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    let trackedOrderCount = 0;
    const orderExecutor = createOrderExecutor({
      ctx: tradeCtx as unknown as TradeContext,
      rateLimiter: {
        throttle: async () => {},
      },
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {
          trackedOrderCount += 1;
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        }),
        replaceOrderPrice: async () => {},
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble({ longVersion: 1 }),
      isExecutionAllowed: () => true,
    });
    const { seatVersion: omittedSeatVersion, ...missingSeatVersionSignal } = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      price: 5,
      lotSize: 100,
      reason: 'missing-seat-version',
    });
    void omittedSeatVersion;

    const invalidSignals = [missingSeatVersionSignal] as unknown as ReadonlyArray<ExecutableSignal>;
    const result = await orderExecutor.executeSignals(invalidSignals);

    expect(result).toEqual({ submittedCount: 0, submittedOrderIds: [] });
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrderCount).toBe(0);
  });

  it('runs risk pipeline -> order execution and submits notional-based buy quantity', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });

    const tradeCtx = createTradeContextMock();
    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    const orderExecutor = createOrderExecutor({
      ctx: tradeCtx as unknown as TradeContext,
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
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const trader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(100000),
      getStockPositions: async () => [],
      canTradeNow: orderExecutor.canTradeNow,
    });
    const riskChecker = createRiskCheckerDouble();
    const orderRecorder = createOrderRecorderDouble();

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      price: 5,
      lotSize: 100,
      reason: 'integration-buy',
    });

    const checkedSignals = await signalProcessor.applyRiskChecks(
      [signal],
      createRiskContext({ trader, riskChecker, orderRecorder }),
    );
    const result = await orderExecutor.executeSignals(checkedSignals);

    expect(result.submittedCount).toBe(1);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.side).toBe(OrderSide.Buy);
    expect(trackedOrders[0]?.quantity).toBe(1000);

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0] as {
      readonly orderType: OrderType;
      readonly timeInForce: TimeInForceType;
      readonly side: OrderSide;
      readonly symbol: string;
      readonly submittedQuantity: { readonly toString: () => string };
    };

    expect(payload.orderType).toBe(OrderType.ELO);
    expect(payload.timeInForce).toBe(TimeInForceType.Day);
    expect(payload.side).toBe(OrderSide.Buy);
    expect(payload.symbol).toBe('BULL.HK');
    expect(Number(payload.submittedQuantity.toString())).toBe(1000);
  });

  it('uses explicit signal quantity when valid quantity is provided', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    const orderExecutor = createOrderExecutor({
      ctx: tradeCtx as unknown as TradeContext,
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
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      price: 1,
      lotSize: 100,
      reason: 'integration-buy-explicit-quantity',
    });
    signal = { ...signal, quantity: 200 };

    const result = await orderExecutor.executeSignals([signal]);

    expect(result.submittedCount).toBe(1);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.side).toBe(OrderSide.Buy);
    expect(trackedOrders[0]?.quantity).toBe(200);

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0] as {
      readonly submittedQuantity: { readonly toString: () => string };
    };
    expect(Number(payload.submittedQuantity.toString())).toBe(200);
  });

  it('rejects invalid explicit buy quantity without fallback to targetNotional', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    const orderExecutor = createOrderExecutor({
      ctx: tradeCtx as unknown as TradeContext,
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
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      price: 1,
      lotSize: 100,
      reason: 'integration-buy-invalid-explicit-quantity',
    });
    signal = { ...signal, quantity: 250 };

    const result = await orderExecutor.executeSignals([signal]);

    expect(result.submittedCount).toBe(0);
    expect(trackedOrders).toHaveLength(0);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('blocks the next same-direction buy only after a successful submit', async () => {
    const fixedNow = 1_000_000;
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock({ now: () => fixedNow });
    const orderExecutor = createOrderExecutor({
      ctx: tradeCtx as unknown as TradeContext,
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
        replaceOrderPrice: async () => {},
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const monitorConfig = tradingConfig.monitors[0];
    if (!monitorConfig) {
      throw new Error('missing monitor config for integration test');
    }

    const firstSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      price: 5,
      lotSize: 100,
      reason: 'first-successful-buy',
    });

    await withMockedNow(fixedNow, async () => {
      const firstResult = await orderExecutor.executeSignals([firstSignal]);
      expect(firstResult.submittedCount).toBe(1);
    });

    const secondCheck = await withMockedNow(fixedNow, async () =>
      orderExecutor.canTradeNow('BUYCALL', monitorConfig),
    );

    expect(secondCheck.canTrade).toBe(false);
    expect(secondCheck.waitSeconds).toBe(60);
  });

  it('still blocks the next same-direction buy when submit fails after frequency check passed', async () => {
    const fixedNow = 2_000_000;
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock({ now: () => fixedNow });
    tradeCtx.setFailureRule('submitOrder', {
      failAtCalls: [1],
      errorMessage: 'service unavailable',
    });

    const orderExecutor = createOrderExecutor({
      ctx: tradeCtx as unknown as TradeContext,
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
        replaceOrderPrice: async () => {},
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const monitorConfig = tradingConfig.monitors[0];
    if (!monitorConfig) {
      throw new Error('missing monitor config for integration test');
    }

    const failedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      price: 5,
      lotSize: 100,
      reason: 'failed-submit-buy',
    });

    await withMockedNow(fixedNow, async () => {
      let submitError: unknown = null;
      try {
        await orderExecutor.executeSignals([failedSignal]);
      } catch (error) {
        submitError = error;
      }

      expect(submitError).toBeInstanceOf(Error);
      expect(submitError).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.submitOrder',
      });
      expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
      expect(tradeCtx.getCalls('submitOrder')[0]?.error?.message).toBe('service unavailable');
    });

    const nextCheck = await withMockedNow(fixedNow, async () =>
      orderExecutor.canTradeNow('BUYCALL', monitorConfig),
    );

    expect(nextCheck.canTrade).toBe(false);
    expect(nextCheck.waitSeconds).toBe(60);
  });

  it('blocks the next buy in applyRiskChecks once the previous buy has passed frequency check, regardless of submit success', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });

    const successNow = 3_000_000;
    const successTradeCtx = createTradeContextMock({ now: () => successNow });
    const successOrderExecutor = createOrderExecutor({
      ctx: successTradeCtx as unknown as TradeContext,
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
        replaceOrderPrice: async () => {},
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const successTrader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(100000),
      getStockPositions: async () => [],
      canTradeNow: successOrderExecutor.canTradeNow,
    });
    const successRiskChecker = createRiskCheckerDouble();
    const successOrderRecorder = createOrderRecorderDouble();

    const successfulSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      price: 5,
      lotSize: 100,
      reason: 'successful-buy-before-next-risk-check',
    });

    await withMockedNow(successNow, async () => {
      const checkedSignals = await signalProcessor.applyRiskChecks(
        [successfulSignal],
        createRiskContext({
          trader: successTrader,
          riskChecker: successRiskChecker,
          orderRecorder: successOrderRecorder,
        }),
      );
      expect(checkedSignals).toHaveLength(1);
      const executeResult = await successOrderExecutor.executeSignals(checkedSignals);
      expect(executeResult.submittedCount).toBe(1);
    });

    const blockedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now() + VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000 + 1,
      price: 5,
      lotSize: 100,
      reason: 'should-be-frequency-blocked',
    });

    await withMockedNow(
      successNow + VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000 + 1,
      async () => {
        const blockedResult = await signalProcessor.applyRiskChecks(
          [blockedSignal],
          createRiskContext({
            trader: successTrader,
            riskChecker: successRiskChecker,
            orderRecorder: successOrderRecorder,
          }),
        );
        expect(blockedResult).toHaveLength(0);
        expect(blockedSignal.reason).toBe('should-be-frequency-blocked');
      },
    );

    const failedNow = 4_000_000;
    const failedTradeCtx = createTradeContextMock({ now: () => failedNow });
    failedTradeCtx.setFailureRule('submitOrder', {
      failAtCalls: [1],
      errorMessage: 'service unavailable',
    });

    const failedOrderExecutor = createOrderExecutor({
      ctx: failedTradeCtx as unknown as TradeContext,
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
        replaceOrderPrice: async () => {},
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const failedTrader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(100000),
      getStockPositions: async () => [],
      canTradeNow: failedOrderExecutor.canTradeNow,
    });
    const failedRiskChecker = createRiskCheckerDouble();
    const failedOrderRecorder = createOrderRecorderDouble();

    const firstFailedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      price: 5,
      lotSize: 100,
      reason: 'failed-buy-before-next-risk-check',
    });

    await withMockedNow(failedNow, async () => {
      const checkedSignals = await signalProcessor.applyRiskChecks(
        [firstFailedSignal],
        createRiskContext({
          trader: failedTrader,
          riskChecker: failedRiskChecker,
          orderRecorder: failedOrderRecorder,
        }),
      );
      expect(checkedSignals).toHaveLength(1);
      let submitError: unknown = null;
      try {
        await failedOrderExecutor.executeSignals(checkedSignals);
      } catch (error) {
        submitError = error;
      }

      expect(submitError).toBeInstanceOf(Error);
      expect(submitError).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.submitOrder',
      });
      expect(failedTradeCtx.getCalls('submitOrder')).toHaveLength(1);
      expect(failedTradeCtx.getCalls('submitOrder')[0]?.error?.message).toBe('service unavailable');
    });

    const secondAllowedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now() + VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000 + 1,
      price: 5,
      lotSize: 100,
      reason: 'should-pass-frequency-check-after-failed-submit',
    });

    await withMockedNow(
      failedNow + VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000 + 1,
      async () => {
        const allowedResult = await signalProcessor.applyRiskChecks(
          [secondAllowedSignal],
          createRiskContext({
            trader: failedTrader,
            riskChecker: failedRiskChecker,
            orderRecorder: failedOrderRecorder,
          }),
        );
        expect(allowedResult).toHaveLength(0);
        expect(secondAllowedSignal.reason).toBe('should-pass-frequency-check-after-failed-submit');
      },
    );
  });
});
