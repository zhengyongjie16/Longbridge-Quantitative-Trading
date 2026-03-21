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
import type { AdxStreamState } from './types.js';

/**
 * 创建 ADX 流式状态。
 *
 * @param period ADX 周期
 * @returns 初始化状态
 */
export function createAdxState(period: number = 14): AdxStreamState {
  return {
    period,
    prevHigh: null,
    prevLow: null,
    prevClose: null,
    trDmCount: 0,
    smoothTr: 0,
    smoothPlusDm: 0,
    smoothMinusDm: 0,
    initialDxSum: 0,
    dxCount: 0,
    adx: null,
  };
}

/**
 * 克隆 ADX 状态。
 *
 * @param state 原始状态
 * @returns 深拷贝状态
 */
export function cloneAdxState(state: AdxStreamState): AdxStreamState {
  return {
    period: state.period,
    prevHigh: state.prevHigh,
    prevLow: state.prevLow,
    prevClose: state.prevClose,
    trDmCount: state.trDmCount,
    smoothTr: state.smoothTr,
    smoothPlusDm: state.smoothPlusDm,
    smoothMinusDm: state.smoothMinusDm,
    initialDxSum: state.initialDxSum,
    dxCount: state.dxCount,
    adx: state.adx,
  };
}

/**
 * 提交一根 K 线到 ADX 状态。
 *
 * @param state ADX 状态
 * @param candle K 线
 * @returns void
 */
export function commitAdxCandle(state: AdxStreamState, candle: CandleData): void {
  const high = toNumber(candle.high);
  const low = toNumber(candle.low);
  const close = toNumber(candle.close);
  if (
    !isValidPositiveNumber(high) ||
    !isValidPositiveNumber(low) ||
    !isValidPositiveNumber(close)
  ) {
    return;
  }

  if (state.prevHigh === null || state.prevLow === null || state.prevClose === null) {
    state.prevHigh = high;
    state.prevLow = low;
    state.prevClose = close;
    return;
  }

  const tr = Math.max(
    high - low,
    Math.abs(high - state.prevClose),
    Math.abs(low - state.prevClose),
  );
  const upMove = high - state.prevHigh;
  const downMove = state.prevLow - low;
  const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
  const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;

  if (state.trDmCount < state.period) {
    state.smoothTr += tr;
    state.smoothPlusDm += plusDm;
    state.smoothMinusDm += minusDm;
    state.trDmCount += 1;
    if (state.trDmCount < state.period) {
      state.prevHigh = high;
      state.prevLow = low;
      state.prevClose = close;
      return;
    }
  } else {
    state.smoothTr = state.smoothTr - state.smoothTr / state.period + tr;
    state.smoothPlusDm = state.smoothPlusDm - state.smoothPlusDm / state.period + plusDm;
    state.smoothMinusDm = state.smoothMinusDm - state.smoothMinusDm / state.period + minusDm;
  }

  const dx = calculateDx(state.smoothTr, state.smoothPlusDm, state.smoothMinusDm);
  if (state.dxCount < state.period) {
    state.initialDxSum += dx;
    state.dxCount += 1;
    if (state.dxCount === state.period) {
      state.adx = state.initialDxSum / state.period;
    }
  } else if (state.adx !== null) {
    state.adx = (state.adx * (state.period - 1) + dx) / state.period;
  }

  state.prevHigh = high;
  state.prevLow = low;
  state.prevClose = close;
}

/**
 * 读取 ADX 当前可用值。
 *
 * @param state ADX 状态
 * @returns ADX 值，不可用返回 null
 */
export function readAdxValue(state: AdxStreamState): number | null {
  if (state.adx === null) {
    return null;
  }

  return roundToFixed2(state.adx);
}

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
    const state = createAdxState(period);
    let validCount = 0;
    for (const candle of candles) {
      const high = toNumber(candle.high);
      const low = toNumber(candle.low);
      const close = toNumber(candle.close);
      if (
        !isValidPositiveNumber(high) ||
        !isValidPositiveNumber(low) ||
        !isValidPositiveNumber(close)
      ) {
        continue;
      }

      validCount += 1;
      commitAdxCandle(state, candle);
    }

    if (validCount < 2 * period + 1) {
      return null;
    }

    return readAdxValue(state);
  } catch (err) {
    logDebug(`ADX计算失败 (period=${period})`, err);
    return null;
  }
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
