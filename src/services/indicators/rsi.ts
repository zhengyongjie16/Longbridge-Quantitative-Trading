/**
 * RSI（相对强弱指标）计算模块
 *
 * 指标特点：
 * - 周期可配置（通过参数传入）
 * - 使用本地算法计算并输出稳定数值
 * - 返回值范围 0-100
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { logDebug, roundToFixed2, toNumber } from './utils.js';
import { validatePercentage } from '../../utils/helpers/indicatorHelpers.js';
import type { CandleData } from '../../types/data.js';
import type { RsiStreamState } from './types.js';

/** 初始化 RSI 流式状态：前 period 根 K 线用 SMA 平滑涨跌，之后切换为 Wilder 平滑 */
function initRsiStreamState(period: number): RsiStreamState {
  return {
    period,
    per: 1 / period,
    previousClose: null,
    seedDiffCount: 0,
    seedUpSum: 0,
    seedDownSum: 0,
    smoothUp: 0,
    smoothDown: 0,
    lastRawValue: null,
  };
}

/**
 * 喂入一根 K 线收盘价，更新平滑涨跌与原始 RSI 值（流式递推）。
 * @param state - RSI 流式状态
 * @param currentClose - 当前 K 线收盘价
 * @returns void
 */
function updateRsiStreamState(state: RsiStreamState, currentClose: number): void {
  if (state.previousClose === null) {
    state.previousClose = currentClose;
    return;
  }

  const previousClose = state.previousClose;
  const upward = currentClose > previousClose ? currentClose - previousClose : 0;
  const downward = currentClose < previousClose ? previousClose - currentClose : 0;

  if (state.seedDiffCount < state.period) {
    state.seedUpSum += upward;
    state.seedDownSum += downward;
    state.seedDiffCount += 1;

    if (state.seedDiffCount === state.period) {
      state.smoothUp = state.seedUpSum / state.period;
      state.smoothDown = state.seedDownSum / state.period;
      state.lastRawValue = 100 * (state.smoothUp / (state.smoothUp + state.smoothDown));
    }

    state.previousClose = currentClose;
    return;
  }

  state.smoothUp = (upward - state.smoothUp) * state.per + state.smoothUp;
  state.smoothDown = (downward - state.smoothDown) * state.per + state.smoothDown;
  state.lastRawValue = 100 * (state.smoothUp / (state.smoothUp + state.smoothDown));
  state.previousClose = currentClose;
}

/**
 * 从状态中取出最终 RSI 值并四舍五入；无下跌动量等边界时返回 100 避免 NaN。
 * @param state - RSI 流式状态
 * @returns 最终 RSI 值（0–100），未就绪时返回 null
 */
function finalizeRsiValue(state: RsiStreamState): number | null {
  if (state.lastRawValue === null) {
    return null;
  }

  if (!Number.isFinite(state.lastRawValue)) {
    // 在无下跌动量等边界场景下，统一返回上边界值，避免 NaN 传递
    return 100;
  }

  return roundToFixed2(state.lastRawValue);
}

/**
 * 计算 RSI（相对强弱指标）
 * @param candles K线数据数组
 * @param period RSI周期，例如：6（RSI6）
 * @returns RSI值（0-100），如果无法计算则返回null
 */
export function calculateRSI(candles: ReadonlyArray<CandleData>, period: number): number | null {
  if (candles.length <= period || !Number.isFinite(period) || period <= 0) {
    return null;
  }

  try {
    const state = initRsiStreamState(period);
    for (const candle of candles) {
      const close = toNumber(candle.close);
      if (!isValidPositiveNumber(close)) {
        continue;
      }
      updateRsiStreamState(state, close);
    }

    const rsi = finalizeRsiValue(state);

    if (rsi === null || !validatePercentage(rsi)) {
      return null;
    }

    return rsi;
  } catch (err) {
    logDebug(`RSI计算失败 (period=${period})`, err);
    return null;
  }
}
