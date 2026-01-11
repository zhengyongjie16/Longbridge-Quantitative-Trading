/**
 * MFI（资金流量指标）计算模块
 *
 * 指标参数：
 * - MFI：周期 14，结合价格和成交量
 */

import { MFI } from 'technicalindicators';
import { validatePercentage } from '../../utils/helpers/indicatorHelpers.js';
import { toNumber, logDebug } from './utils.js';
import type { CandleData } from '../../types/index.js';

/**
 * 计算 MFI（资金流量指标）
 * @param candles K线数据数组
 * @param period MFI周期，默认14
 * @returns MFI值（0-100），如果无法计算则返回null
 */
export function calculateMFI(candles: ReadonlyArray<CandleData>, period: number = 14): number | null {
  if (!candles || candles.length < period + 1) {
    return null;
  }

  try {
    const highs = candles.map((c) => toNumber(c.high));
    const lows = candles.map((c) => toNumber(c.low));
    const closes = candles.map((c) => toNumber(c.close));
    const volumes = candles.map((c) => toNumber(c.volume || 0));

    const minRequired = period + 1;
    if (
      highs.length < minRequired ||
      lows.length < minRequired ||
      closes.length < minRequired ||
      volumes.length < minRequired
    ) {
      return null;
    }

    interface ValidDataPoint {
      high: number;
      low: number;
      close: number;
      volume: number;
    }

    const validData: ValidDataPoint[] = [];
    for (let i = 0; i < highs.length; i++) {
      const high = highs[i]!;
      const low = lows[i]!;
      const close = closes[i]!;
      const volume = volumes[i]!;

      if (
        Number.isFinite(high) &&
        Number.isFinite(low) &&
        Number.isFinite(close) &&
        Number.isFinite(volume) &&
        high > 0 &&
        low > 0 &&
        close > 0 &&
        volume >= 0
      ) {
        validData.push({ high, low, close, volume });
      }
    }

    if (validData.length < minRequired) {
      return null;
    }

    const validHighs = validData.map((d) => d.high);
    const validLows = validData.map((d) => d.low);
    const mfiCloses = validData.map((d) => d.close);
    const validVolumes = validData.map((d) => d.volume);

    const mfiResult = MFI.calculate({
      high: validHighs,
      low: validLows,
      close: mfiCloses,
      volume: validVolumes,
      period,
    });

    if (!mfiResult || mfiResult.length === 0) {
      return null;
    }

    const mfi = mfiResult.at(-1);

    if (mfi === undefined || !validatePercentage(mfi)) {
      return null;
    }

    return mfi;
  } catch (err) {
    logDebug(`MFI计算失败 (period=${period})`, err);
    return null;
  }
}
