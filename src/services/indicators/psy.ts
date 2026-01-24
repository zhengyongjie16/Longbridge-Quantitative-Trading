/**
 * PSY（心理线指标）计算模块
 */

import { logDebug } from './utils.js';

/**
 * 计算 PSY（心理线指标）
 * @param validCloses 已过滤的收盘价数组（由 buildIndicatorSnapshot 预处理）
 * @param period PSY 周期
 * @returns PSY 值（0-100），如果无法计算则返回 null
 */
export function calculatePSY(validCloses: ReadonlyArray<number>, period: number): number | null {
  if (
    !Number.isInteger(period) ||
    period <= 0 ||
    !validCloses ||
    validCloses.length <= period
  ) {
    return null;
  }

  try {
    const startIndex = validCloses.length - period;
    let upCount = 0;

    for (let i = startIndex; i < validCloses.length; i += 1) {
      const current = validCloses[i];
      const previous = validCloses[i - 1];

      if (current !== undefined && previous !== undefined && current > previous) {
        upCount += 1;
      }
    }

    const psy = (upCount / period) * 100;
    return Number.isFinite(psy) ? psy : null;
  } catch (err) {
    logDebug(`PSY计算失败 (period=${period})`, err);
    return null;
  }
}
