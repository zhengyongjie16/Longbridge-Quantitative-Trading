/**
 * classifyOrdersForRebuild 单元测试
 *
 * 功能：
 * - 验证全量订单分类器在重建阶段的状态分流行为
 * - 确保 Filled/Pending 与 Buy/Sell 四类输出正确
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longport';
import { classifyOrdersForRebuild } from '../../../src/core/orderRecorder/utils.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';

function createRawOrder(overrides: Partial<RawOrderFromAPI>): RawOrderFromAPI {
  return {
    orderId: overrides.orderId ?? 'ORDER-1',
    symbol: overrides.symbol ?? 'BULL.HK',
    stockName: overrides.stockName ?? 'HSI RC SAMPLE',
    side: overrides.side ?? OrderSide.Buy,
    status: overrides.status ?? OrderStatus.Filled,
    orderType: overrides.orderType ?? OrderType.ELO,
    price: overrides.price ?? 1,
    quantity: overrides.quantity ?? 100,
    executedPrice: overrides.executedPrice ?? 1,
    executedQuantity: overrides.executedQuantity ?? 100,
    submittedAt: overrides.submittedAt ?? new Date('2026-02-25T03:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-02-25T03:05:00.000Z'),
  };
}

describe('classifyOrdersForRebuild', () => {
  it('splits filled and pending orders into four groups', () => {
    const result = classifyOrdersForRebuild([
      createRawOrder({
        orderId: 'FILLED-BUY',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
      }),
      createRawOrder({
        orderId: 'FILLED-SELL',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
      }),
      createRawOrder({
        orderId: 'PENDING-BUY',
        side: OrderSide.Buy,
        status: OrderStatus.New,
        executedPrice: 0,
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'PENDING-SELL',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        executedPrice: 0,
        executedQuantity: 10,
      }),
      createRawOrder({
        orderId: 'CANCELLED-BUY',
        side: OrderSide.Buy,
        status: OrderStatus.Canceled,
      }),
    ]);

    expect(result.filledBuyOrders.map((order) => order.orderId)).toEqual(['FILLED-BUY']);
    expect(result.filledSellOrders.map((order) => order.orderId)).toEqual(['FILLED-SELL']);
    expect(result.pendingBuyOrders.map((order) => order.orderId)).toEqual(['PENDING-BUY']);
    expect(result.pendingSellOrders.map((order) => order.orderId)).toEqual(['PENDING-SELL']);
  });

  it('drops invalid filled records from rebuild deductions', () => {
    const result = classifyOrdersForRebuild([
      createRawOrder({
        orderId: 'INVALID-FILLED-BUY',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        executedPrice: 0,
      }),
      createRawOrder({
        orderId: 'VALID-PENDING-BUY',
        side: OrderSide.Buy,
        status: OrderStatus.New,
      }),
    ]);

    expect(result.filledBuyOrders).toHaveLength(0);
    expect(result.pendingBuyOrders.map((order) => order.orderId)).toEqual(['VALID-PENDING-BUY']);
  });
});
