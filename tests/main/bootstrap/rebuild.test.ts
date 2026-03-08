/**
 * bootstrap/rebuild 业务测试
 *
 * 功能：
 * - 冻结交易日信息解析器的缓存与异常回退语义
 * - 验证开盘重建入口固定使用 open rebuild 模式矩阵
 */
import { describe, expect, it } from 'bun:test';
import {
  createTradingDayInfoResolver,
  executeTradingDayOpenRebuild,
} from '../../../src/main/bootstrap/rebuild.js';

describe('bootstrap rebuild flow', () => {
  it('caches trading-day info by hk day key and falls back to non-trading day on resolver error', async () => {
    const resolvedDates: string[] = [];
    const capturedErrors: string[] = [];
    let callCount = 0;

    const resolveTradingDayInfo = createTradingDayInfoResolver({
      marketDataClient: {
        isTradingDay: async (currentTime) => {
          callCount += 1;
          resolvedDates.push(currentTime.toISOString());
          if (currentTime.toISOString() === '2026-03-03T01:00:00.000Z') {
            throw new Error('trading day api failed');
          }

          return {
            isTradingDay: true,
            isHalfDay: false,
          };
        },
      },
      getHKDateKey: (currentTime) => currentTime.toISOString().slice(0, 10),
      onResolveError: (error) => {
        capturedErrors.push(String(error));
      },
    });

    const firstResult = await resolveTradingDayInfo(new Date('2026-03-02T01:00:00.000Z'));
    expect(firstResult).toEqual({
      isTradingDay: true,
      isHalfDay: false,
    });

    const cachedResult = await resolveTradingDayInfo(new Date('2026-03-02T08:00:00.000Z'));
    expect(cachedResult).toEqual({
      isTradingDay: true,
      isHalfDay: false,
    });

    const fallbackResult = await resolveTradingDayInfo(new Date('2026-03-03T01:00:00.000Z'));
    expect(fallbackResult).toEqual({
      isTradingDay: false,
      isHalfDay: false,
    });

    expect(callCount).toBe(2);
    expect(resolvedDates).toEqual([
      '2026-03-02T01:00:00.000Z',
      '2026-03-03T01:00:00.000Z',
    ]);
    expect(capturedErrors).toEqual(['Error: trading day api failed']);
  });

  it('executes open rebuild with fixed strict snapshot matrix', async () => {
    const receivedCalls: Array<{
      requireTradingDay: boolean;
      failOnOrderFetchError: boolean;
      resetRuntimeSubscriptions: boolean;
      hydrateCooldownFromTradeLog: boolean;
      forceOrderRefresh: boolean;
    }> = [];

    await executeTradingDayOpenRebuild({
      now: new Date('2026-03-02T01:00:00.000Z'),
      loadTradingDayRuntimeSnapshot: async (params) => {
        receivedCalls.push({
          requireTradingDay: params.requireTradingDay,
          failOnOrderFetchError: params.failOnOrderFetchError,
          resetRuntimeSubscriptions: params.resetRuntimeSubscriptions,
          hydrateCooldownFromTradeLog: params.hydrateCooldownFromTradeLog,
          forceOrderRefresh: params.forceOrderRefresh,
        });
        return {
          allOrders: [],
          quotesMap: new Map(),
        };
      },
      rebuildTradingDayState: async () => {},
    });

    expect(receivedCalls).toEqual([
      {
        requireTradingDay: true,
        failOnOrderFetchError: true,
        resetRuntimeSubscriptions: true,
        hydrateCooldownFromTradeLog: false,
        forceOrderRefresh: true,
      },
    ]);
  });
});
