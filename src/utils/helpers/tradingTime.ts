/**
 * 交易时间相关工具函数
 */

import type { HKTime } from './types.js';

/**
 * 将UTC时间转换为香港时区（UTC+8）
 * @param date 时间对象（UTC时间）
 * @returns 香港时区的小时和分钟，如果date无效则返回null
 */
export function getHKTime(date: Date | null | undefined): HKTime | null {
  if (!date) return null;
  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();
  return {
    hkHour: (utcHour + 8) % 24,
    hkMinute: utcMinute,
  };
}

/**
 * 判断是否在港股连续交易时段（仅检查时间，不检查是否是交易日）
 * 港股连续交易时段：
 * - 正常交易日：上午 09:30 - 12:00，下午 13:00 - 16:00
 * - 半日交易日：仅上午 09:30 - 12:00（无下午时段）
 * @param date 时间对象（应该是UTC时间）
 * @param isHalfDay 是否是半日交易日
 * @returns true表示在连续交易时段，false表示不在
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
 * 判断是否在早盘开盘保护时段（仅早盘有效）
 * 开盘波动较大，指标可靠性下降，可在此窗口暂缓信号生成
 * @param date 时间对象（应该是UTC时间）
 * @param minutes 保护时长（分钟）
 * @returns true表示在保护时段，false表示不在
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
 * 判断是否在当日收盘前15分钟内（末日保护程序：拒绝买入）
 * 港股正常交易日收盘时间：下午 16:00，收盘前15分钟：15:45 - 15:59
 * 港股半日交易日收盘时间：中午 12:00，收盘前15分钟：11:45 - 11:59
 * @param date 时间对象（应该是UTC时间）
 * @param isHalfDay 是否是半日交易日
 * @returns true表示在收盘前15分钟，false表示不在
 */
export function isBeforeClose15Minutes(
  date: Date | null | undefined,
  isHalfDay: boolean = false,
): boolean {
  if (!date) return false;
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

  if (isHalfDay) {
    // 半日交易：收盘前15分钟为 11:45 - 11:59:59（12:00收盘）
    return hkHour === 11 && hkMinute >= 45;
  }
  // 正常交易日：收盘前15分钟为 15:45 - 15:59:59（16:00收盘）
  return hkHour === 15 && hkMinute >= 45;
}

/**
 * 判断是否在当日收盘前5分钟内（末日保护程序：自动清仓）
 * 港股正常交易日收盘时间：下午 16:00，收盘前5分钟：15:55 - 15:59
 * 港股半日交易日收盘时间：中午 12:00，收盘前5分钟：11:55 - 11:59
 * @param date 时间对象（应该是UTC时间）
 * @param isHalfDay 是否是半日交易日
 * @returns true表示在收盘前5分钟，false表示不在
 */
export function isBeforeClose5Minutes(
  date: Date | null | undefined,
  isHalfDay: boolean = false,
): boolean {
  if (!date) return false;
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

  if (isHalfDay) {
    // 半日交易：收盘前5分钟为 11:55 - 11:59:59（12:00收盘）
    return hkHour === 11 && hkMinute >= 55;
  }
  // 正常交易日：收盘前5分钟为 15:55 - 15:59:59（16:00收盘）
  return hkHour === 15 && hkMinute >= 55;
}
