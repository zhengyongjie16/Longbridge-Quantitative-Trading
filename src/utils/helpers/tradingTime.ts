import { TIME } from '../../constants/index.js';
import type { HKTime } from './types.js';

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
