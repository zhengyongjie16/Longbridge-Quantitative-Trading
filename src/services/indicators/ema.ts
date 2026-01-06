/**
 * EMA（指数移动平均线）计算模块
 */

import { EMA } from 'technicalindicators';
import { toNumber, logDebug } from './utils.js';

/**
 * 计算 EMA（指数移动平均线）
 * @param validCloses 收盘价数组
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
    const filteredCloses = validCloses
      .map((c) => toNumber(c))
      .filter((v) => Number.isFinite(v) && v > 0);

    if (filteredCloses.length < period) {
      return null;
    }

    const emaResult = EMA.calculate({ values: filteredCloses, period });

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
