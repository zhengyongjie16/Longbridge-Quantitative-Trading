/**
 * resolveSellQuantityBySmartClose 单元测试
 *
 * 功能：
 * - 验证智能平仓三阶段逻辑（整体盈利全卖 / 盈利订单 / 超时订单）
 * - 验证阶段顺序与额度约束（stage3 仅使用 stage2 剩余额度）
 */
import { describe, it, expect } from 'bun:test';
import { resolveSellQuantityBySmartClose } from '../../../src/core/signalProcessor/utils.js';
import type { OrderRecorder, OrderRecord } from '../../../src/types/services.js';
import type {
  SellableOrderResult,
  SellableOrderSelectParams,
} from '../../../src/core/orderRecorder/types.js';
import type { TradingCalendarSnapshot } from '../../../src/types/tradingCalendar.js';

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

function createMockOrderRecorder(params: {
  costAveragePrice: number | null;
  selectSellableOrders: (input: SellableOrderSelectParams) => SellableOrderResult;
}): OrderRecorder {
  return {
    getCostAveragePrice: () => params.costAveragePrice,
    selectSellableOrders: params.selectSellableOrders,
    recordLocalBuy: () => {},
    recordLocalSell: () => {},
    clearBuyOrders: () => {},
    getLatestBuyOrderPrice: () => null,
    getLatestSellRecord: () => null,
    getSellRecordByOrderId: () => null,
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

const emptyCalendarSnapshot: TradingCalendarSnapshot = new Map();

describe('resolveSellQuantityBySmartClose', () => {
  const baseParams = {
    currentPrice: 1.1,
    availableQuantity: 300,
    direction: 'LONG' as const,
    symbol: 'TEST.HK',
    nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
    isHalfDay: false,
    tradingCalendarSnapshot: emptyCalendarSnapshot,
  };

  it('orderRecorder 不可用时保持持仓', () => {
    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      orderRecorder: null,
      smartCloseTimeoutMinutes: null,
    });

    expect(result.shouldHold).toBe(true);
    expect(result.quantity).toBeNull();
    expect(result.reason).toContain('订单记录不可用');
  });

  it('阶段1命中（整体盈利）时仅调用 ALL 策略并直接返回', () => {
    const calls: Array<SellableOrderSelectParams['strategy']> = [];
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1,
      selectSellableOrders: (input) => {
        calls.push(input.strategy);
        return {
          orders: [makeOrder('A1', 0.9, 100), makeOrder('A2', 1.2, 200)],
          totalQuantity: 300,
        };
      },
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1.2,
      orderRecorder: recorder,
      smartCloseTimeoutMinutes: 30,
    });

    expect(calls).toEqual(['ALL']);
    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(300);
    expect(result.relatedBuyOrderIds).toEqual(['A1', 'A2']);
  });

  it('阶段2后 timeout=null 时不执行阶段3', () => {
    const calls: Array<SellableOrderSelectParams['strategy']> = [];
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1.5,
      selectSellableOrders: (input) => {
        calls.push(input.strategy);
        return {
          orders: [makeOrder('P1', 0.9, 100)],
          totalQuantity: 100,
        };
      },
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1.1,
      orderRecorder: recorder,
      smartCloseTimeoutMinutes: null,
    });

    expect(calls).toEqual(['PROFIT_ONLY']);
    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(100);
    expect(result.relatedBuyOrderIds).toEqual(['P1']);
  });

  it('阶段3仅从阶段2剩余订单选择，并排除阶段2已选订单', () => {
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1.5,
      selectSellableOrders: (input) => {
        if (input.strategy === 'PROFIT_ONLY') {
          return {
            orders: [makeOrder('P1', 0.9, 100)],
            totalQuantity: 100,
          };
        }

        expect(input.strategy).toBe('TIMEOUT_ONLY');
        expect(input.maxSellQuantity).toBe(200);
        expect(input.excludeOrderIds?.has('P1')).toBe(true);
        return {
          orders: [makeOrder('T1', 1.4, 200)],
          totalQuantity: 200,
        };
      },
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1.1,
      orderRecorder: recorder,
      smartCloseTimeoutMinutes: 30,
    });

    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(300);
    expect(result.relatedBuyOrderIds).toEqual(['P1', 'T1']);
  });

  it('阶段3数量受 AQ - Q2 约束', () => {
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1.5,
      selectSellableOrders: (input) => {
        if (input.strategy === 'PROFIT_ONLY') {
          return {
            orders: [makeOrder('P1', 0.9, 250)],
            totalQuantity: 250,
          };
        }

        expect(input.maxSellQuantity).toBe(50);
        return {
          orders: [makeOrder('T1', 1.4, 50)],
          totalQuantity: 50,
        };
      },
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1.1,
      orderRecorder: recorder,
      smartCloseTimeoutMinutes: 30,
    });

    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(300);
    expect(result.relatedBuyOrderIds).toEqual(['P1', 'T1']);
  });

  it('阶段2与阶段3都无结果时保持持仓', () => {
    const recorder = createMockOrderRecorder({
      costAveragePrice: 1.5,
      selectSellableOrders: () => ({
        orders: [],
        totalQuantity: 0,
      }),
    });

    const result = resolveSellQuantityBySmartClose({
      ...baseParams,
      currentPrice: 1.1,
      orderRecorder: recorder,
      smartCloseTimeoutMinutes: 30,
    });

    expect(result.shouldHold).toBe(true);
    expect(result.quantity).toBeNull();
    expect(result.reason).toContain('无盈利订单，且无超时订单或已被占用');
  });
});
