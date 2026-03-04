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
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { toNumber, logDebug, roundToFixed2 } from './utils.js';
import type { CandleData } from '../../types/data.js';

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
 * 安全读取数组元素，索引越界时返回 0。
 *
 * @param arr 数字数组
 * @param index 索引
 * @returns 对应元素值，越界时返回 0
 */
function at(arr: ReadonlyArray<number>, index: number): number {
  return arr[index] ?? 0;
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
  const length = highs.length;

  // 计算 TR、+DM、-DM 序列（从第 1 根开始，共 length - 1 个值）
  const trValues: number[] = [];
  const plusDmValues: number[] = [];
  const minusDmValues: number[] = [];

  for (let i = 1; i < length; i += 1) {
    const high = at(highs, i);
    const low = at(lows, i);
    const prevHigh = at(highs, i - 1);
    const prevLow = at(lows, i - 1);
    const prevClose = at(closes, i - 1);

    // True Range
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);

    // +DM / -DM
    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    if (upMove > downMove && upMove > 0) {
      plusDmValues.push(upMove);
    } else {
      plusDmValues.push(0);
    }

    if (downMove > upMove && downMove > 0) {
      minusDmValues.push(downMove);
    } else {
      minusDmValues.push(0);
    }
  }

  const dmCount = trValues.length;
  // 需要至少 2 * period 个 TR/DM 值
  if (dmCount < 2 * period) {
    return null;
  }

  // Wilder 平滑初始值：前 period 个值求和
  let smoothTr = 0;
  let smoothPlusDm = 0;
  let smoothMinusDm = 0;

  for (let i = 0; i < period; i += 1) {
    smoothTr += at(trValues, i);
    smoothPlusDm += at(plusDmValues, i);
    smoothMinusDm += at(minusDmValues, i);
  }

  // 计算 DX 序列
  const dxValues: number[] = [];

  // 首个 DI 值
  pushDx(dxValues, smoothTr, smoothPlusDm, smoothMinusDm);

  // 后续用 Wilder 平滑递推
  for (let i = period; i < dmCount; i += 1) {
    smoothTr = smoothTr - smoothTr / period + at(trValues, i);
    smoothPlusDm = smoothPlusDm - smoothPlusDm / period + at(plusDmValues, i);
    smoothMinusDm = smoothMinusDm - smoothMinusDm / period + at(minusDmValues, i);

    pushDx(dxValues, smoothTr, smoothPlusDm, smoothMinusDm);
  }

  if (dxValues.length < period) {
    return null;
  }

  // 对 DX 序列做 Wilder 平滑得到 ADX
  let adx = 0;
  for (let i = 0; i < period; i += 1) {
    adx += at(dxValues, i);
  }
  adx /= period;

  for (let i = period; i < dxValues.length; i += 1) {
    adx = (adx * (period - 1) + at(dxValues, i)) / period;
  }

  return roundToFixed2(adx);
}

/**
 * 根据平滑后的 TR/+DM/-DM 计算 DX 并追加到数组。
 *
 * @param dxValues 输出数组
 * @param smoothTr 平滑 True Range
 * @param smoothPlusDm 平滑 +DM
 * @param smoothMinusDm 平滑 -DM
 */
function pushDx(
  dxValues: number[],
  smoothTr: number,
  smoothPlusDm: number,
  smoothMinusDm: number,
): void {
  if (smoothTr === 0) {
    dxValues.push(0);
    return;
  }

  const plusDi = (smoothPlusDm / smoothTr) * 100;
  const minusDi = (smoothMinusDm / smoothTr) * 100;
  const diSum = plusDi + minusDi;

  if (diSum === 0) {
    dxValues.push(0);
    return;
  }

  const dx = (Math.abs(plusDi - minusDi) / diSum) * 100;
  dxValues.push(dx);
}
