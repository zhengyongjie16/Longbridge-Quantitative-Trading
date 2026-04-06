/**
 * api-flaky-recovery 混沌测试
 *
 * 功能：
 * - 验证 API 不稳定时的重试与恢复行为期望。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderType, type TradeContext } from 'longbridge';

import { createOrderMonitor } from '../../src/core/trader/orderMonitor/index.js';
import type { OrderMonitorDeps } from '../../src/core/trader/types.js';

import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createSymbolRegistryDouble,
  createQuoteDouble,
} from '../helpers/testDoubles.js';

function createOrderMonitorDeps(params?: {
  readonly sellTimeoutSeconds?: number;
  readonly orderRecorder?: ReturnType<typeof createOrderRecorderDouble>;
}): { deps: OrderMonitorDeps; tradeCtx: ReturnType<typeof createTradeContextMock> } {
  const tradeCtx = createTradeContextMock();
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
      getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.01, 100)]]),
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
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: () => {},
    },
    tradingConfig: createTradingConfig({
      global: {
        ...createTradingConfig().global,
        buyOrderTimeout: {
          enabled: true,
          timeoutSeconds: 999,
        },
        sellOrderTimeout: {
          enabled: true,
          timeoutSeconds: params?.sellTimeoutSeconds ?? 0,
        },
        orderMonitorPriceUpdateInterval: 0,
      },
    }),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
  };

  return { deps, tradeCtx };
}

describe('chaos: api flaky recovery', () => {
  it('retries timeout cancel after backoff and still waits for WS after cancel succeeds', async () => {
    const orderRecorder = createOrderRecorderDouble({
      markSellCancelled: (orderId) => ({
        orderId,
        symbol: 'BULL.HK',
        direction: 'LONG',
        submittedQuantity: 100,
        filledQuantity: 0,
        relatedBuyOrderIds: ['BUY-001'],
        status: 'cancelled',
        submittedAt: Date.now(),
      }),
    });
    const { deps, tradeCtx } = createOrderMonitorDeps({
      sellTimeoutSeconds: 0,
      orderRecorder,
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'transient cancelOrder failure',
    });

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    monitor.trackOrder({
      orderId: 'SELL-CHAOS-001',
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

    await Bun.sleep(1100);
    await monitor.processWithLatestQuotes();

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(2);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });
});
