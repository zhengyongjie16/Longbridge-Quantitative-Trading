/**
 * liquidationCooldown 业务测试
 *
 * 功能：
 * - 验证清仓冷却追踪相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createLiquidationCooldownTracker } from '../../../src/services/liquidationCooldown/index.js';

describe('liquidationCooldown business flow', () => {
  it('applies minutes-mode cooldown and auto-expires records', () => {
    let now = 1_000_000;
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => now,
    });

    tracker.recordCooldown({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now,
    });

    now += 4 * 60_000;
    const remainingBeforeExpire = tracker.getRemainingMs({
      symbol: 'HSI.HK',
      direction: 'LONG',
      cooldownConfig: { mode: 'minutes', minutes: 5 },
    });
    expect(remainingBeforeExpire).toBe(60_000);

    now += 61_000;
    const remainingAfterExpire = tracker.getRemainingMs({
      symbol: 'HSI.HK',
      direction: 'LONG',
      cooldownConfig: { mode: 'minutes', minutes: 5 },
    });
    expect(remainingAfterExpire).toBe(0);
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

  it('clears only midnight-eligible keys', () => {
    let now = 10_000;
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => now,
    });

    tracker.recordCooldown({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: now,
    });

    tracker.recordCooldown({
      symbol: 'HSI.HK',
      direction: 'SHORT',
      executedTimeMs: now,
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

    now += 1_000;
    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'SHORT',
        cooldownConfig: { mode: 'minutes', minutes: 10 },
      }),
    ).toBe(599_000);
  });
});
