/**
 * EMA（指数移动平均线）计算模块
 *
 * 指标特点：
 * - 赋予近期数据更高权重，对价格变化更敏感
 * - 周期范围：1-250
 */

import { EMA } from 'technicalindicators';
import { logDebug } from './utils.js';

/**
 * 计算 EMA（指数移动平均线）
 * @param validCloses 已过滤的收盘价数组（由 buildIndicatorSnapshot 预处理）
 * @param period EMA周期，范围 1-250
 * @returns EMA值，如果无法计算则返回null
 */
export function calculateEMA(validCloses: ReadonlyArray<number>, period: number): number | null {
  if (
    !validCloses ||
    validCloses.length < period ||
    !Number.isFinite(period) ||
    period <= 0 ||
    period > 250
  ) {
    return null;
  }

  try {
    // validCloses 已由 buildIndicatorSnapshot 预处理，无需再次过滤
    const emaResult = EMA.calculate({ values: Array.from(validCloses), period });

    if (!emaResult || emaResult.length === 0) {
      return null;
    }

    const ema = emaResult.at(-1);

    if (ema === undefined || !Number.isFinite(ema) || ema <= 0) {
      return null;
    }

    return ema;
  } catch (err) {
    logDebug(`EMA计算失败 (period=${period})`, err);
    return null;
  }
}
