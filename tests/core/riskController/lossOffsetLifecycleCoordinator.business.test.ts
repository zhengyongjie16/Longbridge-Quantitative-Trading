/**
 * lossOffsetLifecycleCoordinator 业务测试
 *
 * 功能：
 * - 验证冷却过期事件消费与亏损偏移分段切换联动行为。
 */
import { describe, expect, it } from 'bun:test';
import { createLossOffsetLifecycleCoordinator } from '../../../src/core/riskController/lossOffsetLifecycleCoordinator/index.js';
import type { DailyLossTracker } from '../../../src/core/riskController/types.js';
import type {
  CooldownExpiredEvent,
  LiquidationCooldownTracker,
} from '../../../src/services/liquidationCooldown/types.js';

describe('lossOffsetLifecycleCoordinator business flow', () => {
  it('consumes expired cooldown events and resets corresponding direction segments', async () => {
    const expiredEvents: ReadonlyArray<CooldownExpiredEvent> = [
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        cooldownEndMs: 1_000_000,
        triggerCountAtExpire: 3,
      },
      {
        monitorSymbol: 'QQQ.HK',
        direction: 'SHORT',
        cooldownEndMs: 2_000_000,
        triggerCountAtExpire: 2,
      },
    ];
    const resetCalls: Array<{
      readonly monitorSymbol: string;
      readonly direction: 'LONG' | 'SHORT';
      readonly segmentStartMs: number;
      readonly cooldownEndMs: number;
    }> = [];

    const coordinator = createLossOffsetLifecycleCoordinator({
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        sweepExpired: () => expiredEvents,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      } as LiquidationCooldownTracker,
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
        resetDirectionSegment: (params) => {
          resetCalls.push(params);
        },
      } as DailyLossTracker,
      logger: {
        debug: () => {},
      },
      resolveCooldownConfig: () => ({ mode: 'minutes', minutes: 30 }),
      onSegmentReset: () => {},
    });

    await coordinator.sync(3_000_000);

    expect(resetCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        segmentStartMs: 1_000_000,
        cooldownEndMs: 1_000_000,
      },
      {
        monitorSymbol: 'QQQ.HK',
        direction: 'SHORT',
        segmentStartMs: 2_000_000,
        cooldownEndMs: 2_000_000,
      },
    ]);
  });

  it('does not call resetDirectionSegment when no expired events are returned', async () => {
    let resetCount = 0;
    const coordinator = createLossOffsetLifecycleCoordinator({
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        sweepExpired: () => [],
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      } as LiquidationCooldownTracker,
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
        resetDirectionSegment: () => {
          resetCount += 1;
        },
      } as DailyLossTracker,
      logger: {
        debug: () => {},
      },
      resolveCooldownConfig: () => ({ mode: 'minutes', minutes: 30 }),
      onSegmentReset: () => {},
    });

    await coordinator.sync(1_000);

    expect(resetCount).toBe(0);
  });

  it('awaits onSegmentReset callback so downstream refresh can complete in same sync cycle', async () => {
    const order: string[] = [];
    const coordinator = createLossOffsetLifecycleCoordinator({
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        sweepExpired: () => [
          {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            cooldownEndMs: 10_000,
            triggerCountAtExpire: 1,
          },
        ],
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      } as LiquidationCooldownTracker,
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
        resetDirectionSegment: () => {
          order.push('resetDirectionSegment');
        },
      } as DailyLossTracker,
      logger: {
        debug: () => {},
      },
      resolveCooldownConfig: () => ({ mode: 'minutes', minutes: 30 }),
      onSegmentReset: async () => {
        order.push('onSegmentReset:start');
        await Promise.resolve();
        order.push('onSegmentReset:end');
      },
    });

    await coordinator.sync(10_001);
    order.push('sync:returned');

    expect(order).toEqual([
      'resetDirectionSegment',
      'onSegmentReset:start',
      'onSegmentReset:end',
      'sync:returned',
    ]);
  });
});
