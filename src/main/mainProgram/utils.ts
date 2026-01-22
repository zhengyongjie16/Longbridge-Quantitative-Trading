/**
 * 主程序模块独享的工具函数
 */

import type { HKTime } from '../../utils/helpers/types.js';

/**
 * 将UTC时间转换为香港时区（UTC+8）
 * @param date 时间对象（UTC时间）
 * @returns 香港时区的小时和分钟，如果date无效则返回null
 */
function getHKTime(date: Date | null | undefined): HKTime | null {
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
export function isInContinuousHKSession(date: Date | null | undefined, isHalfDay: boolean = false): boolean {
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
