import { TIME } from '../../constants/index.js';

/**
 * 类型保护：判断 unknown 是否为可索引对象。
 * 默认行为：仅当 typeof value === 'object' 且 value !== null 时返回 true，否则返回 false。
 *
 * @param value 待判断值
 * @returns true 表示可按键读取字段，否则返回 false
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 将时间转换为香港时区（UTC+8）日志格式（内部使用）。
 *
 * @param date 时间对象，默认当前时间
 * @returns 香港时间字符串 YYYY-MM-DD HH:mm:ss.sss
 */
function toHongKongTime(date: Date | null = null): string {
  const targetDate = date ?? new Date();
  const hkTime = new Date(targetDate.getTime() + TIME.HONG_KONG_TIMEZONE_OFFSET_MS);

  const year = hkTime.getUTCFullYear();
  const month = String(hkTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(hkTime.getUTCDate()).padStart(2, '0');
  const hours = String(hkTime.getUTCHours()).padStart(2, '0');
  const minutes = String(hkTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(hkTime.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(hkTime.getUTCMilliseconds()).padStart(3, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

/**
 * 将时间转换为香港时间（UTC+8）的日志格式字符串。
 * 默认行为：date 为 null 时使用当前时间。
 *
 * @param date 时间对象，默认 null（当前时间）
 * @returns 香港时间字符串 YYYY-MM-DD HH:mm:ss.sss
 */
export function toHongKongTimeLog(date: Date | null = null): string {
  return toHongKongTime(date);
}
