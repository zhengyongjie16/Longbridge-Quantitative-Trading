/**
 * dailyIndicatorAnalysis 工具指标全量计算模块。
 * 职责：为分钟指标分析工具提供生产链路不再直接导出的全量指标包装计算。
 */
import { isValidPositiveNumber } from '../../src/utils/helpers/index.js';
import {
  createEmaState,
  commitEmaClose,
  readEmaValue,
} from '../../src/services/indicators/runtime/ema.js';
import {
  createKdjState,
  commitKdjCandle,
  readKdjValue,
} from '../../src/services/indicators/runtime/kdj.js';
import {
  createMfiState,
  commitMfiCandle,
  readMfiValue,
} from '../../src/services/indicators/runtime/mfi.js';
import {
  createRsiState,
  commitRsiClose,
  readRsiValue,
} from '../../src/services/indicators/runtime/rsi.js';
import {
  logDebug,
  toNumber,
  validatePercentage,
} from '../../src/services/indicators/runtime/utils.js';
import type { CandleData } from '../../src/types/data.js';
import type { KDJIndicator } from '../../src/types/quote.js';

/**
 * 计算 EMA（指数移动平均线）。默认行为：样本不足或周期无效时返回 null。
 *
 * @param candles K 线数据数组
 * @param period EMA 周期，范围 1-250
 * @returns EMA 值，无法计算时返回 null
 */
export function calculateEMA(candles: ReadonlyArray<CandleData>, period: number): number | null {
  if (candles.length < period || !Number.isFinite(period) || period <= 0 || period > 250) {
    return null;
  }

  try {
    const state = createEmaState(period);
    for (const candle of candles) {
      const close = toNumber(candle.close);
      if (!isValidPositiveNumber(close)) {
        continue;
      }

      commitEmaClose(state, close);
    }

    return readEmaValue(state);
  } catch (err) {
    logDebug(`EMA计算失败 (period=${period})`, err);
    return null;
  }
}

/**
 * 计算 KDJ（随机指标）。默认行为：样本不足或计算失败时返回 null。
 *
 * @param candles K 线数据数组
 * @param period KDJ 周期，默认 9
 * @returns KDJ 对象，无法计算时返回 null
 */
export function calculateKDJ(
  candles: ReadonlyArray<CandleData>,
  period: number = 9,
): KDJIndicator | null {
  if (candles.length < period) {
    return null;
  }

  try {
    const state = createKdjState(period);
    for (const candle of candles) {
      commitKdjCandle(state, candle);
    }

    return readKdjValue(state);
  } catch (err) {
    logDebug('KDJ计算失败', err);
    return null;
  }
}

/**
 * 计算 MFI（资金流量指标）。默认行为：样本不足或计算失败时返回 null。
 *
 * @param candles K 线数据数组
 * @param period MFI 周期，默认 14
 * @returns MFI 值，无法计算时返回 null
 */
export function calculateMFI(
  candles: ReadonlyArray<CandleData>,
  period: number = 14,
): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  try {
    const state = createMfiState(period);
    for (const candle of candles) {
      commitMfiCandle(state, candle);
    }

    return readMfiValue(state);
  } catch (err) {
    logDebug(`MFI计算失败 (period=${period})`, err);
    return null;
  }
}

/**
 * 计算 RSI（相对强弱指标）。默认行为：样本不足、周期无效或结果越界时返回 null。
 *
 * @param candles K 线数据数组
 * @param period RSI 周期
 * @returns RSI 值，无法计算时返回 null
 */
export function calculateRSI(candles: ReadonlyArray<CandleData>, period: number): number | null {
  if (candles.length <= period || !Number.isFinite(period) || period <= 0) {
    return null;
  }

  try {
    const state = createRsiState(period);
    for (const candle of candles) {
      const close = toNumber(candle.close);
      if (!isValidPositiveNumber(close)) {
        continue;
      }

      commitRsiClose(state, close);
    }

    const rsi = readRsiValue(state);
    if (rsi === null || !validatePercentage(rsi)) {
      return null;
    }

    return rsi;
  } catch (err) {
    logDebug(`RSI计算失败 (period=${period})`, err);
    return null;
  }
}
