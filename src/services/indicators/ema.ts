/**
 * EMA（指数移动平均线）计算模块
 *
 * 指标特点：
 * - 赋予近期数据更高权重，对价格变化更敏感
 * - 周期范围：1-250
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { logDebug, toNumber, initEmaStreamState, feedEmaStreamState } from './utils.js';
import type { CandleData } from '../../types/data.js';

/**
 * 计算 EMA（指数移动平均线）
 * @param candles K线数据数组
 * @param period EMA周期，范围 1-250
 * @returns EMA值，如果无法计算则返回null
 */
export function calculateEMA(candles: ReadonlyArray<CandleData>, period: number): number | null {
  if (
    candles.length < period ||
    !Number.isFinite(period) ||
    period <= 0 ||
    period > 250
  ) {
    return null;
  }

  try {
    const state = initEmaStreamState(period);
    for (const candle of candles) {
      const close = toNumber(candle.close);
      if (!isValidPositiveNumber(close)) {
        continue;
      }
      feedEmaStreamState(state, close);
    }

    const ema = state.emaValue;

    if (ema === null || !Number.isFinite(ema) || ema <= 0) {
      return null;
    }

    return ema;
  } catch (err) {
    logDebug(`EMA计算失败 (period=${period})`, err);
    return null;
  }
}
