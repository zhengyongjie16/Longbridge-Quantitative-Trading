/**
 * 行情监控模块独享的工具函数
 */

import { isValidNumber } from '../../utils/helpers/indicatorHelpers.js';
import { DEFAULT_PERCENT_DECIMALS } from '../../constants/index.js';
import type { WarrantDistanceInfo } from '../../types/index.js';

/**
 * 检查数值是否发生变化（超过阈值）
 * @param current 当前值
 * @param last 上次值
 * @param threshold 变化阈值
 * @returns true表示值发生变化，false表示未变化
 */
export function hasChanged(current: number | null | undefined, last: number | null | undefined, threshold: number): boolean {
  if (!isValidNumber(current) || !isValidNumber(last)) {
    return false;
  }
  return Math.abs(current - last) > threshold;
}

/**
 * 格式化牛熊证距离回收价的显示文本
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
