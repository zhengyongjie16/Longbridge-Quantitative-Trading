/**
 * resolveSellQuantityBySmartClose 单元测试
 *
 * 测试智能平仓决策逻辑：
 * - orderRecorder 不可用 → 保持持仓
 * - 成本均价为 null → 走非盈利路径
 * - 当前价 > 成本均价 → 整体盈利，includeAll=true
 * - 当前价 ≤ 成本均价 → 未盈利，includeAll=false
 * - 成本均价无效值（0, NaN, Infinity）→ 走非盈利路径
 * - 有可卖订单 → 返回卖出结果
 * - 无可卖订单 → 保持持仓（区分原因）
 */
import { describe, it, expect } from 'bun:test';
import { resolveSellQuantityBySmartClose } from '../../../src/core/signalProcessor/utils.js';
import type { OrderRecorder, OrderRecord } from '../../../src/types/services.js';

function makeOrder(orderId: string, price: number, quantity: number): OrderRecord {
  return {
    orderId,
    symbol: 'TEST.HK',
    executedPrice: price,
    executedQuantity: quantity,
    executedTime: Date.now(),
    submittedAt: undefined,
    updatedAt: undefined,
  };
}

function createMockOrderRecorder(overrides: {
  costAveragePrice?: number | null;
  sellableOrders?: ReadonlyArray<OrderRecord>;
  sellableTotalQuantity?: number;
}): OrderRecorder {
  const {
    costAveragePrice = null,
    sellableOrders = [],
    sellableTotalQuantity = 0,
  } = overrides;

  return {
    getCostAveragePrice: () => costAveragePrice,
    getSellableOrders: () => ({
      orders: sellableOrders,
      totalQuantity: sellableTotalQuantity,
    }),
    // 以下方法在 resolveSellQuantityBySmartClose 中不会被调用
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

describe('resolveSellQuantityBySmartClose', () => {
  const baseParams = {
    currentPrice: 1.1,
    availableQuantity: 200,
    direction: 'LONG' as const,
    symbol: 'TEST.HK',
  };

  // ========== orderRecorder 不可用 ==========

  it('orderRecorder 为 null 时保持持仓', () => {
    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      orderRecorder: null,
    });

    expect(result.shouldHold).toBe(true);
    expect(result.quantity).toBeNull();
    expect(result.reason).toContain('订单记录不可用');
    expect(result.relatedBuyOrderIds).toHaveLength(0);
  });

  // ========== 成本均价为 null ==========

  it('成本均价为 null 且无盈利订单时保持持仓', () => {
    const recorder = createMockOrderRecorder({
      costAveragePrice: null,
      sellableOrders: [],
      sellableTotalQuantity: 0,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      orderRecorder: recorder,
    });

    expect(result.shouldHold).toBe(true);
    expect(result.quantity).toBeNull();
    expect(result.reason).toContain('无盈利订单或已被占用');
  });

  it('成本均价为 null 但有盈利订单时卖出盈利部分', () => {
    const orders = [makeOrder('O1', 1, 100)];
    const recorder = createMockOrderRecorder({
      costAveragePrice: null,
      sellableOrders: orders,
      sellableTotalQuantity: 100,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      orderRecorder: recorder,
    });

    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(100);
    expect(result.relatedBuyOrderIds).toEqual(['O1']);
  });

  // ========== 整体盈利（当前价 > 成本均价）==========

  it('当前价 > 成本均价时整体盈利，返回全部可卖订单', () => {
    const orders = [
      makeOrder('O1', 1, 100),
      makeOrder('O2', 1.2, 100),
    ];
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1.1,
      sellableOrders: orders,
      sellableTotalQuantity: 200,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1.15,
      orderRecorder: recorder,
    });

    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(200);
    expect(result.relatedBuyOrderIds).toEqual(['O1', 'O2']);
    expect(result.reason).toContain('成本均价=1.100');
  });

  it('整体盈利但所有订单被占用时保持持仓', () => {
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1,
      sellableOrders: [],
      sellableTotalQuantity: 0,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1.5,
      orderRecorder: recorder,
    });

    expect(result.shouldHold).toBe(true);
    expect(result.quantity).toBeNull();
    expect(result.reason).toContain('整体盈利但无可用订单或已被占用');
  });

  // ========== 整体未盈利（当前价 ≤ 成本均价）==========

  it('当前价 < 成本均价时仅卖出盈利订单', () => {
    const orders = [makeOrder('O1', 1, 100)];
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1.1,
      sellableOrders: orders,
      sellableTotalQuantity: 100,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1.05,
      orderRecorder: recorder,
    });

    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(100);
    expect(result.relatedBuyOrderIds).toEqual(['O1']);
  });

  it('当前价 = 成本均价时走非盈利路径', () => {
    const orders = [makeOrder('O1', 0.9, 100)];
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1,
      sellableOrders: orders,
      sellableTotalQuantity: 100,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1,
      orderRecorder: recorder,
    });

    // 当前价 = 成本均价，不满足 > 条件，走非盈利路径
    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(100);
  });

  it('整体未盈利且无盈利订单时保持持仓', () => {
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1.5,
      sellableOrders: [],
      sellableTotalQuantity: 0,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1,
      orderRecorder: recorder,
    });

    expect(result.shouldHold).toBe(true);
    expect(result.reason).toContain('无盈利订单或已被占用');
  });

  // ========== 成本均价无效值 ==========

  it('成本均价为 0 时走非盈利路径', () => {
    const recorder = createMockOrderRecorder({
      costAveragePrice: 0,
      sellableOrders: [],
      sellableTotalQuantity: 0,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      orderRecorder: recorder,
    });

    // costAveragePrice = 0，不满足 > 0 条件
    expect(result.shouldHold).toBe(true);
    expect(result.reason).not.toContain('整体盈利');
  });

  it('成本均价为 NaN 时走非盈利路径', () => {
    const recorder = createMockOrderRecorder({
      costAveragePrice: Number.NaN,
      sellableOrders: [],
      sellableTotalQuantity: 0,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      orderRecorder: recorder,
    });

    expect(result.shouldHold).toBe(true);
    expect(result.reason).not.toContain('整体盈利');
  });

  it('成本均价为 Infinity 时走非盈利路径', () => {
    const recorder = createMockOrderRecorder({
      costAveragePrice: Infinity,
      sellableOrders: [],
      sellableTotalQuantity: 0,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      orderRecorder: recorder,
    });

    expect(result.shouldHold).toBe(true);
    expect(result.reason).not.toContain('整体盈利');
  });

  it('成本均价为负数时走非盈利路径', () => {
    const recorder = createMockOrderRecorder({
      costAveragePrice: -1,
      sellableOrders: [],
      sellableTotalQuantity: 0,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      orderRecorder: recorder,
    });

    expect(result.shouldHold).toBe(true);
    expect(result.reason).not.toContain('整体盈利');
  });

  // ========== 做空方向 ==========

  it('做空方向正确传递 isLongSymbol=false', () => {
    let capturedOptions: { readonly includeAll?: boolean } | undefined;
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1,
      sellableOrders: [makeOrder('O1', 0.9, 100)],
      sellableTotalQuantity: 100,
    });
    // 覆盖 getSellableOrders 以捕获参数
    recorder.getSellableOrders = (
      _symbol: string,
      _direction: 'LONG' | 'SHORT',
      _currentPrice: number,
      _maxSellQuantity?: number,
      options?: { readonly includeAll?: boolean },
    ) => {
      capturedOptions = options;
      return { orders: [makeOrder('O1', 0.9, 100)], totalQuantity: 100 };
    };

    resolveSellQuantityBySmartClose({
      ...baseParams,
      direction: 'SHORT',
      currentPrice: 1.5,
      orderRecorder: recorder,
    });

    // 当前价 1.5 > 成本均价 1 → isOverallProfitable=true → includeAll=true
    expect(capturedOptions?.includeAll).toBe(true);
  });

  // ========== relatedBuyOrderIds 正确性 ==========

  it('返回的 relatedBuyOrderIds 与可卖订单的 orderId 一致', () => {
    const orders = [
      makeOrder('BUY_001', 1, 100),
      makeOrder('BUY_002', 0.9, 50),
      makeOrder('BUY_003', 1.1, 150),
    ];
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1,
      sellableOrders: orders,
      sellableTotalQuantity: 300,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1.5,
      orderRecorder: recorder,
    });

    expect(result.relatedBuyOrderIds).toEqual(['BUY_001', 'BUY_002', 'BUY_003']);
  });

  // ========== reason 文本验证 ==========

  it('卖出结果的 reason 包含关键信息', () => {
    const orders = [makeOrder('O1', 1, 100)];
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1.05,
      sellableOrders: orders,
      sellableTotalQuantity: 100,
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1.1,
      orderRecorder: recorder,
    });

    expect(result.reason).toContain('当前价=1.100');
    expect(result.reason).toContain('成本均价=1.050');
    expect(result.reason).toContain('可卖出=100股');
    expect(result.reason).toContain('关联订单=1个');
  });
});
