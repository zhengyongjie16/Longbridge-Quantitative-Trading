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
} from 'longport';

import { createOrderMonitor } from '../../src/core/trader/orderMonitor.js';
import type { OrderMonitorDeps } from '../../src/core/trader/types.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createPushOrderChanged } from '../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../mock/longport/tradeContextMock.js';
import {
  createLiquidationCooldownTrackerDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

function createDeps(params?: {
  readonly sellTimeoutSeconds?: number;
  readonly buyTimeoutSeconds?: number;
  readonly onHandleOrderChanged?: (handler: (event: PushOrderChanged) => void) => void;
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
    orderRecorder: params?.orderRecorder ?? createOrderRecorderDouble(),
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

  return { deps, tradeCtx };
}

describe('order monitor regression', () => {
  it('does not repeatedly convert the same timed-out sell order to market order', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    monitor.trackOrder({
      orderId: 'SELL-REGR-001',
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

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);

    const pending = monitor.getPendingSellOrders('BULL.HK');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.orderType).toBe(OrderType.MO);
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

    monitor.trackOrder({
      orderId: 'SELL-REGR-002',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    handleOrderChanged(createPushOrderChanged({
      orderId: 'SELL-REGR-002',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      orderType: OrderType.ELO,
      submittedQuantity: 100,
      executedQuantity: 20,
      submittedPrice: 1,
      executedPrice: 1,
    }));

    handleOrderChanged(createPushOrderChanged({
      orderId: 'SELL-REGR-002',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.Canceled,
      orderType: OrderType.ELO,
      submittedQuantity: 100,
      executedQuantity: 20,
      submittedPrice: 1,
      executedPrice: 1,
    }));

    handleOrderChanged(createPushOrderChanged({
      orderId: 'SELL-REGR-002',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.Canceled,
      orderType: OrderType.ELO,
      submittedQuantity: 100,
      executedQuantity: 20,
      submittedPrice: 1,
      executedPrice: 1,
    }));

    expect(partialCount).toBe(1);
    expect(cancelCount).toBe(1);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
  });
});
