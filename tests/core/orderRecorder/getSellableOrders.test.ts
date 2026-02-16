/**
 * getSellableOrders / getProfitableSellOrders 单元测试
 *
 * 测试 OrderStorage 中可卖出订单的核心逻辑：
 * - includeAll=false: 仅返回买入价 < 当前价的订单
 * - includeAll=true: 返回全部订单
 * - 防重过滤（排除待成交卖出占用的订单）
 * - 整笔截断（maxSellQuantity 限制）
 * - getProfitableSellOrders 委托关系
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- mock.module 在 bun:test 中是同步的
mock.module('../../../src/utils/logger/index.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { createOrderStorage } from '../../../src/core/orderRecorder/orderStorage.js';
import type { OrderRecord } from '../../../src/types/services.js';
import type { OrderStorage } from '../../../src/core/orderRecorder/types.js';

function makeOrder(
  orderId: string,
  price: number,
  quantity: number,
  symbol = 'TEST.HK',
  time = Date.now(),
): OrderRecord {
  return {
    orderId,
    symbol,
    executedPrice: price,
    executedQuantity: quantity,
    executedTime: time,
    submittedAt: undefined,
    updatedAt: undefined,
  };
}

describe('getSellableOrders', () => {
  let storage: OrderStorage;

  beforeEach(() => {
    storage = createOrderStorage();
  });

  // ========== 基础场景 ==========

  it('无订单时返回空结果', () => {
    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1);
    expect(result.orders).toHaveLength(0);
    expect(result.totalQuantity).toBe(0);
  });

  it('includeAll=false 仅返回买入价 < 当前价的订单', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100),
      makeOrder('O2', 1.2, 100),
      makeOrder('O3', 0.8, 100),
    ]);

    // 当前价 1.1，只有 O1(1) 和 O3(0.8) 低于当前价
    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1.1);
    expect(result.orders).toHaveLength(2);
    expect(result.totalQuantity).toBe(200);

    const ids = result.orders.map((o) => o.orderId);
    expect(ids).toContain('O1');
    expect(ids).toContain('O3');
  });

  it('includeAll=true 返回全部订单', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100),
      makeOrder('O2', 1.2, 100),
      makeOrder('O3', 0.8, 100),
    ]);

    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1.1, undefined, { includeAll: true });
    expect(result.orders).toHaveLength(3);
    expect(result.totalQuantity).toBe(300);
  });

  it('当前价等于买入价时该订单不被选中（includeAll=false）', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100),
    ]);

    // 当前价 = 买入价 = 1，不满足 < 条件
    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1);
    expect(result.orders).toHaveLength(0);
    expect(result.totalQuantity).toBe(0);
  });

  // ========== 防重过滤 ==========

  it('排除被待成交卖出订单占用的订单', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100),
      makeOrder('O2', 0.9, 100),
    ]);

    // 添加一个待成交卖出，占用 O1
    storage.addPendingSell({
      orderId: 'SELL1',
      symbol: 'TEST.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: ['O1'],
      submittedAt: Date.now(),
    });

    // 当前价 1.1，O1 和 O2 都低于当前价，但 O1 被占用
    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1.1);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]!.orderId).toBe('O2');
    expect(result.totalQuantity).toBe(100);
  });

  it('includeAll=true 时也排除被占用的订单', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100),
      makeOrder('O2', 1.2, 100),
      makeOrder('O3', 0.8, 100),
    ]);

    storage.addPendingSell({
      orderId: 'SELL1',
      symbol: 'TEST.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: ['O2'],
      submittedAt: Date.now(),
    });

    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1.1, undefined, { includeAll: true });
    expect(result.orders).toHaveLength(2);
    expect(result.totalQuantity).toBe(200);

    const ids = result.orders.map((o) => o.orderId);
    expect(ids).not.toContain('O2');
  });

  it('所有订单都被占用时返回空结果', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100),
    ]);

    storage.addPendingSell({
      orderId: 'SELL1',
      symbol: 'TEST.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: ['O1'],
      submittedAt: Date.now(),
    });

    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1.5, undefined, { includeAll: true });
    expect(result.orders).toHaveLength(0);
    expect(result.totalQuantity).toBe(0);
  });

  it('待成交卖出取消后订单恢复可用', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100),
    ]);

    storage.addPendingSell({
      orderId: 'SELL1',
      symbol: 'TEST.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: ['O1'],
      submittedAt: Date.now(),
    });

    // 取消后 O1 恢复可用
    storage.markSellCancelled('SELL1');

    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1.5);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]!.orderId).toBe('O1');
  });

  // ========== 整笔截断 ==========

  it('maxSellQuantity 限制时按低价优先整笔选单', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100, 'TEST.HK', 1000),
      makeOrder('O2', 0.8, 100, 'TEST.HK', 2000),
      makeOrder('O3', 0.9, 100, 'TEST.HK', 3000),
    ]);

    // 当前价 1.5，全部低于当前价，但限制最多卖 200
    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1.5, 200);

    // 按低价优先: O2(0.8) → O3(0.9) → O1(1)，选前两个 = 200
    expect(result.totalQuantity).toBe(200);
    expect(result.orders).toHaveLength(2);

    const ids = result.orders.map((o) => o.orderId);
    expect(ids).toContain('O2');
    expect(ids).toContain('O3');
  });

  it('整笔截断不拆分订单', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 0.8, 150, 'TEST.HK', 1000),
      makeOrder('O2', 0.9, 100, 'TEST.HK', 2000),
    ]);

    // 限制 200，O1=150 选入后剩余 50，O2=100 > 50 跳过
    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1.5, 200);
    expect(result.totalQuantity).toBe(150);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]!.orderId).toBe('O1');
  });

  it('maxSellQuantity 恰好等于总量时返回全部', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100),
      makeOrder('O2', 0.9, 100),
    ]);

    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1.5, 200);
    expect(result.totalQuantity).toBe(200);
    expect(result.orders).toHaveLength(2);
  });

  it('maxSellQuantity 大于总量时返回全部', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100),
    ]);

    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1.5, 500);
    expect(result.totalQuantity).toBe(100);
    expect(result.orders).toHaveLength(1);
  });

  it('includeAll=true 配合 maxSellQuantity 截断', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 1, 100, 'TEST.HK', 1000),
      makeOrder('O2', 1.5, 100, 'TEST.HK', 2000),
      makeOrder('O3', 0.8, 100, 'TEST.HK', 3000),
    ]);

    // includeAll=true 取全部，但限制 200
    const result = storage.getSellableOrders('TEST.HK', 'LONG', 0.5, 200, { includeAll: true });
    expect(result.totalQuantity).toBe(200);

    // 低价优先: O3(0.8) → O1(1)
    const ids = result.orders.map((o) => o.orderId);
    expect(ids).toContain('O3');
    expect(ids).toContain('O1');
  });

  // ========== 做空方向 ==========

  it('做空方向正确获取可卖出订单', () => {
    storage.setBuyOrdersListForShort('TEST.HK', [
      makeOrder('O1', 1, 100),
      makeOrder('O2', 1.5, 100),
    ]);

    // 做空方向，当前价 1.2，O1(1) < 1.2
    const result = storage.getSellableOrders('TEST.HK', 'SHORT', 1.2);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]!.orderId).toBe('O1');
  });

  // ========== 防重 + 截断组合 ==========

  it('防重过滤后再进行整笔截断', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', 0.8, 100, 'TEST.HK', 1000),
      makeOrder('O2', 0.9, 100, 'TEST.HK', 2000),
      makeOrder('O3', 1, 100, 'TEST.HK', 3000),
    ]);

    // O1 被占用
    storage.addPendingSell({
      orderId: 'SELL1',
      symbol: 'TEST.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: ['O1'],
      submittedAt: Date.now(),
    });

    // 当前价 1.5，限制 100
    // 可用: O2(0.9), O3(1)，低价优先选 O2
    const result = storage.getSellableOrders('TEST.HK', 'LONG', 1.5, 100);
    expect(result.totalQuantity).toBe(100);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]!.orderId).toBe('O2');
  });
});


