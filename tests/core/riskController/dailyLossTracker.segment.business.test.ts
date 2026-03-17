/**
 * dailyLossTracker 分段业务测试
 *
 * 功能：
 * - 验证保护性清仓边界推进后的分段过滤、幂等重置与启动恢复边界语义。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createDailyLossTracker } from '../../../src/core/riskController/dailyLossTracker.js';
import { createOrderFilteringEngine } from '../../../src/core/orderRecorder/orderFilteringEngine.js';
import { classifyAndConvertOrders } from '../../../src/core/orderRecorder/utils.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';
import type { MonitorConfig } from '../../../src/types/config.js';
import type { OrderOwnership } from '../../../src/types/orderRecorder.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';

function createExecutedOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly status?: OrderStatus;
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly updatedAtMs: number;
}): RawOrderFromAPI {
  const updatedAt = new Date(params.updatedAtMs);
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.symbol,
    side: params.side,
    status: params.status ?? OrderStatus.Filled,
    orderType: OrderType.ELO,
    remark: null,
    price: params.executedPrice,
    quantity: params.executedQuantity,
    executedPrice: params.executedPrice,
    executedQuantity: params.executedQuantity,
    submittedAt: updatedAt,
    updatedAt,
  };
}

function createMonitors(): ReadonlyArray<
  Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>
> {
  return [
    {
      monitorSymbol: 'HSI.HK',
      orderOwnershipMapping: [],
    },
  ];
}

function resolveOrderOwnership(order: RawOrderFromAPI): OrderOwnership | null {
  if (order.symbol === 'BULL.HK') {
    return { monitorSymbol: 'HSI.HK', direction: 'LONG' };
  }

  if (order.symbol === 'BEAR.HK') {
    return { monitorSymbol: 'HSI.HK', direction: 'SHORT' };
  }

  return null;
}

describe('dailyLossTracker segment flow', () => {
  it('startNewProtectionEpisode clears old segment state and ignores pre-segment fills', () => {
    const tracker = createDailyLossTracker({
      filteringEngine: createOrderFilteringEngine(),
      resolveOrderOwnership: (order) => resolveOrderOwnership(order),
      classifyAndConvertOrders,
      toHongKongTimeIso,
    });
    const monitors = createMonitors();
    const now = new Date('2026-03-03T02:00:00.000Z');

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-old',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-old',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:05:00.000Z'),
        }),
      ],
      monitors,
      now,
    );
    expect(tracker.getLossOffset('HSI.HK', true)).toBe(-10);

    tracker.startNewProtectionEpisode({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      boundaryExecutedTimeMs: Date.parse('2026-03-03T01:10:00.000Z'),
    });
    expect(tracker.getLossOffset('HSI.HK', true)).toBe(0);

    tracker.recordFilledOrder({
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL.HK',
      isLongSymbol: true,
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:09:00.000Z'),
      orderId: 'buy-before-segment',
    });
    expect(tracker.getLossOffset('HSI.HK', true)).toBe(0);

    tracker.recordFilledOrder({
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL.HK',
      isLongSymbol: true,
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:11:00.000Z'),
      orderId: 'buy-new-segment',
    });

    tracker.recordFilledOrder({
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL.HK',
      isLongSymbol: true,
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:12:00.000Z'),
      orderId: 'sell-new-segment',
    });
    expect(tracker.getLossOffset('HSI.HK', true)).toBe(-10);
  });

  it('startNewProtectionEpisode is idempotent for the same protection boundary', () => {
    const tracker = createDailyLossTracker({
      filteringEngine: createOrderFilteringEngine(),
      resolveOrderOwnership: (order) => resolveOrderOwnership(order),
      classifyAndConvertOrders,
      toHongKongTimeIso,
    });
    const now = new Date('2026-03-03T02:00:00.000Z');
    const monitors = createMonitors();
    const firstBoundaryMs = Date.parse('2026-03-03T01:10:00.000Z');

    tracker.recalculateFromAllOrders([], monitors, now);

    tracker.startNewProtectionEpisode({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      boundaryExecutedTimeMs: firstBoundaryMs,
    });

    tracker.recordFilledOrder({
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL.HK',
      isLongSymbol: true,
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:11:00.000Z'),
      orderId: 'buy-after-first-reset',
    });

    tracker.recordFilledOrder({
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL.HK',
      isLongSymbol: true,
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:12:00.000Z'),
      orderId: 'sell-after-first-reset',
    });
    expect(tracker.getLossOffset('HSI.HK', true)).toBe(-10);

    tracker.startNewProtectionEpisode({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      boundaryExecutedTimeMs: firstBoundaryMs,
    });
    expect(tracker.getLossOffset('HSI.HK', true)).toBe(-10);
  });

  it('recalculateFromAllOrders respects external protectionBoundaryByDirection at startup', () => {
    const tracker = createDailyLossTracker({
      filteringEngine: createOrderFilteringEngine(),
      resolveOrderOwnership: (order) => resolveOrderOwnership(order),
      classifyAndConvertOrders,
      toHongKongTimeIso,
    });
    const monitors = createMonitors();
    const protectionBoundaryByDirection = new Map<string, number>([
      ['HSI.HK:LONG', Date.parse('2026-03-03T01:10:00.000Z')],
    ]);

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-before-segment',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-before-segment',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:05:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'buy-after-segment',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:11:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-after-segment',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:12:00.000Z'),
        }),
      ],
      monitors,
      new Date('2026-03-03T02:00:00.000Z'),
      protectionBoundaryByDirection,
    );

    expect(tracker.getLossOffset('HSI.HK', true)).toBe(-10);
  });

  it('recalculateFromAllOrders keeps same-day in-memory protection boundary when no boundary is passed', () => {
    const tracker = createDailyLossTracker({
      filteringEngine: createOrderFilteringEngine(),
      resolveOrderOwnership: (order) => resolveOrderOwnership(order),
      classifyAndConvertOrders,
      toHongKongTimeIso,
    });
    const monitors = createMonitors();
    const now = new Date('2026-03-03T02:00:00.000Z');

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-old',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-old',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:05:00.000Z'),
        }),
      ],
      monitors,
      now,
    );
    expect(tracker.getLossOffset('HSI.HK', true)).toBe(-10);

    tracker.startNewProtectionEpisode({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      boundaryExecutedTimeMs: Date.parse('2026-03-03T01:10:00.000Z'),
    });
    expect(tracker.getLossOffset('HSI.HK', true)).toBe(0);

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-old',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-old',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:05:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'buy-new',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:11:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-new',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:12:00.000Z'),
        }),
      ],
      monitors,
      now,
    );

    expect(tracker.getLossOffset('HSI.HK', true)).toBe(-10);
  });

  it('recalculateFromAllOrders includes canceled order executed part to keep restart consistency', () => {
    const tracker = createDailyLossTracker({
      filteringEngine: createOrderFilteringEngine(),
      resolveOrderOwnership: (order) => resolveOrderOwnership(order),
      classifyAndConvertOrders,
      toHongKongTimeIso,
    });
    const monitors = createMonitors();
    const now = new Date('2026-03-03T02:00:00.000Z');

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-filled',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.Filled,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-canceled-partial',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.Canceled,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:05:00.000Z'),
        }),
      ],
      monitors,
      now,
    );

    expect(tracker.getLossOffset('HSI.HK', true)).toBe(-10);
  });
});
