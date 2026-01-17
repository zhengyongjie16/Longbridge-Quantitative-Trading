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
    // 优化：一次遍历完成数据提取、验证和构建（原来需要9次遍历）
    const validHighs: number[] = [];
    const validLows: number[] = [];
    const mfiCloses: number[] = [];
    const validVolumes: number[] = [];

    for (const candle of candles) {
      const high = toNumber(candle.high);
      const low = toNumber(candle.low);
      const close = toNumber(candle.close);
      const volume = toNumber(candle.volume || 0);

      // 边提取边验证
      if (
        Number.isFinite(high) && high > 0 &&
        Number.isFinite(low) && low > 0 &&
        Number.isFinite(close) && close > 0 &&
        Number.isFinite(volume) && volume >= 0
      ) {
        validHighs.push(high);
        validLows.push(low);
        mfiCloses.push(close);
        validVolumes.push(volume);
      }
    }

    const minRequired = period + 1;
    if (validHighs.length < minRequired) {
      return null;
    }

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
