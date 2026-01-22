/**
 * 行情监控模块独享的工具函数
 */

/**
 * 类型守卫：检查值是否为有效的有限数字
 * @param value 待检查的值
 * @returns 如果值是有限数字则返回 true
 */
const isFiniteNumber = (value: number | null | undefined): value is number => {
  return typeof value === 'number' && Number.isFinite(value);
};

/**
 * 检查数值是否发生变化（超过阈值）
 * @param current 当前值
 * @param last 上次值
 * @param threshold 变化阈值
 * @returns true表示值发生变化，false表示未变化
 */
export function hasChanged(current: number | null | undefined, last: number | null | undefined, threshold: number): boolean {
  if (!isFiniteNumber(current) || !isFiniteNumber(last)) {
    return false;
  }
  return Math.abs(current - last) > threshold;
}
