/**
 * RSI（相对强弱指标）计算模块
 *
 * 指标参数：
 * - RSI：周期 6，Wilder's Smoothing 平滑
 */

import { RSI } from 'technicalindicators';
import { logDebug, validatePercentage } from './utils.js';

/**
 * 计算 RSI（相对强弱指标）
 * @param validCloses 已过滤的收盘价数组（由 buildIndicatorSnapshot 预处理）
 * @param period RSI周期，例如：6（RSI6）
 * @returns RSI值（0-100），如果无法计算则返回null
 */
export function calculateRSI(validCloses: ReadonlyArray<number>, period: number): number | null {
  if (
    !validCloses ||
    validCloses.length <= period ||
    !Number.isFinite(period) ||
    period <= 0
  ) {
    return null;
  }

  try {
    // validCloses 已由 buildIndicatorSnapshot 预处理，无需再次过滤
    const rsiResult = RSI.calculate({ values: validCloses as number[], period });

    if (!rsiResult || rsiResult.length === 0) {
      return null;
    }

    const rsi = rsiResult.at(-1);

    if (rsi === undefined || !validatePercentage(rsi)) {
      return null;
    }

    return rsi;
  } catch (err) {
    logDebug(`RSI计算失败 (period=${period})`, err);
    return null;
  }
}
