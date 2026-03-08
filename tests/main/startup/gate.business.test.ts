/**
 * startup/gate 业务测试
 *
 * 功能：
 * - 冻结 startup gate 的 skip/strict 等待语义
 * - 验证 strict 模式下交易日、连续交易时段与开盘保护的等待顺序
 */
import { describe, expect, it } from 'bun:test';
import { createStartupGate } from '../../../src/main/startup/gate.js';
import type { Logger } from '../../../src/utils/logger/types.js';

function createLoggerStub(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe('startup gate business flow', () => {
  it('returns immediately in skip mode without polling runtime conditions', async () => {
    let resolveCalls = 0;
    let sleepCalls = 0;

    const gate = createStartupGate({
      now: () => new Date('2026-03-02T01:00:00.000Z'),
      sleep: async () => {
        sleepCalls += 1;
      },
      resolveTradingDayInfo: async () => {
        resolveCalls += 1;
        return {
          isTradingDay: false,
          isHalfDay: false,
        };
      },
      isInSession: () => false,
      isInMorningOpenProtection: () => true,
      isInAfternoonOpenProtection: () => true,
      openProtection: {
        morning: {
          enabled: true,
          minutes: 5,
        },
        afternoon: {
          enabled: true,
          minutes: 5,
        },
      },
      intervalMs: 1000,
      logger: createLoggerStub(),
    });

    const result = await gate.wait({ mode: 'skip' });

    expect(result).toEqual({
      isTradingDay: true,
      isHalfDay: false,
    });

    expect(resolveCalls).toBe(0);
    expect(sleepCalls).toBe(0);
  });

  it('waits through non-trading-day, out-of-session and open-protection states before continuing', async () => {
    const nowQueue = [
      new Date('2026-03-01T01:00:00.000Z'),
      new Date('2026-03-02T00:30:00.000Z'),
      new Date('2026-03-02T01:00:00.000Z'),
      new Date('2026-03-02T01:06:00.000Z'),
    ];
    let nowIndex = 0;
    const sleepCalls: number[] = [];

    const gate = createStartupGate({
      now: () => {
        const current = nowQueue[nowIndex];
        const fallback = nowQueue.at(-1);
        nowIndex += 1;
        if (!current) {
          if (!fallback) {
            throw new Error('now queue should provide a fallback time');
          }

          return fallback;
        }

        return current;
      },
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      resolveTradingDayInfo: async (currentTime) => {
        const iso = currentTime.toISOString();
        if (iso === '2026-03-01T01:00:00.000Z') {
          return {
            isTradingDay: false,
            isHalfDay: false,
          };
        }

        return {
          isTradingDay: true,
          isHalfDay: false,
        };
      },
      isInSession: (currentTime) => {
        return currentTime.toISOString() !== '2026-03-02T00:30:00.000Z';
      },
      isInMorningOpenProtection: (currentTime) => {
        return currentTime.toISOString() === '2026-03-02T01:00:00.000Z';
      },
      isInAfternoonOpenProtection: () => false,
      openProtection: {
        morning: {
          enabled: true,
          minutes: 5,
        },
        afternoon: {
          enabled: false,
          minutes: null,
        },
      },
      intervalMs: 1000,
      logger: createLoggerStub(),
    });

    const result = await gate.wait({ mode: 'strict' });

    expect(result).toEqual({
      isTradingDay: true,
      isHalfDay: false,
    });

    expect(sleepCalls).toEqual([1000, 1000, 1000]);
  });
});
