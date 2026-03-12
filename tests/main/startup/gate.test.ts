import { describe, expect, it } from 'bun:test';
import { createStartupGate } from '../../../src/main/startup/gate.js';
import type { StartupGateDeps } from '../../../src/main/startup/types.js';

const logger: StartupGateDeps['logger'] = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

function createDeps(overrides: Partial<StartupGateDeps> = {}): StartupGateDeps {
  return {
    now: () => new Date('2026-03-10T01:00:00.000Z'),
    sleep: async () => {},
    resolveTradingDayInfo: async () => ({
      isTradingDay: true,
      isHalfDay: false,
    }),
    isInSession: () => true,
    isInMorningOpenProtection: () => false,
    isInAfternoonOpenProtection: () => false,
    openProtection: {
      morning: {
        enabled: true,
        minutes: 15,
      },
      afternoon: {
        enabled: true,
        minutes: 15,
      },
    },
    intervalMs: 1_000,
    logger,
    ...overrides,
  };
}

describe('createStartupGate', () => {
  it('polls until trading day and session become available', async () => {
    const times = [
      new Date('2026-03-08T01:00:00.000Z'),
      new Date('2026-03-10T01:00:00.000Z'),
      new Date('2026-03-10T01:01:00.000Z'),
    ];
    let index = 0;
    const sleepCalls: number[] = [];
    const gate = createStartupGate(
      createDeps({
        now: () => {
          const current = times.at(Math.min(index, times.length - 1)) ?? times.at(-1) ?? new Date();
          index += 1;
          return current;
        },
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        resolveTradingDayInfo: async (currentTime) => ({
          isTradingDay: currentTime.getUTCDate() !== 8,
          isHalfDay: false,
        }),
        isInSession: (currentTime) => currentTime.getUTCMinutes() > 0,
      }),
    );

    const result = await gate.wait({ mode: 'strict' });

    expect(result).toEqual({
      isTradingDay: true,
      isHalfDay: false,
    });
    expect(sleepCalls).toEqual([1_000, 1_000]);
  });

  it('waits until open protection window ends', async () => {
    const times = [new Date('2026-03-10T01:00:00.000Z'), new Date('2026-03-10T01:16:00.000Z')];
    let index = 0;
    const sleepCalls: number[] = [];
    const gate = createStartupGate(
      createDeps({
        now: () => {
          const current = times.at(Math.min(index, times.length - 1)) ?? times.at(-1) ?? new Date();
          index += 1;
          return current;
        },
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        isInMorningOpenProtection: (currentTime) => currentTime.getUTCMinutes() < 15,
      }),
    );

    const result = await gate.wait({ mode: 'strict' });

    expect(result).toEqual({
      isTradingDay: true,
      isHalfDay: false,
    });
    expect(sleepCalls).toEqual([1_000]);
  });

  it('waits until afternoon open protection window ends on full trading days', async () => {
    const times = [new Date('2026-03-10T05:00:00.000Z'), new Date('2026-03-10T05:16:00.000Z')];
    let index = 0;
    const sleepCalls: number[] = [];
    const gate = createStartupGate(
      createDeps({
        now: () => {
          const current = times.at(Math.min(index, times.length - 1)) ?? times.at(-1) ?? new Date();
          index += 1;
          return current;
        },
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        isInAfternoonOpenProtection: (currentTime, minutes) =>
          currentTime.getUTCHours() === 5 && currentTime.getUTCMinutes() < minutes,
      }),
    );

    const result = await gate.wait({ mode: 'strict' });

    expect(result).toEqual({
      isTradingDay: true,
      isHalfDay: false,
    });
    expect(sleepCalls).toEqual([1_000]);
  });

  it('returns immediately in skip mode', async () => {
    let resolveCalls = 0;
    let sleepCalls = 0;
    const gate = createStartupGate(
      createDeps({
        sleep: async () => {
          sleepCalls += 1;
        },
        resolveTradingDayInfo: async () => {
          resolveCalls += 1;
          return {
            isTradingDay: true,
            isHalfDay: false,
          };
        },
      }),
    );

    const result = await gate.wait({ mode: 'skip' });

    expect(result).toEqual({
      isTradingDay: true,
      isHalfDay: false,
    });
    expect(resolveCalls).toBe(0);
    expect(sleepCalls).toBe(0);
  });

  it('propagates dependency errors from strict mode', async () => {
    const gate = createStartupGate(
      createDeps({
        resolveTradingDayInfo: async () => {
          throw new Error('trading day lookup failed');
        },
      }),
    );

    expect(gate.wait({ mode: 'strict' })).rejects.toThrow('trading day lookup failed');
  });
});
