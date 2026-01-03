/**
 * 交易时段和时区模块
 *
 * 功能：
 * - UTC 时间转换为香港时区（UTC+8）
 * - 判断是否在港股连续交易时段
 * - 判断是否在收盘前特定时间段
 * - 检查数值是否变化超过阈值
 *
 * 港股交易时段：
 * - 正常交易日：09:30-12:00 和 13:00-16:00
 * - 半日交易日：仅 09:30-12:00
 *
 * 关键时间段：
 * - 收盘前 15 分钟：15:45-16:00（正常日）/ 11:45-12:00（半日）
 * - 收盘前 5 分钟：15:55-15:59（正常日）/ 11:55-11:59（半日）
 */

/**
 * 香港时间结构
 */
interface HKTime {
  hkHour: number;
  hkMinute: number;
}

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

/**
 * 判断是否在当日收盘前15分钟内（末日保护程序：拒绝买入）
 * 港股正常交易日收盘时间：下午 16:00，收盘前15分钟：15:45 - 15:59
 * 港股半日交易日收盘时间：中午 12:00，收盘前15分钟：11:45 - 11:59
 * @param date 时间对象（应该是UTC时间）
 * @param isHalfDay 是否是半日交易日
 * @returns true表示在收盘前15分钟，false表示不在
 */
export function isBeforeClose15Minutes(date: Date | null | undefined, isHalfDay: boolean = false): boolean {
  if (!date) return false;
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

  if (isHalfDay) {
    // 半日交易：收盘前15分钟为 11:45 - 11:59:59（12:00收盘）
    return hkHour === 11 && hkMinute >= 45;
  } else {
    // 正常交易日：收盘前15分钟为 15:45 - 15:59:59（16:00收盘）
    return hkHour === 15 && hkMinute >= 45;
  }
}

/**
 * 判断是否在当日收盘前5分钟内（末日保护程序：自动清仓）
 * 港股正常交易日收盘时间：下午 16:00，收盘前5分钟：15:55 - 15:59
 * 港股半日交易日收盘时间：中午 12:00，收盘前5分钟：11:55 - 11:59
 * @param date 时间对象（应该是UTC时间）
 * @param isHalfDay 是否是半日交易日
 * @returns true表示在收盘前5分钟，false表示不在
 */
export function isBeforeClose5Minutes(date: Date | null | undefined, isHalfDay: boolean = false): boolean {
  if (!date) return false;
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

  if (isHalfDay) {
    // 半日交易：收盘前5分钟为 11:55 - 11:59:59（12:00收盘）
    return hkHour === 11 && hkMinute >= 55;
  } else {
    // 正常交易日：收盘前5分钟为 15:55 - 15:59:59（16:00收盘）
    return hkHour === 15 && hkMinute >= 55;
  }
}

/**
 * 检查数值是否发生变化（超过阈值）
 * @param current 当前值
 * @param last 上次值
 * @param threshold 变化阈值
 * @returns true表示值发生变化，false表示未变化
 */
export function hasChanged(current: number | null | undefined, last: number | null | undefined, threshold: number): boolean {
  return (
    Number.isFinite(current) &&
    Number.isFinite(last) &&
    Math.abs(current! - last!) > threshold
  );
}
