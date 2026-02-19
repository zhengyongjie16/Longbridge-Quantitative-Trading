/**
 * 行情缓存域单元测试
 *
 * 覆盖：midnightClear 调用 marketDataClient.resetRuntimeSubscriptionsAndCaches；openRebuild 为空操作
 */
import { describe, it, expect } from 'bun:test';
import { createMarketDataDomain } from '../../../../src/main/lifecycle/cacheDomains/marketDataDomain.js';
import type { MarketDataClient } from '../../../../src/types/services.js';

describe('createMarketDataDomain', () => {
  it('midnightClear 调用 marketDataClient.resetRuntimeSubscriptionsAndCaches', async () => {
    let resetCalled = false;
    const marketDataClient: MarketDataClient = {
      resetRuntimeSubscriptionsAndCaches: async () => {
        resetCalled = true;
      },
    } as unknown as MarketDataClient;

    const domain = createMarketDataDomain({ marketDataClient });
    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(resetCalled).toBe(true);
  });

  it('openRebuild 为空操作，不抛错', async () => {
    const marketDataClient = {
      resetRuntimeSubscriptionsAndCaches: async () => {},
    } as unknown as MarketDataClient;
    const domain = createMarketDataDomain({ marketDataClient });
    await domain.openRebuild({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });
  });
});
