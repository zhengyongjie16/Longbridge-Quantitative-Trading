/**
 * 成本均价与智能平仓全链路集成测试
 *
 * 验证从买入→成本均价计算→智能平仓决策→卖出后更新→清仓的完整链路：
 * - 场景1: 整体盈利全部卖出
 * - 场景2: 整体未盈利仅卖盈利部分
 * - 场景3: 卖出后成本均价更新
 * - 场景4: 保护性清仓后成本均价归零
 * - 场景5: 防重与整笔截断的端到端验证
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
import { resolveSellQuantityBySmartClose } from '../../../src/core/signalProcessor/utils.js';
import type { OrderRecorder } from '../../../src/types/services.js';
import type { OrderStorage } from '../../../src/core/orderRecorder/types.js';

/**
 * 将 OrderStorage 包装为 resolveSellQuantityBySmartClose 所需的 OrderRecorder 接口
 * 仅实现智能平仓所需的方法
 */
function wrapStorageAsRecorder(storage: OrderStorage): OrderRecorder {
  return {
    getCostAveragePrice: (symbol: string, isLongSymbol: boolean) =>
      storage.getCostAveragePrice(symbol, isLongSymbol),
    getSellableOrders: (
      symbol: string,
      direction: 'LONG' | 'SHORT',
      currentPrice: number,
      maxSellQuantity?: number,
      options?: { readonly includeAll?: boolean },
    ) => storage.getSellableOrders(symbol, direction, currentPrice, maxSellQuantity, options),
    // 以下方法在智能平仓中不会被调用
    recordLocalBuy: () => {},
    recordLocalSell: () => {},
    clearBuyOrders: () => {},
    getLatestBuyOrderPrice: () => null,
    getLatestSellRecord: () => null,
    fetchAllOrdersFromAPI: async () => [],
    refreshOrdersFromAllOrdersForLong: async () => [],
    refreshOrdersFromAllOrdersForShort: async () => [],
    clearOrdersCacheForSymbol: () => {},
    getBuyOrdersForSymbol: () => [],
    submitSellOrder: () => {},
    markSellFilled: () => null,
    markSellPartialFilled: () => null,
    markSellCancelled: () => null,
    allocateRelatedBuyOrderIdsForRecovery: () => [],
    resetAll: () => {},
  };
}

describe('成本均价与智能平仓全链路集成测试', () => {
  let storage: OrderStorage;

  beforeEach(() => {
    storage = createOrderStorage();
  });

  it('场景1: 整体盈利全部卖出', () => {
    // 买入 100 股 @ 1.00，买入 100 股 @ 1.20
    storage.addBuyOrder('TEST.HK', 1, 100, true, 1000);
    storage.addBuyOrder('TEST.HK', 1.2, 100, true, 2000);

    // 成本均价 = (100*1 + 100*1.2) / 200 = 1.10
    const avg = storage.getCostAveragePrice('TEST.HK', true);
    expect(avg).toBeCloseTo(1.1, 6);

    // 当前价 = 1.15 > 1.10 → 整体盈利
    const recorder = wrapStorageAsRecorder(storage);
    const result = resolveSellQuantityBySmartClose({
      orderRecorder: recorder,
      currentPrice: 1.15,
      availableQuantity: 200,
      direction: 'LONG',
      symbol: 'TEST.HK',
    });

    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(200);
    expect(result.relatedBuyOrderIds).toHaveLength(2);
  });

  it('场景2: 整体未盈利仅卖盈利部分', () => {
    // 买入 100 股 @ 1.00，买入 100 股 @ 1.20
    storage.addBuyOrder('TEST.HK', 1, 100, true, 1000);
    storage.addBuyOrder('TEST.HK', 1.2, 100, true, 2000);

    // 成本均价 = 1.10
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.1, 6);

    // 当前价 = 1.05 ≤ 1.10 → 整体未盈利，仅卖出 1.00 的订单
    const recorder = wrapStorageAsRecorder(storage);
    const result = resolveSellQuantityBySmartClose({
      orderRecorder: recorder,
      currentPrice: 1.05,
      availableQuantity: 200,
      direction: 'LONG',
      symbol: 'TEST.HK',
    });

    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(100);
    expect(result.relatedBuyOrderIds).toHaveLength(1);
  });

  it('场景3: 卖出后成本均价更新', () => {
    // 初始：买入 100 股 @ 1.00，买入 100 股 @ 1.20
    storage.addBuyOrder('TEST.HK', 1, 100, true, 1000);
    storage.addBuyOrder('TEST.HK', 1.2, 100, true, 2000);

    // 成本均价 = 1.10
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.1, 6);

    // 卖出 100 股（低价优先消除 1.00 的订单）
    storage.updateAfterSell('TEST.HK', 1.05, 100, true, 3000);

    // 剩余 100 股 @ 1.20，成本均价 = 1.20
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.2, 6);

    // 当前价 1.15 < 1.20 → 整体未盈利，无盈利订单
    const recorder = wrapStorageAsRecorder(storage);
    const result = resolveSellQuantityBySmartClose({
      orderRecorder: recorder,
      currentPrice: 1.15,
      availableQuantity: 100,
      direction: 'LONG',
      symbol: 'TEST.HK',
    });

    expect(result.shouldHold).toBe(true);
    expect(result.quantity).toBeNull();
  });

  it('场景4: 保护性清仓后成本均价归零', () => {
    storage.addBuyOrder('TEST.HK', 1, 100, true, 1000);
    storage.addBuyOrder('TEST.HK', 1.2, 100, true, 2000);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.1, 6);

    // 保护性清仓
    storage.clearBuyOrders('TEST.HK', true);

    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeNull();

    // 智能平仓：无订单，保持持仓
    const recorder = wrapStorageAsRecorder(storage);
    const result = resolveSellQuantityBySmartClose({
      orderRecorder: recorder,
      currentPrice: 1.5,
      availableQuantity: 200,
      direction: 'LONG',
      symbol: 'TEST.HK',
    });

    expect(result.shouldHold).toBe(true);
  });

  it('场景5: 防重端到端验证', () => {
    // 买入 3 笔
    storage.addBuyOrder('TEST.HK', 0.8, 100, true, 1000);
    storage.addBuyOrder('TEST.HK', 1, 100, true, 2000);
    storage.addBuyOrder('TEST.HK', 1.2, 100, true, 3000);

    // 成本均价 = (80+100+120)/300 = 1
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1, 6);

    // 模拟第一笔卖出已提交但未成交（占用 0.8 的订单）
    const orders = storage.getBuyOrdersList('TEST.HK', true);
    const lowestOrder = [...orders].sort((a, b) => a.executedPrice - b.executedPrice)[0];
    storage.addPendingSell({
      orderId: 'SELL_001',
      symbol: 'TEST.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: [lowestOrder!.orderId],
      submittedAt: Date.now(),
    });

    // 当前价 1.5 > 成本均价 1 → 整体盈利，includeAll=true
    // 但 0.8 的订单被占用，只能卖 200
    const recorder = wrapStorageAsRecorder(storage);
    const result = resolveSellQuantityBySmartClose({
      orderRecorder: recorder,
      currentPrice: 1.5,
      availableQuantity: 300,
      direction: 'LONG',
      symbol: 'TEST.HK',
    });

    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(200);
    expect(result.relatedBuyOrderIds).toHaveLength(2);
    expect(result.relatedBuyOrderIds).not.toContain(lowestOrder!.orderId);
  });

  it('场景6: 文档附录示例 - 三笔订单的完整计算', () => {
    // 买入 100 股 @ 1.00, 150 股 @ 1.20, 50 股 @ 0.90
    storage.addBuyOrder('TEST.HK', 1, 100, true, 1000);
    storage.addBuyOrder('TEST.HK', 1.2, 150, true, 2000);
    storage.addBuyOrder('TEST.HK', 0.9, 50, true, 3000);

    // 成本均价 = (100+180+45)/300 = 325/300 = 1.0833...
    const avg = storage.getCostAveragePrice('TEST.HK', true);
    expect(avg).toBeCloseTo(325 / 300, 4);

    // 当前价 = 1.10 > 1.0833 → 全部卖出 300 股
    const recorder = wrapStorageAsRecorder(storage);
    const result1 = resolveSellQuantityBySmartClose({
      orderRecorder: recorder,
      currentPrice: 1.1,
      availableQuantity: 300,
      direction: 'LONG',
      symbol: 'TEST.HK',
    });

    expect(result1.shouldHold).toBe(false);
    expect(result1.quantity).toBe(300);

    // 当前价 = 1.05 ≤ 1.0833 → 仅卖出 1.00 和 0.90 的订单 = 150 股
    const result2 = resolveSellQuantityBySmartClose({
      orderRecorder: recorder,
      currentPrice: 1.05,
      availableQuantity: 300,
      direction: 'LONG',
      symbol: 'TEST.HK',
    });

    expect(result2.shouldHold).toBe(false);
    expect(result2.quantity).toBe(150);
  });

  it('场景7: 连续买入卖出后成本均价持续正确', () => {
    // 第一笔买入
    storage.addBuyOrder('TEST.HK', 1, 100, true, 1000);
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1, 6);

    // 第二笔买入
    storage.addBuyOrder('TEST.HK', 1.4, 100, true, 2000);
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.2, 6);

    // 卖出 100 股（消除 1 的订单）
    storage.updateAfterSell('TEST.HK', 1.3, 100, true, 3000);
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.4, 6);

    // 再买入
    storage.addBuyOrder('TEST.HK', 1, 100, true, 4000);
    // (1.4*100 + 1*100) / 200 = 240/200 = 1.2
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.2, 6);

    // 全部卖出
    storage.updateAfterSell('TEST.HK', 1.3, 200, true, 5000);
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeNull();
  });

  it('场景8: 待成交卖出成交后释放占用', () => {
    storage.addBuyOrder('TEST.HK', 1, 100, true, 1000);
    storage.addBuyOrder('TEST.HK', 0.9, 100, true, 2000);

    const orders = storage.getBuyOrdersList('TEST.HK', true);
    const order1 = orders.find((o) => o.executedPrice === 1);

    // 占用 1 的订单
    storage.addPendingSell({
      orderId: 'SELL_001',
      symbol: 'TEST.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: [order1!.orderId],
      submittedAt: Date.now(),
    });

    // 此时只有 0.9 的订单可用
    const result1 = storage.getSellableOrders('TEST.HK', 'LONG', 1.5, undefined, { includeAll: true });
    expect(result1.totalQuantity).toBe(100);

    // 卖出成交，释放占用
    storage.markSellFilled('SELL_001');

    // 两个订单都可用了
    const result2 = storage.getSellableOrders('TEST.HK', 'LONG', 1.5, undefined, { includeAll: true });
    expect(result2.totalQuantity).toBe(200);
  });

  it('场景9: clearAll 后所有状态重置', () => {
    storage.addBuyOrder('A.HK', 1, 100, true, 1000);
    storage.addBuyOrder('B.HK', 2, 100, false, 1000);

    storage.addPendingSell({
      orderId: 'SELL_001',
      symbol: 'A.HK',
      direction: 'LONG',
      submittedQuantity: 50,
      relatedBuyOrderIds: [],
      submittedAt: Date.now(),
    });

    storage.clearAll();

    expect(storage.getCostAveragePrice('A.HK', true)).toBeNull();
    expect(storage.getCostAveragePrice('B.HK', false)).toBeNull();
    expect(storage.getBuyOrdersList('A.HK', true)).toHaveLength(0);
    expect(storage.getBuyOrdersList('B.HK', false)).toHaveLength(0);
  });

  it('场景10: 成本均价不受待成交卖出影响（按全部订单计算）', () => {
    storage.addBuyOrder('TEST.HK', 1, 100, true, 1000);
    storage.addBuyOrder('TEST.HK', 1.2, 100, true, 2000);

    // 成本均价 = 1.1
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.1, 6);

    const orders = storage.getBuyOrdersList('TEST.HK', true);
    storage.addPendingSell({
      orderId: 'SELL_001',
      symbol: 'TEST.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: [orders[0]!.orderId],
      submittedAt: Date.now(),
    });

    // 成本均价仍然是 1.1（不排除占用订单）
    expect(storage.getCostAveragePrice('TEST.HK', true)).toBeCloseTo(1.1, 6);
  });
});
