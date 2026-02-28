/**
 * 指标快照构建模块
 *
 * 职责：
 * - 根据 K 线数据生成指纹用于快照复用判断
 * - 统一构建 RSI/MFI/PSY/KDJ/MACD/EMA 指标快照
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { periodRecordPool } from '../../utils/objectPool/index.js';
import type { CandleData } from '../../types/data.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
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
 * 构建指标快照（统一计算 RSI/MFI/PSY/KDJ/MACD/EMA）。
 *
 * 由 pipeline 负责「K 线未变则复用上一拍快照」的短路，本函数仅做纯计算。
 *
 * @param symbol 标的代码
 * @param candles K线数据数组
 * @param rsiPeriods RSI周期数组
 * @param emaPeriods EMA周期数组
 * @param psyPeriods PSY周期数组
 * @returns 指标快照对象，无有效价格时返回 null
 */
export function buildIndicatorSnapshot(
  symbol: string,
  candles: ReadonlyArray<CandleData>,
  rsiPeriods: ReadonlyArray<number> = [],
  emaPeriods: ReadonlyArray<number> = [],
  psyPeriods: ReadonlyArray<number> = [],
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

  const rsi = periodRecordPool.acquire();
  for (const period of rsiPeriods) {
    if (validateRsiPeriod(period) && Number.isInteger(period)) {
      const rsiValue = calculateRSI(candles, period);
      if (rsiValue !== null) {
        rsi[period] = rsiValue;
      }
    }
  }

  const ema = periodRecordPool.acquire();
  for (const period of emaPeriods) {
    if (validateEmaPeriod(period) && Number.isInteger(period)) {
      const emaValue = calculateEMA(candles, period);
      if (emaValue !== null) {
        ema[period] = emaValue;
      }
    }
  }

  let psy: Record<number, number> | null = null;
  if (psyPeriods.length > 0) {
    const psyRecord = periodRecordPool.acquire();
    let hasPsyValue = false;
    for (const period of psyPeriods) {
      if (validatePsyPeriod(period) && Number.isInteger(period)) {
        const psyValue = calculatePSY(candles, period);
        if (psyValue !== null) {
          psyRecord[period] = psyValue;
          hasPsyValue = true;
        }
      }
    }
    if (hasPsyValue) {
      psy = psyRecord;
    } else {
      periodRecordPool.release(psyRecord);
    }
  }

  return {
    symbol,
    price: lastPrice,
    changePercent,
    rsi,
    psy,
    kdj: calculateKDJ(candles, 9),
    macd: calculateMACD(candles),
    mfi: calculateMFI(candles, 14),
    ema,
  };
}
