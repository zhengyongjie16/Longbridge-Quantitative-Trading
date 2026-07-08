/**
 * orderCacheManager 业务测试
 *
 * 场景意图：锁定今日订单 API 信任边界，坏结构必须 fail-fast。
 */
import { describe, expect, it } from 'bun:test';
import { Decimal, OrderSide, OrderStatus, OrderType, type TradeContext } from 'longbridge';

import { createOrderCacheManager } from '../../../src/core/trader/orderCacheManager.js';

describe('orderCacheManager business flow', () => {
  it('returns pending orders from valid SDK todayOrders payload', async () => {
    const ctx = {
      todayOrders: async () => [
        {
          orderId: 'order-1',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.New,
          price: new Decimal('1.23'),
          quantity: new Decimal('1000'),
          executedQuantity: new Decimal('0'),
          orderType: OrderType.ELO,
        },
      ],
    } as unknown as TradeContext;

    const orderCacheManager = createOrderCacheManager({
      ctx,
      rateLimiter: {
        throttle: async () => {},
      },
    });

    const orders = await orderCacheManager.getPendingOrders();

    expect(orders).toEqual([
      {
        orderId: 'order-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        submittedPrice: 1.23,
        quantity: 1000,
        executedQuantity: 0,
        status: OrderStatus.New,
        orderType: OrderType.ELO,
      },
    ]);
  });

  it('fails fast when todayOrders contains an invalid order item', async () => {
    const ctx = {
      todayOrders: async () => [
        {
          orderId: 'order-1',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.New,
          price: new Decimal('1.23'),
          quantity: new Decimal('1000'),
          executedQuantity: new Decimal('0'),
          orderType: OrderType.ELO,
        },
        {
          orderId: 'broken-order',
          symbol: 'BULL.HK',
          status: OrderStatus.New,
        },
      ],
    } as unknown as TradeContext;

    const orderCacheManager = createOrderCacheManager({
      ctx,
      rateLimiter: {
        throttle: async () => {},
      },
    });

    let caught: unknown = null;
    try {
      await orderCacheManager.getPendingOrders();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
  });

  it('fails fast when todayOrders item has non-finite numeric payload', async () => {
    const ctx = {
      todayOrders: async () => [
        {
          orderId: 'broken-order',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.New,
          price: {},
          quantity: new Decimal('1000'),
          executedQuantity: new Decimal('0'),
          orderType: OrderType.ELO,
        },
      ],
    } as unknown as TradeContext;

    const orderCacheManager = createOrderCacheManager({
      ctx,
      rateLimiter: {
        throttle: async () => {},
      },
    });

    let caught: unknown = null;
    try {
      await orderCacheManager.getPendingOrders();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
  });
});
