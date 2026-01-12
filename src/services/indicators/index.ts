/**
 * 技术指标计算模块
 *
 * 功能：
 * - 计算 RSI（相对强弱指标）
 * - 计算 MFI（资金流量指标）
 * - 计算 KDJ（随机指标）
 * - 计算 MACD（指数平滑异同移动平均线）
 * - 计算 EMA（指数移动平均线）
 * - 构建包含所有指标的统一快照
 *
 * 实现方式：
 * - 使用 technicalindicators 库优化指标计算
 * - 性能提升约 2.9 倍
 *
 * 指标参数：
 * - RSI：周期 6，Wilder's Smoothing 平滑
 * - MFI：周期 14，结合价格和成交量
 * - KDJ：EMA 周期 5，K、D、J 三值
 * - MACD：EMA12-EMA26-DIF 的 EMA9
 */

import { validateRsiPeriod, validateEmaPeriod } from '../../utils/helpers/indicatorHelpers.js';
import { toNumber } from './utils.js';
import { calculateRSI } from './rsi.js';
import { calculateMFI } from './mfi.js';
import { calculateKDJ } from './kdj.js';
import { calculateMACD } from './macd.js';
import { calculateEMA } from './ema.js';
import type { CandleData, IndicatorSnapshot } from '../../types/index.js';

/**
 * 构建指标快照（统一计算所有技术指标）
 * @param symbol 标的代码
 * @param candles K线数据数组
 * @param rsiPeriods RSI周期数组
 * @param emaPeriods EMA周期数组
 * @returns 指标快照对象
 */
export function buildIndicatorSnapshot(
  symbol: string,
  candles: ReadonlyArray<CandleData>,
  rsiPeriods: ReadonlyArray<number> = [],
  emaPeriods: ReadonlyArray<number> = [],
): IndicatorSnapshot | null {
  if (!candles || candles.length === 0) {
    return null;
  }

  // 提取收盘价数组
  const validCloses: number[] = [];
  for (const element of candles) {
    const close = toNumber(element.close);
    if (Number.isFinite(close) && close > 0) {
      validCloses.push(close);
    }
  }

  if (validCloses.length === 0) {
    return null;
  }

  const lastPrice = validCloses.at(-1)!;

  // 计算涨跌幅（如果有前一根K线的收盘价）
  let changePercent: number | null = null;
  if (validCloses.length >= 2) {
    const prevClose = validCloses.at(-2)!;
    if (Number.isFinite(prevClose) && prevClose > 0) {
      changePercent = ((lastPrice - prevClose) / prevClose) * 100;
    }
  }

  // 计算所有需要的 RSI 周期
  const rsi: Record<number, number> = {};
  if (Array.isArray(rsiPeriods) && rsiPeriods.length > 0) {
    for (const period of rsiPeriods) {
      if (validateRsiPeriod(period) && Number.isInteger(period)) {
        const rsiValue = calculateRSI(validCloses, period);
        if (rsiValue !== null) {
          rsi[period] = rsiValue;
        }
      }
    }
  }

  // 计算所有需要的 EMA 周期
  const ema: Record<number, number> = {};
  if (Array.isArray(emaPeriods) && emaPeriods.length > 0) {
    for (const period of emaPeriods) {
      if (validateEmaPeriod(period) && Number.isInteger(period)) {
        const emaValue = calculateEMA(validCloses, period);
        if (emaValue !== null) {
          ema[period] = emaValue;
        }
      }
    }
  }

  return {
    symbol,
    price: lastPrice,
    changePercent,
    rsi,
    kdj: calculateKDJ(candles, 9),
    macd: calculateMACD(validCloses),
    mfi: calculateMFI(candles, 14),
    ema,
  };
}
