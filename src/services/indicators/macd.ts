/**
 * MACD（指数平滑异同移动平均线）计算模块
 *
 * 指标参数：DIF=EMA12-EMA26，DEA=EMA9(DIF)，MACD柱=2*(DIF-DEA)
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { macdObjectPool } from '../../utils/objectPool/index.js';
import {
  logDebug,
  isValidMACD,
  toNumber,
  initEmaStreamState,
  feedEmaStreamState,
} from './utils.js';
import type { MACDIndicator } from '../../types/quote.js';
import type { CandleData } from '../../types/data.js';

/**
 * 计算 MACD（移动平均收敛散度指标）
 * @param candles K线数据数组
 * @param fastPeriod 快线周期，默认12
 * @param slowPeriod 慢线周期，默认26
 * @param signalPeriod 信号线周期，默认9
 * @returns MACD对象 {dif, dea, macd}，如果无法计算则返回null
 */
export function calculateMACD(
  candles: ReadonlyArray<CandleData>,
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): MACDIndicator | null {
  if (!candles || candles.length < slowPeriod + signalPeriod) {
    return null;
  }

  try {
    const fastState = initEmaStreamState(fastPeriod);
    const slowState = initEmaStreamState(slowPeriod);
    const signalState = initEmaStreamState(signalPeriod);
    let validCloseCount = 0;
    let lastDif: number | null = null;
    let lastSignal: number | null = null;
    let lastHistogram: number | null = null;

    for (const candle of candles) {
      const close = toNumber(candle.close);
      if (!isValidPositiveNumber(close)) {
        continue;
      }

      validCloseCount += 1;

      const fastEmaValue = feedEmaStreamState(fastState, close);
      const slowEmaValue = feedEmaStreamState(slowState, close);
      if (fastEmaValue === null || slowEmaValue === null) {
        continue;
      }

      const dif = fastEmaValue - slowEmaValue;
      const signalValue = feedEmaStreamState(signalState, dif);
      if (signalValue === null) {
        continue;
      }

      lastDif = dif;
      lastSignal = signalValue;
      lastHistogram = dif - signalValue;
    }

    // 保持既有门槛：至少 slowPeriod + signalPeriod 个有效收盘价
    if (validCloseCount < slowPeriod + signalPeriod) {
      return null;
    }

    if (lastDif === null || lastSignal === null || lastHistogram === null) {
      return null;
    }

    const macdValue = lastHistogram * 2;

    if (!Number.isFinite(lastDif) || !Number.isFinite(lastSignal) || !Number.isFinite(macdValue)) {
      return null;
    }

    const macdObj = macdObjectPool.acquire();
    macdObj.dif = lastDif;
    macdObj.dea = lastSignal;
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
