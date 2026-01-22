/**
 * 行情监控模块独享的工具函数
 */

import { isValidNumber } from '../../utils/helpers/indicatorHelpers.js';

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
