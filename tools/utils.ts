/**
 * 格式化有限数值。默认行为：无效值（null/undefined/NaN/Infinity）返回 `-`。
 *
 * @param value 待格式化值
 * @param decimals 保留小数位数
 * @returns 格式化文本
 */
export function formatFiniteNumber(
  value: number | null | undefined,
  decimals: number,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  return value.toFixed(decimals);
}
