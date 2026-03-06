/**
 * 指标快照构建模块
 *
 * 职责：
 * - 根据 K 线数据生成指纹用于快照复用判断
 * - 统一构建 RSI/MFI/PSY/KDJ/MACD/EMA/ADX 指标快照
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { periodRecordPool } from '../../utils/objectPool/index.js';
import type { CandleData } from '../../types/data.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { IndicatorUsageProfile } from '../../types/state.js';
import {
  validateRsiPeriod,
  validateEmaPeriod,
  validatePsyPeriod,
} from '../../utils/indicatorHelpers/index.js';
import { calculateEMA } from './ema.js';
import { calculateKDJ } from './kdj.js';
import { calculateMACD } from './macd.js';
import { calculateMFI } from './mfi.js';
import { calculatePSY } from './psy.js';
import { calculateADX } from './adx.js';
import { calculateRSI } from './rsi.js';
import { toNumber } from './utils.js';

/**
 * 从 K 线长度与最后一根收盘价构造指纹字符串（格式 length_lastClose），供 getCandleFingerprint 复用，用于检测数据是否变化。
 *
 * @param candles K 线数据数组（仅用 length）
 * @param lastClose 最后一根 K 线收盘价
 * @returns 指纹字符串
 */
function buildDataFingerprint(candles: ReadonlyArray<CandleData>, lastClose: number): string {
  return `${candles.length}_${lastClose}`;
}

/**
 * 从 K 线计算指纹，供 pipeline 判断是否可复用上一拍快照。
 * 仅当最后一根收盘价有效时返回非 null。
 *
 * @param candles K 线数据数组
 * @returns 指纹字符串（格式：length_lastClose），无效时返回 null
 */
export function getCandleFingerprint(candles: ReadonlyArray<CandleData>): string | null {
  if (candles.length === 0) {
    return null;
  }

  const lastCandle = candles.at(-1);
  const lastClose = lastCandle ? toNumber(lastCandle.close) : 0;
  if (!isValidPositiveNumber(lastClose)) {
    return null;
  }

  return buildDataFingerprint(candles, lastClose);
}

/**
 * 构建指标快照（统一计算 RSI/MFI/PSY/KDJ/MACD/EMA/ADX）。
 *
 * 由 pipeline 负责「K 线未变则复用上一拍快照」的短路，本函数仅做纯计算。
 *
 * @param symbol 标的代码
 * @param candles K线数据数组
 * @param indicatorProfile 指标画像（定义本次需要计算的指标范围）
 * @returns 指标快照对象，无有效价格时返回 null
 */
export function buildIndicatorSnapshot(
  symbol: string,
  candles: ReadonlyArray<CandleData>,
  indicatorProfile: IndicatorUsageProfile,
): IndicatorSnapshot | null {
  if (candles.length === 0) {
    return null;
  }

  let lastPrice: number | null = null;
  let prevClose: number | null = null;
  for (const element of candles) {
    const close = toNumber(element.close);
    if (isValidPositiveNumber(close)) {
      prevClose = lastPrice;
      lastPrice = close;
    }
  }

  if (lastPrice === null) {
    return null;
  }

  let changePercent: number | null = null;
  if (prevClose !== null) {
    changePercent = ((lastPrice - prevClose) / prevClose) * 100;
  }

  const { requiredFamilies, requiredPeriods } = indicatorProfile;
  const rsi = buildPeriodIndicatorRecord({
    periods: requiredPeriods.rsi,
    isValidPeriod: validateRsiPeriod,
    calculate: (period) => calculateRSI(candles, period),
  });
  const ema = buildPeriodIndicatorRecord({
    periods: requiredPeriods.ema,
    isValidPeriod: validateEmaPeriod,
    calculate: (period) => calculateEMA(candles, period),
  });
  const psy = buildPeriodIndicatorRecord({
    periods: requiredPeriods.psy,
    isValidPeriod: validatePsyPeriod,
    calculate: (period) => calculatePSY(candles, period),
  });
  const kdj = requiredFamilies.kdj ? calculateKDJ(candles, 9) : null;
  const macd = requiredFamilies.macd ? calculateMACD(candles) : null;
  const mfi = requiredFamilies.mfi ? calculateMFI(candles, 14) : null;
  const adx = requiredFamilies.adx ? calculateADX(candles, 14) : null;

  return {
    symbol,
    price: lastPrice,
    changePercent,
    rsi,
    psy,
    kdj,
    macd,
    mfi,
    adx,
    ema,
  };
}

/**
 * 构建按周期索引的指标记录。
 * @param params 周期列表、周期校验函数与计算函数
 * @returns 至少包含一个有效值时返回对象池记录，否则返回 null
 */
function buildPeriodIndicatorRecord(params: {
  readonly periods: ReadonlyArray<number>;
  readonly isValidPeriod: (period: unknown) => period is number;
  readonly calculate: (period: number) => number | null;
}): Record<number, number> | null {
  const { periods, isValidPeriod, calculate } = params;
  if (periods.length === 0) {
    return null;
  }

  const periodRecord = periodRecordPool.acquire();
  let hasValue = false;
  for (const period of periods) {
    if (!isValidPeriod(period) || !Number.isInteger(period)) {
      continue;
    }

    const value = calculate(period);
    if (value === null) {
      continue;
    }

    periodRecord[period] = value;
    hasValue = true;
  }

  if (hasValue) {
    return periodRecord;
  }

  periodRecordPool.release(periodRecord);
  return null;
}
