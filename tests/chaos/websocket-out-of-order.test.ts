/**
 * websocket-out-of-order 混沌测试
 *
 * 功能：
 * - 验证 WebSocket 乱序场景下的行为与恢复期望。
 */
import { describe, expect, it } from 'bun:test';
import {
  OrderSide,
  OrderStatus,
  OrderType,
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
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

function createDeps(params?: {
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
    tradingConfig: createTradingConfig(),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
  };

  return { deps, tradeCtx };
}

describe('chaos: websocket out-of-order and duplicate pushes', () => {
  it('keeps sell fill side-effects idempotent under out-of-order/duplicate orderChanged events', async () => {
    let localSellCount = 0;
    let markSellFilledCount = 0;
    let markSellPartialCount = 0;

    const orderRecorder = createOrderRecorderDouble({
      recordLocalSell: () => {
        localSellCount += 1;
      },
      markSellFilled: () => {
        markSellFilledCount += 1;
        return null;
      },
      markSellPartialFilled: () => {
        markSellPartialCount += 1;
        return null;
      },
    });

    const { deps, tradeCtx } = createDeps({ orderRecorder });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();

    monitor.trackOrder({
      orderId: 'WS-CHAOS-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    monitor.trackOrder({
      orderId: 'WS-CHAOS-002',
      symbol: 'BEAR.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: false,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    tradeCtx.emitOrderChanged(createPushOrderChanged({
      orderId: 'WS-CHAOS-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.Filled,
      orderType: OrderType.ELO,
      submittedQuantity: 100,
      executedQuantity: 100,
      submittedPrice: 1,
      executedPrice: 1,
    }), { sequence: 1 });

    tradeCtx.emitOrderChanged(createPushOrderChanged({
      orderId: 'WS-CHAOS-002',
      symbol: 'BEAR.HK',
      side: OrderSide.Sell,
      status: OrderStatus.Filled,
      orderType: OrderType.ELO,
      submittedQuantity: 100,
      executedQuantity: 100,
      submittedPrice: 1,
      executedPrice: 1,
    }), { sequence: 2 });

    // 乱序: 更晚才到达的 PartialFilled，不应回写已完成订单状态。
    tradeCtx.emitOrderChanged(createPushOrderChanged({
      orderId: 'WS-CHAOS-002',
      symbol: 'BEAR.HK',
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      orderType: OrderType.ELO,
      submittedQuantity: 100,
      executedQuantity: 20,
      submittedPrice: 1,
      executedPrice: 1,
    }), { sequence: 3 });

    // 重复 Filled 推送。
    tradeCtx.emitOrderChanged(createPushOrderChanged({
      orderId: 'WS-CHAOS-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.Filled,
      orderType: OrderType.ELO,
      submittedQuantity: 100,
      executedQuantity: 100,
      submittedPrice: 1,
      executedPrice: 1,
    }), { sequence: 4 });

    expect(tradeCtx.flushAllEvents()).toBe(4);
    expect(localSellCount).toBe(2);
    expect(markSellFilledCount).toBe(2);
    expect(markSellPartialCount).toBe(0);

    const pendingRefresh = monitor.getAndClearPendingRefreshSymbols();
    expect(pendingRefresh).toHaveLength(2);
    expect(monitor.getAndClearPendingRefreshSymbols()).toHaveLength(0);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(monitor.getPendingSellOrders('BEAR.HK')).toHaveLength(0);
  });
});
