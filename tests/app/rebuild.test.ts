/**
 * app/rebuild 单元测试
 *
 * 覆盖：
 * - executeTradingDayOpenRebuild 固定 loadTradingDayRuntimeSnapshot 参数语义
 * - 同一时间源会同时透传给 load 与 rebuild
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longport';
import { executeTradingDayOpenRebuild } from '../../src/app/rebuild.js';
import type { LoadTradingDayRuntimeSnapshotParams } from '../../src/main/lifecycle/types.js';
import type { Quote } from '../../src/types/quote.js';
import type { RawOrderFromAPI } from '../../src/types/services.js';

describe('app rebuild helpers', () => {
  it('executes open rebuild with fixed snapshot flags and shared now', async () => {
    const now = new Date('2026-03-09T09:30:00.000Z');
    const calls: LoadTradingDayRuntimeSnapshotParams[] = [];
    const allOrders: ReadonlyArray<RawOrderFromAPI> = [
      {
        orderId: '1',
        symbol: 'HSI-BULL.HK',
        stockName: 'HSI BULL',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        orderType: OrderType.LO,
        price: '1',
        quantity: '100',
        executedPrice: '1',
        executedQuantity: '100',
      },
    ];
    const quotesMap = new Map<string, Quote | null>([['HSI.HK', null]]);
    const rebuildCalls: Array<{
      readonly allOrders: ReadonlyArray<RawOrderFromAPI>;
      readonly quotesMap: ReadonlyMap<string, Quote | null>;
      readonly now?: Date;
    }> = [];

    await executeTradingDayOpenRebuild({
      now,
      loadTradingDayRuntimeSnapshot: async (params) => {
        calls.push(params);
        return {
          allOrders,
          quotesMap,
        };
      },
      rebuildTradingDayState: async (params) => {
        rebuildCalls.push(params);
      },
    });

    expect(calls).toEqual([
      {
        now,
        requireTradingDay: true,
        failOnOrderFetchError: true,
        resetRuntimeSubscriptions: true,
        hydrateCooldownFromTradeLog: false,
        forceOrderRefresh: true,
      },
    ]);

    expect(rebuildCalls).toEqual([
      {
        allOrders,
        quotesMap,
        now,
      },
    ]);
  });
});
