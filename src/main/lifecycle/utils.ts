import { TIME } from '../../constants/index.js';
import { getHKDateKey, resolveHKDayStartUtcMs } from '../../utils/tradingTime/index.js';

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
