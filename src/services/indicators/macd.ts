/**
 * MACD（指数平滑异同移动平均线）计算模块
 *
 * 指标参数：DIF=EMA12-EMA26，DEA=EMA9(DIF)，MACD柱=2*(DIF-DEA)
 */
import { macdObjectPool } from '../../utils/objectPool/index.js';
import { logDebug, isValidMACD } from './utils.js';
import type { MACDIndicator } from '../../types/quote.js';
import type { MacdPoint } from './types.js';

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

function buildMacdSeries(
  values: ReadonlyArray<number>,
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): ReadonlyArray<MacdPoint> {
  if (values.length < slowPeriod) {
    return [];
  }

  const fastEma = calculateEmaSeriesWithSmaSeed(values, fastPeriod);
  const slowEma = calculateEmaSeriesWithSmaSeed(values, slowPeriod);
  if (fastEma.length === 0 || slowEma.length === 0) {
    return [];
  }

  const difSeries: number[] = [];
  for (let index = slowPeriod - 1; index < values.length; index += 1) {
    const fastIndex = index - (fastPeriod - 1);
    const slowIndex = index - (slowPeriod - 1);
    const fastValue = fastEma[fastIndex];
    const slowValue = slowEma[slowIndex];
    if (fastValue === undefined || slowValue === undefined) {
      continue;
    }
    difSeries.push(fastValue - slowValue);
  }

  const signalSeries = calculateEmaSeriesWithSmaSeed(difSeries, signalPeriod);
  const output: MacdPoint[] = [];

  for (let i = 0; i < difSeries.length; i += 1) {
    const dif = difSeries[i];
    if (dif === undefined) {
      continue;
    }
    if (i < signalPeriod - 1) {
      output.push({
        MACD: dif,
        signal: undefined,
        histogram: undefined,
      });
      continue;
    }
    const signalValue = signalSeries[i - (signalPeriod - 1)];
    if (signalValue === undefined) {
      output.push({
        MACD: dif,
        signal: undefined,
        histogram: undefined,
      });
      continue;
    }
    output.push({
      MACD: dif,
      signal: signalValue,
      histogram: dif - signalValue,
    });
  }

  return output;
}

/**
 * 计算 MACD（移动平均收敛散度指标）
 * @param validCloses 已过滤的收盘价数组（由 buildIndicatorSnapshot 预处理）
 * @param fastPeriod 快线周期，默认12
 * @param slowPeriod 慢线周期，默认26
 * @param signalPeriod 信号线周期，默认9
 * @returns MACD对象 {dif, dea, macd}，如果无法计算则返回null
 */
export function calculateMACD(
  validCloses: ReadonlyArray<number>,
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): MACDIndicator | null {
  if (!validCloses || validCloses.length < slowPeriod + signalPeriod) {
    return null;
  }

  try {
    // validCloses 已由 buildIndicatorSnapshot 预处理，无需再次过滤
    const macdResult = buildMacdSeries(
      validCloses,
      fastPeriod,
      slowPeriod,
      signalPeriod,
    );

    if (!macdResult || macdResult.length === 0) {
      return null;
    }

    const lastMacd = macdResult.at(-1);

    if (
      lastMacd?.MACD === undefined ||
      lastMacd.signal === undefined ||
      lastMacd.histogram === undefined
    ) {
      return null;
    }

    const dif = lastMacd.MACD;
    const dea = lastMacd.signal;
    const macdValue = lastMacd.histogram * 2;

    if (
      !Number.isFinite(dif) ||
      !Number.isFinite(dea) ||
      !Number.isFinite(macdValue)
    ) {
      return null;
    }

    const macdObj = macdObjectPool.acquire();
    macdObj.dif = dif;
    macdObj.dea = dea;
    macdObj.macd = macdValue;

    if (isValidMACD(macdObj)) {
      return macdObj;
    }

    macdObjectPool.release(macdObj);
    return null;
  } catch (err) {
    logDebug('MACD计算失败', err);
    return null;
  }
}
