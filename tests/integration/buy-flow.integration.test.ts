/**
 * @module tests/integration/buy-flow.integration.test.ts
 * @description 测试模块，围绕 buy-flow.integration.test.ts 场景验证 tests/integration 相关业务行为与边界条件。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderType, TimeInForceType, type TradeContext } from 'longport';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createOrderExecutor } from '../../src/core/trader/orderExecutor.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createTradeContextMock } from '../../mock/longport/tradeContextMock.js';
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
  it('runs risk pipeline -> order execution and submits expected buy quantity', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordCooldown: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
      },
    });

    const tradeCtx = createTradeContextMock();
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
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const trader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(100000),
      getStockPositions: async () => [],
      canTradeNow: orderExecutor.canTradeNow,
      recordBuyAttempt: orderExecutor.markBuyAttempt,
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
});
