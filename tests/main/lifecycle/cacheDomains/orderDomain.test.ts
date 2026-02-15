/**
 * 订单缓存域单元测试
 *
 * 覆盖：midnightClear 调用 trader._resetRuntimeState；openRebuild 为空操作
 */
import { describe, it, expect } from 'bun:test';
import { createOrderDomain } from '../../../../src/main/lifecycle/cacheDomains/orderDomain.js';
import type { Trader } from '../../../../src/types/services.js';

describe('createOrderDomain', () => {
  it('midnightClear 调用 trader._resetRuntimeState', () => {
    let resetCalled = false;
    const trader: Trader = {
      _resetRuntimeState: () => {
        resetCalled = true;
      },
    } as unknown as Trader;

    const domain = createOrderDomain({ trader });
    void domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(resetCalled).toBe(true);
  });

  it('openRebuild 为空操作，不抛错', () => {
    const trader = { _resetRuntimeState: () => {} } as unknown as Trader;
    const domain = createOrderDomain({ trader });
    expect(() => {
      void domain.openRebuild({
        now: new Date(),
        runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
      });
    }).not.toThrow();
  });
});
