/**
 * selectSellableOrders 单元测试
 *
 * 功能：
 * - 验证订单筛选策略（ALL / PROFIT_ONLY / TIMEOUT_ONLY）
 * - 验证待成交占用过滤、额外排除与整笔截断
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createOrderStorage } from '../../../src/core/orderRecorder/orderStorage.js';
import type { OrderRecord } from '../../../src/types/services.js';
import type { OrderStorage } from '../../../src/core/orderRecorder/types.js';

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun mock.module 同步注册
mock.module('../../../src/utils/logger/index.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

function makeOrder(
  orderId: string,
  price: number,
  quantity: number,
  executedTime: number,
  symbol = 'TEST.HK',
): OrderRecord {
  return {
    orderId,
    symbol,
    executedPrice: price,
    executedQuantity: quantity,
    executedTime,
    submittedAt: undefined,
    updatedAt: undefined,
  };
}

describe('selectSellableOrders', () => {
  let storage: OrderStorage;

  beforeEach(() => {
    storage = createOrderStorage();
  });

  it('PROFIT_ONLY 仅返回买入价小于当前价的订单', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100, 1),
      makeOrder('O2', 1.2, 100, 2),
      makeOrder('O3', 0.8, 100, 3),
    ]);

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'PROFIT_ONLY',
      currentPrice: 1.1,
    });

    expect(result.totalQuantity).toBe(200);
    expect(result.orders.map((order) => order.orderId)).toEqual(['O3', 'O1']);
  });

  it('ALL 返回全部订单（按卖出优先级排序）', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1.2, 100, 2),
      makeOrder('O2', 0.8, 100, 3),
      makeOrder('O3', 1, 100, 1),
    ]);

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: 1,
    });

    expect(result.totalQuantity).toBe(300);
    expect(result.orders.map((order) => order.orderId)).toEqual(['O2', 'O3', 'O1']);
  });

  it('TIMEOUT_ONLY 在严格交易时段累计超过阈值时返回超时订单', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('OLD', 1, 100, Date.parse('2026-02-24T01:30:00.000Z')),
      makeOrder('NEW', 1, 100, Date.parse('2026-02-24T02:10:00.000Z')),
    ]);

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'TIMEOUT_ONLY',
      currentPrice: 1,
      timeoutMinutes: 60,
      nowMs: Date.parse('2026-02-24T02:31:00.000Z'),
      calendarSnapshot: new Map([
        [
          '2026-02-24',
          {
            isTradingDay: true,
            isHalfDay: false,
          },
        ],
      ]),
    });

    expect(result.totalQuantity).toBe(100);
    expect(result.orders.map((order) => order.orderId)).toEqual(['OLD']);
  });

  it('会排除 pending 占用订单与 excludeOrderIds', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 0.8, 100, 1),
      makeOrder('O2', 0.9, 100, 2),
      makeOrder('O3', 1, 100, 3),
    ]);

    storage.addPendingSell({
      orderId: 'SELL-1',
      symbol: 'TEST.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: ['O1'],
      submittedAt: Date.now(),
    });

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: 1,
      excludeOrderIds: new Set(['O2']),
    });

    expect(result.totalQuantity).toBe(100);
    expect(result.orders.map((order) => order.orderId)).toEqual(['O3']);
  });

  it('maxSellQuantity 触发整笔截断', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 0.8, 150, 1),
      makeOrder('O2', 0.9, 100, 2),
    ]);

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: 1,
      maxSellQuantity: 200,
    });

    expect(result.totalQuantity).toBe(150);
    expect(result.orders.map((order) => order.orderId)).toEqual(['O1']);
  });

  it('SHORT 方向同样适用策略筛选', () => {
    storage.setBuyOrdersListForShort('TEST.HK', [
      makeOrder('S1', 1, 100, 1),
      makeOrder('S2', 1.5, 100, 2),
    ]);

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'SHORT',
      strategy: 'PROFIT_ONLY',
      currentPrice: 1.2,
    });

    expect(result.totalQuantity).toBe(100);
    expect(result.orders.map((order) => order.orderId)).toEqual(['S1']);
  });
});
