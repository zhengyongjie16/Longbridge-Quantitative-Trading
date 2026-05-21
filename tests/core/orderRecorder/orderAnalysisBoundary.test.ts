import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import * as orderRecorder from '../../../src/core/orderRecorder/index.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';

function createRawOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly side: OrderSide;
  readonly updatedAt: Date;
  readonly executedPrice: number;
  readonly executedQuantity: number;
}): RawOrderFromAPI {
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName,
    side: params.side,
    status: OrderStatus.Filled,
    orderType: OrderType.LO,
    price: String(params.executedPrice),
    quantity: String(params.executedQuantity),
    executedPrice: String(params.executedPrice),
    executedQuantity: String(params.executedQuantity),
    submittedAt: params.updatedAt,
    updatedAt: params.updatedAt,
    remark: '',
  };
}

describe('orderRecorder public analysis boundary', () => {
  it('exposes dedicated daily loss analysis deps with a minimal public surface', () => {
    const buyOrder = createRawOrder({
      orderId: 'BUY-1',
      symbol: '70000.HK',
      stockName: 'HSI RC',
      side: OrderSide.Buy,
      updatedAt: new Date('2026-05-18T01:30:00.000Z'),
      executedPrice: 1,
      executedQuantity: 100,
    });
    const sellOrder = createRawOrder({
      orderId: 'SELL-1',
      symbol: '70000.HK',
      stockName: 'HSI RC',
      side: OrderSide.Sell,
      updatedAt: new Date('2026-05-18T02:30:00.000Z'),
      executedPrice: 0.9,
      executedQuantity: 100,
    });

    const deps = orderRecorder.createDailyLossOrderAnalysisDeps();
    const classified = deps.classifyAndConvertOrders([buyOrder, sellOrder]);

    expect(Object.keys(deps).sort((left, right) => left.localeCompare(right))).toEqual([
      'classifyAndConvertOrders',
      'filteringEngine',
      'resolveOrderOwnership',
    ]);

    expect(
      deps.resolveOrderOwnership(buyOrder, [
        { monitorSymbol: 'HSI', orderOwnershipMapping: ['HSI'] },
      ]),
    ).toEqual({ monitorSymbol: 'HSI', direction: 'LONG' });
    expect(Object.keys(deps.filteringEngine)).toEqual(['applyFilteringAlgorithm']);

    expect(
      deps.filteringEngine.applyFilteringAlgorithm(classified.buyOrders, classified.sellOrders),
    ).toEqual([]);
  });

  it('keeps order analysis internals off the public boundary', () => {
    expect(orderRecorder).not.toHaveProperty('createOrderAnalysisTools');
    expect(orderRecorder).not.toHaveProperty('createOrderFilteringEngine');
    expect(orderRecorder).not.toHaveProperty('classifyAndConvertOrders');
  });

  it('exposes ownership resolution and latest symbol lookup as separate public capabilities', () => {
    const buyOrder = createRawOrder({
      orderId: 'BUY-2',
      symbol: '70000.HK',
      stockName: 'HSI RC',
      side: OrderSide.Buy,
      updatedAt: new Date('2026-05-18T03:30:00.000Z'),
      executedPrice: 1,
      executedQuantity: 100,
    });

    expect(
      orderRecorder.resolveOrderOwnership(buyOrder, [
        { monitorSymbol: 'HSI', orderOwnershipMapping: ['HSI'] },
      ]),
    ).toEqual({ monitorSymbol: 'HSI', direction: 'LONG' });
    expect(orderRecorder.getLatestTradedSymbol([buyOrder], ['HSI'], 'LONG')).toBe('70000.HK');
  });
});
