/**
 * liquidationCooldown 业务测试
 *
 * 功能：
 * - 验证清仓冷却追踪与触发次数限制相关的业务行为。
 */
import { describe, expect, it } from 'bun:test';

import { createLiquidationCooldownTracker } from '../../../src/services/liquidationCooldown/index.js';

describe('liquidationCooldown business flow', () => {
  it('triggerLimit=1 keeps backward compatibility and activates cooldown immediately', () => {
    const now = 1_000_000;
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => now,
    });

    const result = tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now,
      triggerLimit: 1,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });

    expect(result).toEqual({
      currentCount: 1,
      cooldownActivated: true,
    });

    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'LONG',
        cooldownConfig: { mode: 'minutes', minutes: 5 },
      }),
    ).toBe(300_000);
  });

  it('triggerLimit=3 activates cooldown only on the third trigger', () => {
    const now = 1_000_000;
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => now,
    });

    const first = tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now,
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });
    expect(first).toEqual({
      currentCount: 1,
      cooldownActivated: false,
    });

    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'LONG',
        cooldownConfig: { mode: 'minutes', minutes: 5 },
      }),
    ).toBe(0);

    const second = tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now + 1_000,
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });
    expect(second).toEqual({
      currentCount: 2,
      cooldownActivated: false,
    });

    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'LONG',
        cooldownConfig: { mode: 'minutes', minutes: 5 },
      }),
    ).toBe(0);

    const third = tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now + 2_000,
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });
    expect(third).toEqual({
      currentCount: 3,
      cooldownActivated: true,
    });

    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'LONG',
        cooldownConfig: { mode: 'minutes', minutes: 5 },
      }),
    ).toBe(302_000);
  });

  it('resets trigger counter when cooldown expires', () => {
    let now = 1_000_000;
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => now,
    });

    tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now,
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });

    tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now + 1_000,
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });

    tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now + 2_000,
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });

    now += 62_001;
    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'LONG',
        cooldownConfig: { mode: 'minutes', minutes: 1 },
      }),
    ).toBe(0);

    const next = tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now,
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });
    expect(next).toEqual({
      currentCount: 1,
      cooldownActivated: false,
    });
  });

  it('resolves one-day and half-day cooldown windows by Hong Kong time rules', () => {
    let now = Date.parse('2026-02-16T10:00:00+08:00');
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => now,
    });

    const oneDayExecutedAt = Date.parse('2026-02-16T10:00:00+08:00');
    tracker.recordCooldown({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: oneDayExecutedAt,
    });

    now = Date.parse('2026-02-16T23:59:59+08:00');
    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'LONG',
        cooldownConfig: { mode: 'one-day' },
      }),
    ).toBe(1_000);

    const morningExecutedAt = Date.parse('2026-02-16T11:00:00+08:00');
    tracker.recordCooldown({
      symbol: 'HSI.HK',
      direction: 'SHORT',
      executedTimeMs: morningExecutedAt,
    });
    now = Date.parse('2026-02-16T12:30:00+08:00');
    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'SHORT',
        cooldownConfig: { mode: 'half-day' },
      }),
    ).toBe(30 * 60_000);

    const afternoonExecutedAt = Date.parse('2026-02-16T13:30:00+08:00');
    tracker.recordCooldown({
      symbol: 'HSI.HK',
      direction: 'SHORT',
      executedTimeMs: afternoonExecutedAt,
    });
    now = Date.parse('2026-02-16T23:00:00+08:00');
    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'SHORT',
        cooldownConfig: { mode: 'half-day' },
      }),
    ).toBe(60 * 60_000);
  });

  it('clearMidnightEligible clears designated keys and related trigger counters', () => {
    const now = 10_000;
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => now,
    });

    tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now,
      triggerLimit: 2,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });

    tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now + 1_000,
      triggerLimit: 2,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });

    tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'SHORT',
      executedTimeMs: now,
      triggerLimit: 2,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });

    tracker.clearMidnightEligible({
      keysToClear: new Set(['HSI.HK:LONG']),
    });

    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'LONG',
        cooldownConfig: { mode: 'minutes', minutes: 10 },
      }),
    ).toBe(0);

    const longAfterClear = tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now + 2_000,
      triggerLimit: 2,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });
    expect(longAfterClear).toEqual({
      currentCount: 1,
      cooldownActivated: false,
    });

    const shortSecondTrigger = tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'SHORT',
      executedTimeMs: now + 2_000,
      triggerLimit: 2,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });
    expect(shortSecondTrigger).toEqual({
      currentCount: 2,
      cooldownActivated: true,
    });
  });

  it('resetAllTriggerCounts resets all counters', () => {
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => 1_000,
    });

    tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: 1_000,
      triggerLimit: 2,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });

    tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'SHORT',
      executedTimeMs: 1_000,
      triggerLimit: 2,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });
    tracker.resetAllTriggerCounts();

    const result = tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: 2_000,
      triggerLimit: 2,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });
    expect(result).toEqual({
      currentCount: 1,
      cooldownActivated: false,
    });
  });

  it('restoreTriggerCount can continue counting from hydrated state', () => {
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => 1_000,
    });

    tracker.restoreTriggerCount({
      symbol: 'HSI.HK',
      direction: 'LONG',
      count: 2,
    });
    const result = tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: 2_000,
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });

    expect(result).toEqual({
      currentCount: 3,
      cooldownActivated: true,
    });
  });

  it('sweepExpired emits exactly once with correct fields after expiration', () => {
    const executedTimeMs = 1_000;
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => executedTimeMs,
    });

    tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs,
      triggerLimit: 1,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });

    const events = tracker.sweepExpired({
      nowMs: 61_000,
      resolveCooldownConfig: () => ({ mode: 'minutes', minutes: 1 }),
    });
    const secondSweep = tracker.sweepExpired({
      nowMs: 61_001,
      resolveCooldownConfig: () => ({ mode: 'minutes', minutes: 1 }),
    });

    expect(events).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        cooldownEndMs: 61_000,
        triggerCountAtExpire: 1,
      },
    ]);
    expect(secondSweep).toEqual([]);
  });

  it('getRemainingMs stays side-effect free before and after expiration', () => {
    let now = 1_000;
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => now,
    });

    tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now,
      triggerLimit: 1,
      cooldownConfig: { mode: 'minutes', minutes: 1 },
    });

    now = 30_000;
    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'LONG',
        cooldownConfig: { mode: 'minutes', minutes: 1 },
      }),
    ).toBe(31_000);

    now = 61_001;
    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'LONG',
        cooldownConfig: { mode: 'minutes', minutes: 1 },
      }),
    ).toBe(0);

    const events = tracker.sweepExpired({
      nowMs: now,
      resolveCooldownConfig: () => ({ mode: 'minutes', minutes: 1 }),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      cooldownEndMs: 61_000,
      triggerCountAtExpire: 1,
    });
  });
});
