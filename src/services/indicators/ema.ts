/**
 * EMA（指数移动平均线）计算模块
 *
 * 指标特点：
 * - 赋予近期数据更高权重，对价格变化更敏感
 * - 周期范围：1-250
 */
import { logDebug } from './utils.js';

function computeSma(values: ReadonlyArray<number>): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function calculateEmaSeries(
  source: ReadonlyArray<number>,
  period: number,
  size: number = source.length,
): number[] {
  if (size <= 0) {
    return [];
  }

  const first = source[0];
  if (first === undefined || !Number.isFinite(first)) {
    return [];
  }

  const output: number[] = [];
  const per = 2 / (period + 1);
  let value = first;
  output.push(value);

  for (let i = 1; i < size; i += 1) {
    const current = source[i];
    if (current === undefined || !Number.isFinite(current)) {
      break;
    }
    value = (current - value) * per + value;
    output.push(value);
  }

  return output;
}

function calculateEmaSeriesWithSmaSeed(
  values: ReadonlyArray<number>,
  period: number,
): number[] {
  if (values.length < period) {
    return [];
  }

  const seedWindow = values.slice(0, period);
  const seed = computeSma(seedWindow);
  const emaInput = [seed, ...values.slice(period)];
  return calculateEmaSeries(emaInput, period);
}

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
    const emaResult = calculateEmaSeriesWithSmaSeed(validCloses, period);

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
