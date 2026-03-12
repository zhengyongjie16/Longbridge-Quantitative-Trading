/**
 * orderApiManager 单元测试
 *
 * 功能：
 * - 验证 history/today 去重时的快照优先级（today 优先、同源按 updatedAt 更晚优先）
 */
import { describe, expect, it } from 'bun:test';
import {
  Decimal,
  OrderSide,
  OrderStatus,
  OrderType,
  type Order,
  type TradeContext,
} from 'longbridge';
import { createOrderAPIManager } from '../../../src/core/orderRecorder/orderApiManager.js';
import { createTradeContextMock } from '../../../mock/longbridge/tradeContextMock.js';

function createSdkOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName?: string;
  readonly remark?: string;
  readonly side: OrderSide;
  readonly status: OrderStatus;
  readonly updatedAt: Date;
}): Order {
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName ?? 'HSI RC SAMPLE',
    side: params.side,
    status: params.status,
    orderType: OrderType.ELO,
    remark: params.remark ?? '',
    price: new Decimal('1'),
    quantity: new Decimal('100'),
    executedPrice: new Decimal('1'),
    executedQuantity: new Decimal('100'),
    submittedAt: new Date('2026-02-25T03:00:00.000Z'),
    updatedAt: params.updatedAt,
  } as unknown as Order;
}

describe('createOrderAPIManager', () => {
  it('prefers today snapshot when history and today share the same orderId', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedHistoryOrders([
      createSdkOrder({
        orderId: 'ORDER-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        updatedAt: new Date('2026-02-25T03:10:00.000Z'),
      }),
    ]);

    tradeCtx.seedTodayOrders([
      createSdkOrder({
        orderId: 'ORDER-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.New,
        updatedAt: new Date('2026-02-25T03:01:00.000Z'),
      }),
    ]);

    const apiManager = createOrderAPIManager({
      ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
      rateLimiter: {
        throttle: async () => {},
      },
    });

    const allOrders = await apiManager.fetchAllOrdersFromAPI(true);
    expect(allOrders).toHaveLength(1);
    expect(allOrders[0]?.status).toBe(OrderStatus.New);
    expect(allOrders[0]?.updatedAt?.toISOString()).toBe('2026-02-25T03:01:00.000Z');
  });

  it('uses newer updatedAt when duplicates come from the same snapshot source', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedHistoryOrders([]);
    tradeCtx.seedTodayOrders([
      createSdkOrder({
        orderId: 'ORDER-2',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        updatedAt: new Date('2026-02-25T03:01:00.000Z'),
      }),
      createSdkOrder({
        orderId: 'ORDER-2',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      }),
    ]);

    const apiManager = createOrderAPIManager({
      ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
      rateLimiter: {
        throttle: async () => {},
      },
    });

    const allOrders = await apiManager.fetchAllOrdersFromAPI(true);
    expect(allOrders).toHaveLength(1);
    expect(allOrders[0]?.status).toBe(OrderStatus.PartialFilled);
    expect(allOrders[0]?.updatedAt?.toISOString()).toBe('2026-02-25T03:05:00.000Z');
  });

  it('maps sdk order remark into raw order snapshot', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedHistoryOrders([]);
    tradeCtx.seedTodayOrders([
      createSdkOrder({
        orderId: 'ORDER-REMARK',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        updatedAt: new Date('2026-02-25T03:01:00.000Z'),
        remark: 'QuantDemo|PL',
      }),
    ]);

    const apiManager = createOrderAPIManager({
      ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
      rateLimiter: {
        throttle: async () => {},
      },
    });

    const allOrders = await apiManager.fetchAllOrdersFromAPI(true);
    expect(allOrders[0]?.remark).toBe('QuantDemo|PL');
  });
});
