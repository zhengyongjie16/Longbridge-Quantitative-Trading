import { isValidNumber } from '../../utils/helpers/indicatorHelpers.js';
import { DEFAULT_PERCENT_DECIMALS } from '../../constants/index.js';
import type { ObjectPool } from '../../utils/objectPool/types.js';
import type { WarrantDistanceInfo } from '../../types/services.js';

/**
 * 检查数值是否发生变化（超过阈值）
 * @param current 当前值
 * @param last 上次值
 * @param threshold 变化阈值
 * @returns true表示值发生变化，false表示未变化
 */
export function hasChanged(
  current: number | null | undefined,
  last: number | null | undefined,
  threshold: number,
): boolean {
  if (!isValidNumber(current) || !isValidNumber(last)) {
    return false;
  }
  return Math.abs(current - last) > threshold;
}

/**
 * 检查单个指标值是否变化（当前有效且上次为空或超过阈值）
 * @param current 当前指标值
 * @param last 上次指标值，为 null/undefined 时视为首次出现
 * @param threshold 变化阈值
 * @returns 当前值有效且与上次相比超过阈值时返回 true
 */
export function indicatorChanged(
  current: number | null | undefined,
  last: number | null | undefined,
  threshold: number,
): boolean {
  return Number.isFinite(current) && (last == null || hasChanged(current, last, threshold));
}

/**
 * 格式化牛熊证距离回收价的显示文本
 * @param warrantDistanceInfo 牛熊证距离信息，为 null 时返回 null
 * @param decimals 小数位数，默认使用 DEFAULT_PERCENT_DECIMALS
 * @returns 格式化后的距离文本，距离无效时返回"未知"文本，warrantDistanceInfo 为 null 时返回 null
 */
export function formatWarrantDistanceDisplay(
  warrantDistanceInfo: WarrantDistanceInfo | null,
  decimals: number = DEFAULT_PERCENT_DECIMALS,
): string | null {
  if (!warrantDistanceInfo) {
    return null;
  }

  const warrantLabel = warrantDistanceInfo.warrantType === 'BULL' ? '牛证' : '熊证';
  const distance = warrantDistanceInfo.distanceToStrikePercent;
  if (distance === null || !Number.isFinite(distance)) {
    return `${warrantLabel}距离回收价=未知`;
  }

  const sign = distance >= 0 ? '+' : '';
  return `${warrantLabel}距离回收价=${sign}${distance.toFixed(decimals)}%`;
}

/**
 * 从指标快照拷贝周期值到对象池记录
 * @param pool 对象池，用于复用 Record 对象避免频繁分配
 * @param snapshot 指标快照，为 null 时返回 null
 * @returns 从对象池获取并填充的周期值记录，snapshot 为 null 时返回 null
 */
export function copyPeriodRecord(
  pool: ObjectPool<Record<number, number>>,
  snapshot: Readonly<Record<number, number>> | null,
): Record<number, number> | null {
  if (!snapshot) {
    return null;
  }

  const record = pool.acquire();
  for (const key in snapshot) {
    const numKey = Number(key);
    const value = snapshot[numKey];
    if (value !== undefined) {
      record[numKey] = value;
    }
  }
  return record;
}
