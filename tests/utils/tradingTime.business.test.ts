/**
 * tradingTime 业务测试
 *
 * 功能：
 * - 验证严格交易时段累计毫秒计算（含跨午休/跨日/跨半日市/跨周末）
 * - 验证超时判定边界（严格大于阈值才触发）
 */
import { describe, it, expect } from 'bun:test';
import {
  calculateTradingDurationMsBetween,
  isOrderTimedOut,
} from '../../src/utils/helpers/tradingTime.js';
import type { TradingCalendarSnapshot } from '../../src/types/tradingCalendar.js';

function createCalendar(
  entries: ReadonlyArray<[string, { isTradingDay: boolean; isHalfDay: boolean }]>,
): TradingCalendarSnapshot {
  return new Map(entries);
}

describe('trading time accumulation', () => {
  it('同日早盘累计', () => {
    const durationMs = calculateTradingDurationMsBetween({
      startMs: Date.parse('2026-02-24T01:30:00.000Z'), // 09:30 HK
      endMs: Date.parse('2026-02-24T02:00:00.000Z'), // 10:00 HK
      calendarSnapshot: createCalendar([['2026-02-24', { isTradingDay: true, isHalfDay: false }]]),
    });
    expect(durationMs).toBe(30 * 60_000);
  });

  it('同日下午累计', () => {
    const durationMs = calculateTradingDurationMsBetween({
      startMs: Date.parse('2026-02-24T05:00:00.000Z'), // 13:00 HK
      endMs: Date.parse('2026-02-24T05:45:00.000Z'), // 13:45 HK
      calendarSnapshot: createCalendar([['2026-02-24', { isTradingDay: true, isHalfDay: false }]]),
    });
    expect(durationMs).toBe(45 * 60_000);
  });

  it('跨午休仅累计交易时段', () => {
    const durationMs = calculateTradingDurationMsBetween({
      startMs: Date.parse('2026-02-24T03:50:00.000Z'), // 11:50 HK
      endMs: Date.parse('2026-02-24T05:10:00.000Z'), // 13:10 HK
      calendarSnapshot: createCalendar([['2026-02-24', { isTradingDay: true, isHalfDay: false }]]),
    });
    expect(durationMs).toBe(20 * 60_000);
  });

  it('跨正常交易日累计', () => {
    const durationMs = calculateTradingDurationMsBetween({
      startMs: Date.parse('2026-02-24T07:50:00.000Z'), // 15:50 HK
      endMs: Date.parse('2026-02-25T01:40:00.000Z'), // 次日 09:40 HK
      calendarSnapshot: createCalendar([
        ['2026-02-24', { isTradingDay: true, isHalfDay: false }],
        ['2026-02-25', { isTradingDay: true, isHalfDay: false }],
      ]),
    });
    expect(durationMs).toBe(20 * 60_000);
  });

  it('跨半日市按半日会话累计', () => {
    const durationMs = calculateTradingDurationMsBetween({
      startMs: Date.parse('2026-02-24T03:50:00.000Z'), // 半日市 11:50 HK
      endMs: Date.parse('2026-02-25T01:40:00.000Z'), // 次日 09:40 HK
      calendarSnapshot: createCalendar([
        ['2026-02-24', { isTradingDay: true, isHalfDay: true }],
        ['2026-02-25', { isTradingDay: true, isHalfDay: false }],
      ]),
    });
    expect(durationMs).toBe(20 * 60_000);
  });

  it('跨周末仅累计交易日', () => {
    const durationMs = calculateTradingDurationMsBetween({
      startMs: Date.parse('2026-02-27T07:50:00.000Z'), // 周五 15:50 HK
      endMs: Date.parse('2026-03-02T01:40:00.000Z'), // 周一 09:40 HK
      calendarSnapshot: createCalendar([
        ['2026-02-27', { isTradingDay: true, isHalfDay: false }],
        ['2026-02-28', { isTradingDay: false, isHalfDay: false }],
        ['2026-03-01', { isTradingDay: false, isHalfDay: false }],
        ['2026-03-02', { isTradingDay: true, isHalfDay: false }],
      ]),
    });
    expect(durationMs).toBe(20 * 60_000);
  });
});

describe('order timeout boundary', () => {
  it('heldTradingMs == timeoutMs 不触发，+1ms 触发', () => {
    const calendar = createCalendar([['2026-02-24', { isTradingDay: true, isHalfDay: false }]]);
    const orderExecutedTimeMs = Date.parse('2026-02-24T01:30:00.000Z'); // 09:30 HK

    const equalTimeout = isOrderTimedOut({
      orderExecutedTimeMs,
      nowMs: Date.parse('2026-02-24T02:30:00.000Z'), // 10:30 HK，刚好 60 分钟
      timeoutMinutes: 60,
      calendarSnapshot: calendar,
    });
    expect(equalTimeout).toBe(false);

    const plusOneMsTimeout = isOrderTimedOut({
      orderExecutedTimeMs,
      nowMs: Date.parse('2026-02-24T02:30:00.001Z'),
      timeoutMinutes: 60,
      calendarSnapshot: calendar,
    });
    expect(plusOneMsTimeout).toBe(true);
  });
});
