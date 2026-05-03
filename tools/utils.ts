/**
 * 格式化有限数值。默认行为：无效值（null/undefined/NaN/Infinity）返回 `-`。
 *
 * @param value 待格式化值
 * @param decimals 保留小数位数
 * @returns 格式化文本
 */
export function formatFiniteNumber(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '-';
  }

  return value.toFixed(decimals);
}

/**
 * 异步延迟指定毫秒数。
 *
 * @param ms 延迟毫秒数
 * @returns 延迟结束后 resolve 的 Promise
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
