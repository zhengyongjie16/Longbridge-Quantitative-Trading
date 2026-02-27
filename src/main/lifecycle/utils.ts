import { HK_DATE_KEY_PATTERN, TIME } from '../../constants/index.js';
import { getHKDateKey } from '../../utils/helpers/tradingTime.js';

/**
 * 枚举起止时间区间覆盖的港股日期键列表（含首尾日期）。
 *
 * @param startMs 区间起点毫秒时间戳
 * @param endMs 区间终点毫秒时间戳
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
    cursorDayStartUtcMs += TIME.MILLISECONDS_PER_DAY
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
 *
 * @param dayKey 港股日期键（YYYY-MM-DD）
 * @returns UTC 毫秒时间戳，解析失败时返回 null
 */
export function resolveHKDayStartUtcMs(dayKey: string): number | null {
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
  return Number.isFinite(utcMs) ? utcMs : null;
}
