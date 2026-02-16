import { describe, expect, it } from 'bun:test';

import { createDayLifecycleManager } from '../../src/main/lifecycle/dayLifecycleManager.js';

import type { LifecycleMutableState } from '../../src/main/lifecycle/types.js';

function createMutableState(): LifecycleMutableState {
  return {
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
  };
}

describe('lifecycle-crossday integration', () => {
  it('runs midnight clear then open rebuild and restores trading gate', async () => {
    const mutableState = createMutableState();
    const calls: string[] = [];

    const manager = createDayLifecycleManager({
      mutableState,
      cacheDomains: [
        {
          midnightClear: async () => {
            calls.push('A.midnight');
          },
          openRebuild: async () => {
            calls.push('A.open');
          },
        },
        {
          midnightClear: async () => {
            calls.push('B.midnight');
          },
          openRebuild: async () => {
            calls.push('B.open');
          },
        },
      ],
      logger: {
        info: () => {},
        error: () => {},
      } as never,
      rebuildRetryDelayMs: 10,
    });

    await manager.tick(new Date('2026-02-16T16:00:00.000Z'), {
      dayKey: '2026-02-17',
      isTradingDay: false,
      canTradeNow: false,
    });

    expect(calls).toEqual(['A.midnight', 'B.midnight']);
    expect(mutableState.pendingOpenRebuild).toBeTrue();
    expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
    expect(mutableState.isTradingEnabled).toBeFalse();

    await manager.tick(new Date('2026-02-16T16:01:00.000Z'), {
      dayKey: '2026-02-17',
      isTradingDay: true,
      canTradeNow: false,
    });

    expect(calls).toEqual(['A.midnight', 'B.midnight']);
    expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
    expect(mutableState.isTradingEnabled).toBeFalse();

    await manager.tick(new Date('2026-02-16T16:02:00.000Z'), {
      dayKey: '2026-02-17',
      isTradingDay: true,
      canTradeNow: true,
    });

    expect(calls).toEqual(['A.midnight', 'B.midnight', 'B.open', 'A.open']);
    expect(mutableState.pendingOpenRebuild).toBeFalse();
    expect(mutableState.lifecycleState).toBe('ACTIVE');
    expect(mutableState.isTradingEnabled).toBeTrue();
  });

  it('retries failed midnight clear with backoff and then continues lifecycle', async () => {
    const mutableState = createMutableState();
    let midnightAttempts = 0;

    const manager = createDayLifecycleManager({
      mutableState,
      cacheDomains: [
        {
          midnightClear: async () => {
            midnightAttempts += 1;
            if (midnightAttempts === 1) {
              throw new Error('transient midnight failure');
            }
          },
          openRebuild: async () => {},
        },
      ],
      logger: {
        info: () => {},
        error: () => {},
      } as never,
      rebuildRetryDelayMs: 20,
    });

    await manager.tick(new Date('2026-02-16T16:00:00.000Z'), {
      dayKey: '2026-02-17',
      isTradingDay: false,
      canTradeNow: false,
    });

    expect(midnightAttempts).toBe(1);
    expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANING');
    expect(mutableState.pendingOpenRebuild).toBeFalse();

    await manager.tick(new Date('2026-02-16T16:00:00.010Z'), {
      dayKey: '2026-02-17',
      isTradingDay: false,
      canTradeNow: false,
    });

    expect(midnightAttempts).toBe(1);

    await manager.tick(new Date('2026-02-16T16:00:00.030Z'), {
      dayKey: '2026-02-17',
      isTradingDay: false,
      canTradeNow: false,
    });

    expect(midnightAttempts).toBe(2);
    expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
    expect(mutableState.pendingOpenRebuild).toBeTrue();
  });
});
