/**
 * app/rebuild 单元测试
 *
 * 覆盖：
 * - executeTradingDayOpenRebuild 固定 loadTradingDayRuntimeSnapshot 参数语义
 * - 同一时间源会同时透传给 load 与 rebuild
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import {
  createTradingDayInfoResolver,
  executeTradingDayOpenRebuild,
} from '../../../src/app/lifecycle/rebuild.js';
import type { LoadTradingDayRuntimeSnapshotParams } from '../../../src/main/lifecycle/types.js';
import type { Quote } from '../../../src/types/quote.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';

describe('app rebuild helpers', () => {
  it('rethrows trading-day resolver failures without fallbacking to non-trading day', async () => {
    const thrownError = new Error('trading day service unavailable');
    const resolveErrors: unknown[] = [];
    let lookupCalls = 0;
    const resolveTradingDayInfo = createTradingDayInfoResolver({
      marketDataClient: {
        isTradingDay: async () => {
          lookupCalls += 1;
          throw thrownError;
        },
      },
      getHKDateKey: () => '2026-03-09',
      onResolveError: (error) => {
        resolveErrors.push(error);
      },
    });

    let caught: unknown = null;
    try {
      await resolveTradingDayInfo(new Date('2026-03-09T09:30:00.000Z'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(thrownError);
    expect(resolveErrors).toEqual([thrownError]);
    expect(lookupCalls).toBe(1);
  });

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
        hydrateCooldownFromTradeLog: true,
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
