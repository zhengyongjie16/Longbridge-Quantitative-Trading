/**
 * getCostAveragePrice 单元测试
 *
 * 测试 OrderStorage 中成本均价的实时计算逻辑：
 * - 空订单 → null
 * - 单笔订单 → 该订单价格
 * - 多笔订单 → 加权平均价
 * - 无效数据过滤
 * - 买入/卖出/清空后成本均价更新
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock logger 避免测试输出噪音
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
  time = Date.now(),
): OrderRecord {
  return {
    orderId,
    symbol: 'TEST.HK',
    executedPrice: price,
    executedQuantity: quantity,
    executedTime: time,
    submittedAt: undefined,
    updatedAt: undefined,
  };
}

describe('getCostAveragePrice', () => {
  let storage: OrderStorage;

  beforeEach(() => {
    storage = createOrderStorage();
  });

  // ========== 基础场景 ==========

  it('无订单时返回 null', () => {
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeNull();
  });

  it('无订单时做空方向也返回 null', () => {
    expect(storage.getCostAveragePrice('TEST.HK', false)).toBeNull();
  });

  it('单笔订单返回该订单价格', () => {
    const orders = [makeOrder('O1', 1, 100)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    const avg = storage.getCostAveragePrice('TEST.HK', true);
    expect(avg).toBeCloseTo(1, 6);
  });

  it('两笔等量订单返回算术平均', () => {
    const orders = [makeOrder('O1', 1, 100), makeOrder('O2', 1.2, 100)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    const avg = storage.getCostAveragePrice('TEST.HK', true);
    expect(avg).toBeCloseTo(1.1, 6);
  });

  it('多笔不等量订单返回加权平均', () => {
    const orders = [makeOrder('O1', 1, 100), makeOrder('O2', 1.2, 150), makeOrder('O3', 0.9, 50)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    const avg = storage.getCostAveragePrice('TEST.HK', true);
    expect(avg).toBeCloseTo(325 / 300, 6);
  });

  // ========== 做多/做空方向隔离 ==========

  it('做多和做空方向的成本均价互不影响', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [makeOrder('O1', 1, 100)]);
    storage.setBuyOrdersListForShort('TEST.HK', [makeOrder('O2', 2, 100)]);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1, 6);
    expect(storage.getCostAveragePrice('TEST.HK', false)).toBeCloseTo(2, 6);
  });

  // ========== 不同标的隔离 ==========

  it('不同标的的成本均价互不影响', () => {
    storage.setBuyOrdersListForLong('A.HK', [makeOrder('O1', 1, 100)]);
    storage.setBuyOrdersListForLong('B.HK', [makeOrder('O2', 3, 100)]);

    expect(storage.getCostAveragePrice('A.HK', true)).toBeCloseTo(1, 6);
    expect(storage.getCostAveragePrice('B.HK', true)).toBeCloseTo(3, 6);
    expect(storage.getCostAveragePrice('C.HK', true)).toBeNull();
  });

  // ========== 无效数据处理（NaN/Infinity 视为 0，仍计入数量）==========

  it('价格为 0 的订单计入数量但不计入价值（拉低均价）', () => {
    const orders = [makeOrder('O1', 0, 100), makeOrder('O2', 1, 100)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    const avg = storage.getCostAveragePrice('TEST.HK', true);
    expect(avg).toBeCloseTo(0.5, 6);
  });

  it('数量为 0 的订单不影响均价', () => {
    const orders = [makeOrder('O1', 1.5, 0), makeOrder('O2', 1, 200)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    const avg = storage.getCostAveragePrice('TEST.HK', true);
    expect(avg).toBeCloseTo(1, 6);
  });

  it('所有订单价格无效但数量有效时均价为 0', () => {
    const orders = [makeOrder('O1', 0, 100), makeOrder('O2', Number.NaN, 100)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBe(0);
  });

  it('所有订单数量为 0 时返回 null', () => {
    const orders = [makeOrder('O1', 1, 0), makeOrder('O2', 2, 0)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeNull();
  });

  it('NaN 价格的订单被视为价格 0（计入数量）', () => {
    const orders = [makeOrder('O1', Number.NaN, 100), makeOrder('O2', 2, 100)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1, 6);
  });

  it('Infinity 价格的订单被视为价格 0（计入数量）', () => {
    const orders = [makeOrder('O1', Infinity, 100), makeOrder('O2', 1.5, 200)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1, 6);
  });

  // ========== 动态更新场景 ==========

  it('addBuyOrder 后成本均价正确更新', () => {
    storage.addBuyOrder('TEST.HK', 1, 100, true, Date.now());
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1, 6);

    storage.addBuyOrder('TEST.HK', 1.2, 100, true, Date.now());
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.1, 6);
  });

  it('卖出部分后成本均价正确更新', () => {
    storage.addBuyOrder('TEST.HK', 1, 100, true, 1000);
    storage.addBuyOrder('TEST.HK', 1.2, 100, true, 2000);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.1, 6);

    storage.updateAfterSell('TEST.HK', 1.05, 100, true, 3000);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.2, 6);
  });

  it('卖出全部后成本均价为 null', () => {
    storage.addBuyOrder('TEST.HK', 1, 100, true, 1000);
    storage.addBuyOrder('TEST.HK', 1.2, 100, true, 2000);

    storage.updateAfterSell('TEST.HK', 1.1, 200, true, 3000);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeNull();
  });

  it('clearBuyOrders 后成本均价为 null', () => {
    storage.addBuyOrder('TEST.HK', 1, 100, true, 1000);
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1, 6);

    storage.clearBuyOrders('TEST.HK', true);
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeNull();
  });

  it('clearAll 后所有成本均价为 null', () => {
    storage.addBuyOrder('A.HK', 1, 100, true, 1000);
    storage.addBuyOrder('B.HK', 2, 100, false, 1000);

    storage.clearAll();

    expect(storage.getCostAveragePrice('A.HK', true)).toBeNull();
    expect(storage.getCostAveragePrice('B.HK', false)).toBeNull();
  });

  // ========== 边界场景 ==========

  it('成本均价恰好等于某个订单价格', () => {
    const orders = [makeOrder('O1', 1, 100), makeOrder('O2', 1, 100)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1, 6);
  });

  it('极小价格的订单正确计算', () => {
    const orders = [makeOrder('O1', 0.001, 10000), makeOrder('O2', 0.002, 10000)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(0.0015, 6);
  });

  it('大量订单的成本均价计算正确', () => {
    const orders: OrderRecord[] = [];
    for (let i = 0; i < 1000; i++) {
      orders.push(makeOrder(`O${i}`, 1 + i * 0.001, 100));
    }
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    const avg = storage.getCostAveragePrice('TEST.HK', true);
    expect(avg).toBeCloseTo(1.4995, 4);
  });

  it('与 calculateOrderStatistics 的 averagePrice 一致', () => {
    const orders = [makeOrder('O1', 1, 100), makeOrder('O2', 1.2, 150), makeOrder('O3', 0.9, 50)];
    storage.setBuyOrdersListForLong('TEST.HK', orders);

    const avg = storage.getCostAveragePrice('TEST.HK', true);
    expect(avg).toBeCloseTo(325 / 300, 6);
  });
});
