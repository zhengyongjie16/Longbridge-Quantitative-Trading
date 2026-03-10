/**
 * ADX（平均趋向指数）计算模块
 *
 * 采用标准 Wilder ADX 流程：
 * 1. 计算 +DM/-DM（方向运动）
 * 2. 用 Wilder 平滑计算 ATR、+DI/-DI
 * 3. 计算 DX = |+DI - -DI| / (+DI + -DI) * 100
 * 4. 对 DX 序列再做 Wilder 平滑得到 ADX
 *
 * 默认周期 14，输出 number | null
 */
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { toNumber, logDebug, roundToFixed2 } from './utils.js';
import type { CandleData } from '../../../types/data.js';

/**
 * 计算 ADX（平均趋向指数）。
 *
 * 需要至少 2 * period 根有效 K 线才能产出首个 ADX 值。
 * 样本不足或计算异常时返回 null。
 *
 * @param candles K 线数据数组
 * @param period ADX 周期，默认 14
 * @returns ADX 值（0-100），无法计算时返回 null
 */
export function calculateADX(
  candles: ReadonlyArray<CandleData>,
  period: number = 14,
): number | null {
  // 至少需要 2 * period + 1 根 K 线（period 根用于首次 Wilder 平滑，period 根用于 DX 平滑，+1 用于首根基准）
  if (candles.length < 2 * period + 1) {
    return null;
  }

  try {
    // 提取并验证 OHLC 数据
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];

    for (const candle of candles) {
      const high = toNumber(candle.high);
      const low = toNumber(candle.low);
      const close = toNumber(candle.close);

      if (
        isValidPositiveNumber(high) &&
        isValidPositiveNumber(low) &&
        isValidPositiveNumber(close)
      ) {
        highs.push(high);
        lows.push(low);
        closes.push(close);
      }
    }

    if (highs.length < 2 * period + 1) {
      return null;
    }

    return computeAdx(highs, lows, closes, period);
  } catch (err) {
    logDebug(`ADX计算失败 (period=${period})`, err);
    return null;
  }
}

/**
 * ADX 核心计算逻辑（纯函数，不依赖外部状态）。
 *
 * @param highs 最高价数组
 * @param lows 最低价数组
 * @param closes 收盘价数组
 * @param period ADX 周期
 * @returns ADX 值，数据不足时返回 null
 */
function computeAdx(
  highs: ReadonlyArray<number>,
  lows: ReadonlyArray<number>,
  closes: ReadonlyArray<number>,
  period: number,
): number | null {
  const dmCount = highs.length - 1;
  if (dmCount < 2 * period) {
    return null;
  }

  let smoothTr = 0;
  let smoothPlusDm = 0;
  let smoothMinusDm = 0;
  let trDmCount = 0;

  let initialDxSum = 0;
  let dxCount = 0;
  let adx: number | null = null;

  for (let i = 1; i < highs.length; i += 1) {
    const high = highs[i];
    const low = lows[i];
    const prevHigh = highs[i - 1];
    const prevLow = lows[i - 1];
    const prevClose = closes[i - 1];
    if (
      high === undefined ||
      low === undefined ||
      prevHigh === undefined ||
      prevLow === undefined ||
      prevClose === undefined
    ) {
      return null;
    }

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;

    if (trDmCount < period) {
      smoothTr += tr;
      smoothPlusDm += plusDm;
      smoothMinusDm += minusDm;
      trDmCount += 1;
      if (trDmCount < period) {
        continue;
      }
    } else {
      smoothTr = smoothTr - smoothTr / period + tr;
      smoothPlusDm = smoothPlusDm - smoothPlusDm / period + plusDm;
      smoothMinusDm = smoothMinusDm - smoothMinusDm / period + minusDm;
    }

    const dx = calculateDx(smoothTr, smoothPlusDm, smoothMinusDm);
    if (dxCount < period) {
      initialDxSum += dx;
      dxCount += 1;
      if (dxCount === period) {
        adx = initialDxSum / period;
      }

      continue;
    }

    if (adx === null) {
      return null;
    }

    adx = (adx * (period - 1) + dx) / period;
  }

  if (adx === null) {
    return null;
  }

  return roundToFixed2(adx);
}

/**
 * 根据平滑后的 TR/+DM/-DM 计算单个 DX。
 *
 * @param smoothTr 平滑 True Range
 * @param smoothPlusDm 平滑 +DM
 * @param smoothMinusDm 平滑 -DM
 * @returns DX 值
 */
function calculateDx(smoothTr: number, smoothPlusDm: number, smoothMinusDm: number): number {
  if (smoothTr === 0) {
    return 0;
  }

  const plusDi = (smoothPlusDm / smoothTr) * 100;
  const minusDi = (smoothMinusDm / smoothTr) * 100;
  const diSum = plusDi + minusDi;

  if (diSum === 0) {
    return 0;
  }

  return (Math.abs(plusDi - minusDi) / diSum) * 100;
}
