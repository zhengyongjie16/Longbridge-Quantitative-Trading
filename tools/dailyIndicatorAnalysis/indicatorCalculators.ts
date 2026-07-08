/**
 * dailyIndicatorAnalysis 工具指标全量计算模块。
 * 职责：为分钟指标分析工具提供生产链路不再直接导出的全量指标包装计算。
 */
import { IS_DEBUG } from '../../src/constants/index.js';
import { isValidPositiveNumber } from '../../src/utils/helpers/index.js';
import { logger } from '../../src/utils/logger/index.js';
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
import { toNumber, validatePercentage } from '../../src/services/indicators/runtime/utils.js';
import type { CandleData } from '../../src/types/data.js';
import type { KDJIndicator } from '../../src/types/quote.js';

/**
 * 输出工具内部的调试日志。默认行为：非调试模式直接跳过。
 *
 * @param message 日志消息
 * @param error 可选错误对象
 * @returns 无返回值
 */
function logDebug(message: string, error?: unknown): void {
  if (!IS_DEBUG) {
    return;
  }

  logger.debug(message, error);
}

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

/**
 * 计算 Kaufman Efficiency Ratio。默认行为：样本不足、周期无效或窗口内存在无效收盘价时返回 null。
 *
 * @param candles K 线数据数组
 * @param period ER 周期
 * @returns ER 值，无法计算时返回 null
 */
export function calculateEfficiencyRatio(
  candles: ReadonlyArray<CandleData>,
  period: number,
): number | null {
  if (candles.length <= period || !Number.isFinite(period) || period <= 0) {
    return null;
  }

  const windowCandles = candles.slice(-period - 1);
  const closes: number[] = [];
  for (const candle of windowCandles) {
    const close = toNumber(candle.close);
    if (!isValidPositiveNumber(close)) {
      return null;
    }

    closes.push(close);
  }

  const firstClose = closes[0];
  const lastClose = closes.at(-1);
  if (firstClose === undefined || lastClose === undefined) {
    return null;
  }

  let pathMovement = 0;
  for (let index = 1; index < closes.length; index += 1) {
    const close = closes[index];
    const previousClose = closes[index - 1];
    if (close === undefined || previousClose === undefined) {
      return null;
    }

    pathMovement += Math.abs(close - previousClose);
  }

  if (pathMovement === 0) {
    return 0;
  }

  return Math.abs(lastClose - firstClose) / pathMovement;
}
