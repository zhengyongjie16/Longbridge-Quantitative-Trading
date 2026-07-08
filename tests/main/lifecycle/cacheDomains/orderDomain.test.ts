/**
 * 订单缓存域单元测试
 *
 * 覆盖：midnightClear 仅重置 trader 运行态；openRebuild 不再持有订单监控 runtime owner
 */
import { describe, it, expect } from 'bun:test';
import { createOrderDomain } from '../../../../src/main/lifecycle/cacheDomains/orderDomain.js';
import type { Trader } from '../../../../src/types/services.js';

describe('createOrderDomain', () => {
  it('midnightClear 仅重置 trader 运行态', async () => {
    const calls: string[] = [];
    const trader = {
      resetRuntimeState: () => {
        calls.push('resetRuntimeState');
      },
    } as unknown as Trader;

    const domain = createOrderDomain({ trader });
    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(calls).toEqual(['resetRuntimeState']);
  });

  it('openRebuild 不再启动订单监控 runtime', async () => {
    const calls: string[] = [];
    const trader = {
      startOrderMonitorRuntime: () => {
        calls.push('startOrderMonitorRuntime');
      },
    } as unknown as Trader;
    const domain = createOrderDomain({ trader });
    await domain.openRebuild({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(calls).toEqual([]);
  });
});
