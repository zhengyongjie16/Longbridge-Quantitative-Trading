/**
 * MACD（指数平滑异同移动平均线）计算模块
 *
 * 指标参数：DIF=EMA12-EMA26，DEA=EMA9(DIF)，MACD柱=2*(DIF-DEA)
 */
import { MACD } from 'technicalindicators';
import { macdObjectPool } from '../../utils/objectPool/index.js';
import { logDebug, isValidMACD } from './utils.js';
import type { MACDIndicator } from '../../types/index.js';

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
    const macdResult = MACD.calculate({
      values: Array.from(validCloses),
      fastPeriod,
      slowPeriod,
      signalPeriod,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });

    if (!macdResult || macdResult.length === 0) {
      return null;
    }

    const lastMacd = macdResult.at(-1);

    if (!lastMacd?.MACD || lastMacd.signal === undefined || lastMacd.histogram === undefined) {
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
