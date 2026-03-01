/**
 * PSY（心理线指标）计算模块
 *
 * 计算方式：
 * - 统计周期内上涨天数占比
 * - PSY = (上涨天数 / 周期) × 100
 *
 * 指标解读：
 * - 高于 75：市场过热，可能回调
 * - 低于 25：市场过冷，可能反弹
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { logDebug, toNumber } from './utils.js';
import type { CandleData } from '../../types/data.js';
import type { PsyStreamState } from './types.js';

/**
 * 初始化 PSY 流式状态：环形窗口记录涨跌标志，用于统计周期内上涨天数占比。
 * @param period - PSY 周期
 * @returns 初始化后的 PsyStreamState
 */
function initPsyStreamState(period: number): PsyStreamState {
  return {
    period,
    upFlags: Array.from<number>({ length: period }).fill(0),
    previousClose: null,
    validCloseCount: 0,
    windowCount: 0,
    windowIndex: 0,
    upCount: 0,
  };
}

/**
 * 喂入一根 K 线收盘价，更新环形窗口内的上涨标志与 upCount（流式递推）。
 *
 * @param state PSY 流式状态（原地更新）
 * @param close 当前 K 线收盘价
 * @returns 无返回值
 */
function updatePsyStreamState(state: PsyStreamState, close: number): void {
  if (state.previousClose === null) {
    state.previousClose = close;
    state.validCloseCount = 1;
    return;
  }

  const isUp = close > state.previousClose ? 1 : 0;
  state.validCloseCount += 1;

  if (state.windowCount < state.period) {
    state.upFlags[state.windowCount] = isUp;
    state.windowCount += 1;
    state.upCount += isUp;
  } else {
    const oldFlag = state.upFlags[state.windowIndex];
    if (oldFlag !== undefined) {
      state.upCount -= oldFlag;
    }
    state.upFlags[state.windowIndex] = isUp;
    state.upCount += isUp;
    state.windowIndex = (state.windowIndex + 1) % state.period;
  }

  state.previousClose = close;
}

/**
 * 计算 PSY（心理线指标）
 * @param candles K线数据数组
 * @param period PSY 周期
 * @returns PSY 值（0-100），如果无法计算则返回 null
 */
export function calculatePSY(candles: ReadonlyArray<CandleData>, period: number): number | null {
  if (!Number.isInteger(period) || period <= 0 || candles.length <= period) {
    return null;
  }

  try {
    const state = initPsyStreamState(period);
    for (const candle of candles) {
      const close = toNumber(candle.close);
      if (!isValidPositiveNumber(close)) {
        continue;
      }
      updatePsyStreamState(state, close);
    }

    if (state.validCloseCount <= period) {
      return null;
    }

    const psy = (state.upCount / period) * 100;
    return Number.isFinite(psy) ? psy : null;
  } catch (err) {
    logDebug(`PSY计算失败 (period=${period})`, err);
    return null;
  }
}
