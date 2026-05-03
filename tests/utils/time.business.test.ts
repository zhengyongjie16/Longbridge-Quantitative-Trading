/**
 * time 业务测试
 *
 * 功能：
 * - 验证严格交易时段累计毫秒计算（含跨午休/跨日/跨半日市/跨周末）
 * - 验证超时判定边界（严格大于阈值才触发）
 */
import { describe, it, expect } from 'bun:test';
import { isOrderTimedOut } from '../../src/core/orderRecorder/utils.js';
import {
  calculateTradingDurationDueAtMs,
  calculateTradingDurationMsBetween,
} from '../../src/utils/time/index.js';
import type { TradingCalendarSnapshot } from '../../src/types/tradingCalendar.js';

/**
 * 生成测试用交易日历快照，默认行为：按输入顺序构造 Map。
 *
 * @param entries 交易日条目数组
 * @returns TradingCalendarSnapshot
 */
function createCalendar(
  entries: ReadonlyArray<[string, { isTradingDay: boolean; isHalfDay: boolean }]>,
): TradingCalendarSnapshot {
  return new Map(entries);
}

function hkMs(day: string, hour: number, minute: number): number {
  return Date.parse(`${day}T00:00:00.000+08:00`) + (hour * 60 + minute) * 60_000;
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

describe('trading duration due time', () => {
  it('跳过午休计算到期时间', () => {
    const dueAtMs = calculateTradingDurationDueAtMs({
      startMs: hkMs('2026-04-29', 11, 50),
      targetDurationMs: 20 * 60_000,
      calendarSnapshot: createCalendar([['2026-04-29', { isTradingDay: true, isHalfDay: false }]]),
    });

    expect(dueAtMs).toBe(hkMs('2026-04-29', 13, 10));
  });

  it('跨交易日累计到期时间', () => {
    const dueAtMs = calculateTradingDurationDueAtMs({
      startMs: hkMs('2026-04-29', 15, 50),
      targetDurationMs: 20 * 60_000,
      calendarSnapshot: createCalendar([
        ['2026-04-29', { isTradingDay: true, isHalfDay: false }],
        ['2026-04-30', { isTradingDay: true, isHalfDay: false }],
      ]),
    });

    expect(dueAtMs).toBe(hkMs('2026-04-30', 9, 40));
  });

  it('按半日市会话计算到期时间', () => {
    const dueAtMs = calculateTradingDurationDueAtMs({
      startMs: hkMs('2026-04-29', 11, 50),
      targetDurationMs: 20 * 60_000,
      calendarSnapshot: createCalendar([
        ['2026-04-29', { isTradingDay: true, isHalfDay: true }],
        ['2026-04-30', { isTradingDay: true, isHalfDay: false }],
      ]),
    });

    expect(dueAtMs).toBe(hkMs('2026-04-30', 9, 40));
  });

  it('交易日历无法覆盖目标时返回 null', () => {
    const dueAtMs = calculateTradingDurationDueAtMs({
      startMs: hkMs('2026-04-29', 15, 50),
      targetDurationMs: 20 * 60_000,
      calendarSnapshot: createCalendar([['2026-04-29', { isTradingDay: true, isHalfDay: false }]]),
    });

    expect(dueAtMs).toBeNull();
  });

  it('起点早于开盘时只从 09:30 开始累计', () => {
    const dueAtMs = calculateTradingDurationDueAtMs({
      startMs: hkMs('2026-04-29', 8, 50),
      targetDurationMs: 20 * 60_000,
      calendarSnapshot: createCalendar([['2026-04-29', { isTradingDay: true, isHalfDay: false }]]),
    });

    expect(dueAtMs).toBe(hkMs('2026-04-29', 9, 50));
  });

  it('起点在午休时从 13:00 继续累计', () => {
    const dueAtMs = calculateTradingDurationDueAtMs({
      startMs: hkMs('2026-04-29', 12, 30),
      targetDurationMs: 20 * 60_000,
      calendarSnapshot: createCalendar([['2026-04-29', { isTradingDay: true, isHalfDay: false }]]),
    });

    expect(dueAtMs).toBe(hkMs('2026-04-29', 13, 20));
  });

  it('起点晚于收盘时只通过显式后续交易日历事实推进', () => {
    const dueAtMs = calculateTradingDurationDueAtMs({
      startMs: hkMs('2026-04-29', 16, 30),
      targetDurationMs: 20 * 60_000,
      calendarSnapshot: createCalendar([
        ['2026-04-29', { isTradingDay: true, isHalfDay: false }],
        ['2026-04-30', { isTradingDay: true, isHalfDay: false }],
      ]),
    });

    expect(dueAtMs).toBe(hkMs('2026-04-30', 9, 50));
  });

  it('起点位于非交易日时只通过显式后续交易日历事实推进', () => {
    const dueAtMs = calculateTradingDurationDueAtMs({
      startMs: hkMs('2026-04-29', 10, 0),
      targetDurationMs: 20 * 60_000,
      calendarSnapshot: createCalendar([
        ['2026-04-29', { isTradingDay: false, isHalfDay: false }],
        ['2026-04-30', { isTradingDay: true, isHalfDay: false }],
      ]),
    });

    expect(dueAtMs).toBe(hkMs('2026-04-30', 9, 50));
  });

  it('会话边界使用半开区间且不重复累计边界分钟', () => {
    const dueAtMs = calculateTradingDurationDueAtMs({
      startMs: hkMs('2026-04-29', 12, 0),
      targetDurationMs: 1,
      calendarSnapshot: createCalendar([['2026-04-29', { isTradingDay: true, isHalfDay: false }]]),
    });

    expect(dueAtMs).toBe(hkMs('2026-04-29', 13, 0) + 1);
  });

  it('缺少起始日日期事实时返回 null', () => {
    const dueAtMs = calculateTradingDurationDueAtMs({
      startMs: hkMs('2026-04-29', 10, 0),
      targetDurationMs: 20 * 60_000,
      calendarSnapshot: createCalendar([['2026-04-30', { isTradingDay: true, isHalfDay: false }]]),
    });

    expect(dueAtMs).toBeNull();
  });

  it('跨日路径存在中间日期事实缺口时返回 null', () => {
    const dueAtMs = calculateTradingDurationDueAtMs({
      startMs: hkMs('2026-04-29', 15, 50),
      targetDurationMs: 20 * 60_000,
      calendarSnapshot: createCalendar([
        ['2026-04-29', { isTradingDay: true, isHalfDay: false }],
        ['2026-05-01', { isTradingDay: true, isHalfDay: false }],
      ]),
    });

    expect(dueAtMs).toBeNull();
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
