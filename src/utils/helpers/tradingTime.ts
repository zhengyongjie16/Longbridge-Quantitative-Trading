import { TIME } from '../../constants/index.js';
import type {
  HKTime,
  OrderTimeoutCheckParams,
  TradingCalendarDayInfo,
  TradingDurationBetweenParams,
} from './types.js';

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = MINUTES_PER_DAY * MS_PER_MINUTE;
const HK_DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

type SessionRange = Readonly<{
  startMs: number;
  endMs: number;
}>;

/**
 * 将 UTC 时间转换为香港时区（UTC+8）的小时与分钟。默认行为：date 为 null/undefined 时返回 null。
 *
 * @param date 时间对象（UTC）
 * @returns 香港时区的小时与分钟（hkHour、hkMinute），无效时返回 null
 */
export function getHKTime(date: Date | null | undefined): HKTime | null {
  if (!date) return null;
  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();
  const offsetHours = TIME.HONG_KONG_TIMEZONE_OFFSET_MS / (60 * 60 * 1000);
  return {
    hkHour: (utcHour + offsetHours) % 24,
    hkMinute: utcMinute,
  };
}

/**
 * 获取港股日期键（UTC+8，YYYY-MM-DD）。默认行为：date 为 null/undefined 时返回 null。
 *
 * @param date 时间对象
 * @returns YYYY-MM-DD 格式日期键，无效时返回 null
 */
export function getHKDateKey(date: Date | null | undefined): string | null {
  if (!date) return null;
  const hkDate = new Date(date.getTime() + TIME.HONG_KONG_TIMEZONE_OFFSET_MS);
  const year = hkDate.getUTCFullYear();
  const month = String(hkDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(hkDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 计算当日已开盘分钟数（按正常交易日 09:30–12:00、13:00–16:00 累计，不区分半日市）。默认行为：date 无效或未开盘返回 0。
 *
 * @param date 时间对象（UTC）
 * @returns 已开盘分钟数
 */
export function getTradingMinutesSinceOpen(date: Date | null | undefined): number {
  if (!date) return 0;
  const hkTime = getHKTime(date);
  if (!hkTime) return 0;

  const { hkHour, hkMinute } = hkTime;
  const currentMinutes = hkHour * 60 + hkMinute;

  const morningOpen = 9 * 60 + 30;
  const morningClose = 12 * 60;
  const afternoonOpen = 13 * 60;
  const afternoonClose = 16 * 60;
  const morningMinutes = morningClose - morningOpen;
  const afternoonMinutes = afternoonClose - afternoonOpen;

  if (currentMinutes < morningOpen) {
    return 0;
  }
  if (currentMinutes < morningClose) {
    return currentMinutes - morningOpen;
  }
  if (currentMinutes < afternoonOpen) {
    return morningMinutes;
  }
  if (currentMinutes < afternoonClose) {
    return morningMinutes + (currentMinutes - afternoonOpen);
  }
  return morningMinutes + afternoonMinutes;
}

/**
 * 判断是否在港股连续交易时段（仅检查时间，不检查是否交易日）。默认行为：date 无效返回 false；半日市仅看上午 09:30–12:00，正常日含下午 13:00–16:00。
 *
 * @param date 时间对象（UTC）
 * @param isHalfDay 是否为半日交易日
 * @returns 在连续交易时段为 true，否则 false
 */
export function isInContinuousHKSession(
  date: Date | null | undefined,
  isHalfDay: boolean = false,
): boolean {
  if (!date) return false;
  // 将时间转换为香港时区（UTC+8）
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

  // 上午连续交易时段：09:30 - 12:00（不含 12:00 本身）
  const inMorning =
    (hkHour === 9 && hkMinute >= 30) || // 9:30 - 9:59
    (hkHour >= 10 && hkHour < 12); // 10:00 - 11:59

  // 半日交易日：仅上午时段有效，下午无交易
  if (isHalfDay) {
    return inMorning;
  }

  // 下午连续交易时段：13:00 - 15:59:59
  // 注意：16:00:00 是收盘时间，不包含在连续交易时段内
  const inAfternoon = hkHour >= 13 && hkHour < 16; // 13:00 - 15:59

  return inMorning || inAfternoon;
}

/**
 * 判断是否在早盘开盘保护时段（仅早盘有效）。默认行为：date 无效或 minutes 非正返回 false；下午时段不生效。
 *
 * @param date 时间对象（UTC）
 * @param minutes 保护时长（分钟）
 * @returns 在早盘开盘保护窗口内为 true，否则为 false
 */
export function isWithinMorningOpenProtection(
  date: Date | null | undefined,
  minutes: number,
): boolean {
  if (!date || !Number.isFinite(minutes) || minutes <= 0) return false;
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

  // 下午时段一律不生效
  if (hkHour >= 12) {
    return false;
  }

  const currentMinutes = hkHour * 60 + hkMinute;
  const startMinutes = 9 * 60 + 30;
  const endMinutes = startMinutes + minutes;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * 判断是否在午盘开盘保护时段（仅午盘有效）。默认行为：date 无效或 minutes 非正返回 false；上午及午休不生效。
 *
 * @param date 时间对象（UTC）
 * @param minutes 保护时长（分钟）
 * @returns 在午盘开盘保护窗口内为 true，否则为 false
 */
export function isWithinAfternoonOpenProtection(
  date: Date | null | undefined,
  minutes: number,
): boolean {
  if (!date || !Number.isFinite(minutes) || minutes <= 0) return false;
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

  // 上午时段和午休时段不生效
  if (hkHour < 13) {
    return false;
  }

  const currentMinutes = hkHour * 60 + hkMinute;
  const startMinutes = 13 * 60; // 13:00
  const endMinutes = startMinutes + minutes;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * 判断是否在当日收盘前 15 分钟内（末日保护：拒绝买入）。默认行为：date 无效返回 false；半日市按 12:00 收盘计算。
 *
 * @param date 时间对象（UTC）
 * @param isHalfDay 是否为半日交易日，默认 false
 * @returns 在收盘前 15 分钟窗口内为 true，否则为 false
 */
export function isBeforeClose15Minutes(
  date: Date | null | undefined,
  isHalfDay: boolean = false,
): boolean {
  return isBeforeCloseMinutes(date, 15, isHalfDay);
}

/**
 * 判断是否在当日收盘前 5 分钟内（末日保护：自动清仓）。默认行为：date 无效返回 false；半日市按 12:00 收盘计算。
 *
 * @param date 时间对象（UTC）
 * @param isHalfDay 是否为半日交易日，默认 false
 * @returns 在收盘前 5 分钟窗口内为 true，否则为 false
 */
export function isBeforeClose5Minutes(
  date: Date | null | undefined,
  isHalfDay: boolean = false,
): boolean {
  return isBeforeCloseMinutes(date, 5, isHalfDay);
}

/**
 * 判断是否在当日收盘前指定分钟数内（用于末日保护等）。半日市按 12:00 收盘，正常日按 16:00。
 *
 * @param date 时间对象（UTC）
 * @param minutes 距离收盘的分钟数（正数）
 * @param isHalfDay 是否为半日交易日，默认 false
 * @returns 在收盘前该分钟数窗口内返回 true，否则返回 false
 */
function isBeforeCloseMinutes(
  date: Date | null | undefined,
  minutes: number,
  isHalfDay: boolean = false,
): boolean {
  if (!date || !Number.isFinite(minutes) || minutes <= 0) return false;
  const hkTime = getHKTime(date);
  if (!hkTime) return false;

  const closeHour = isHalfDay ? 12 : 16;
  const closeMinutes = closeHour * 60;
  const currentMinutes = hkTime.hkHour * 60 + hkTime.hkMinute;

  return currentMinutes >= closeMinutes - minutes && currentMinutes < closeMinutes;
}

/**
 * 计算两个时间点之间的交易时段累计毫秒（严格按交易日历快照与会话时段累计）。
 *
 * 规则：
 * - 仅累计交易日连续交易时段（正常日：09:30-12:00、13:00-16:00；半日市：09:30-12:00）
 * - 午休、收盘后、非交易日、节假日不计时
 * - 快照缺失日期按非交易日处理（返回 0 增量）
 *
 * @param params - 起止时间与交易日历快照
 * @returns 交易时段累计毫秒
 */
export function calculateTradingDurationMsBetween(params: TradingDurationBetweenParams): number {
  const { startMs, endMs, calendarSnapshot } = params;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }

  let totalMs = 0;
  let cursorMs = startMs;

  while (cursorMs < endMs) {
    const cursorDate = new Date(cursorMs);
    const dayKey = getHKDateKey(cursorDate);
    if (!dayKey) {
      break;
    }

    const dayStartUtcMs = resolveHKDayStartUtcMs(dayKey);
    if (dayStartUtcMs === null) {
      break;
    }

    const nextDayStartUtcMs = dayStartUtcMs + MS_PER_DAY;
    const segmentEndMs = Math.min(endMs, nextDayStartUtcMs);

    const dayInfo = calendarSnapshot.get(dayKey);
    if (dayInfo?.isTradingDay) {
      const sessionRanges = resolveSessionRangesByDay(dayStartUtcMs, dayInfo);
      for (const session of sessionRanges) {
        totalMs += calculateOverlapMs(cursorMs, segmentEndMs, session.startMs, session.endMs);
      }
    }

    cursorMs = segmentEndMs;
  }

  return totalMs;
}

/**
 * 语义化别名：计算持仓区间内的交易时段累计毫秒。
 * @param params - 交易时段累计时长计算参数
 * @returns 持仓交易时段累计毫秒
 */
function calculateHeldTradingDurationMs(params: TradingDurationBetweenParams): number {
  return calculateTradingDurationMsBetween(params);
}

/**
 * 按严格交易时段累计口径判定订单是否超时。
 * 触发条件：heldTradingMs > timeoutMinutes * 60_000（严格大于）。
 *
 * @param params - 订单成交时间、当前时间、超时分钟与交易日历快照
 * @returns true 表示超时；false 表示未超时或参数无效
 */
export function isOrderTimedOut(params: OrderTimeoutCheckParams): boolean {
  const { orderExecutedTimeMs, nowMs, timeoutMinutes, calendarSnapshot } = params;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 0) {
    return false;
  }

  const timeoutMs = timeoutMinutes * MS_PER_MINUTE;
  const heldTradingMs = calculateHeldTradingDurationMs({
    startMs: orderExecutedTimeMs,
    endMs: nowMs,
    calendarSnapshot,
  });

  return heldTradingMs > timeoutMs;
}

/**
 * 枚举起止时间区间覆盖的港股日期键列表（含首尾日期）。
 * @param startMs - 区间起点毫秒时间戳
 * @param endMs - 区间终点毫秒时间戳
 * @returns 升序日期键数组
 */
export function listHKDateKeysBetween(startMs: number, endMs: number): ReadonlyArray<string> {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return [];
  }

  const startKey = getHKDateKey(new Date(startMs));
  const endKey = getHKDateKey(new Date(endMs));
  if (!startKey || !endKey) {
    return [];
  }

  const startDayStartUtcMs = resolveHKDayStartUtcMs(startKey);
  const endDayStartUtcMs = resolveHKDayStartUtcMs(endKey);
  if (startDayStartUtcMs === null || endDayStartUtcMs === null) {
    return [];
  }

  const keys: string[] = [];
  for (
    let cursorDayStartUtcMs = startDayStartUtcMs;
    cursorDayStartUtcMs <= endDayStartUtcMs;
    cursorDayStartUtcMs += MS_PER_DAY
  ) {
    const key = getHKDateKey(new Date(cursorDayStartUtcMs));
    if (key) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * 解析港股日期键并返回该港股日 00:00 对应的 UTC 毫秒时间戳。
 */
function resolveHKDayStartUtcMs(dayKey: string): number | null {
  const match = HK_DATE_KEY_PATTERN.exec(dayKey);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const utcMs = Date.UTC(year, month - 1, day) - TIME.HONG_KONG_TIMEZONE_OFFSET_MS;
  if (!Number.isFinite(utcMs)) {
    return null;
  }
  return utcMs;
}

/**
 * 根据交易日类型生成当日交易会话区间（UTC 毫秒）。
 */
function resolveSessionRangesByDay(
  dayStartUtcMs: number,
  dayInfo: TradingCalendarDayInfo,
): ReadonlyArray<SessionRange> {
  const morningSession: SessionRange = {
    startMs: dayStartUtcMs + (9 * 60 + 30) * MS_PER_MINUTE,
    endMs: dayStartUtcMs + 12 * 60 * MS_PER_MINUTE,
  };

  if (dayInfo.isHalfDay) {
    return [morningSession];
  }

  const afternoonSession: SessionRange = {
    startMs: dayStartUtcMs + 13 * 60 * MS_PER_MINUTE,
    endMs: dayStartUtcMs + 16 * 60 * MS_PER_MINUTE,
  };

  return [morningSession, afternoonSession];
}

/**
 * 计算两个半开区间 [aStart, aEnd) 与 [bStart, bEnd) 的重叠毫秒数。
 */
function calculateOverlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  if (overlapEnd <= overlapStart) {
    return 0;
  }
  return overlapEnd - overlapStart;
}
