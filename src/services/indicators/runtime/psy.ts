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
import type { PsyStreamState } from './types.js';

/**
 * 初始化 PSY 流式状态：环形窗口记录涨跌标志，用于统计周期内上涨天数占比。
 * @param period - PSY 周期
 * @returns 初始化后的 PsyStreamState
 */
export function createPsyState(period: number): PsyStreamState {
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
export function commitPsyClose(state: PsyStreamState, close: number): void {
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
 * 克隆 PSY 流式状态。
 *
 * @param state 原始 PSY 状态
 * @returns 深拷贝状态
 */
export function clonePsyState(state: PsyStreamState): PsyStreamState {
  return {
    period: state.period,
    upFlags: [...state.upFlags],
    previousClose: state.previousClose,
    validCloseCount: state.validCloseCount,
    windowCount: state.windowCount,
    windowIndex: state.windowIndex,
    upCount: state.upCount,
  };
}

/**
 * 读取 PSY 状态当前可用值。
 *
 * @param state PSY 状态
 * @returns 可用 PSY 值，不可用返回 null
 */
export function readPsyValue(state: PsyStreamState): number | null {
  if (state.validCloseCount <= state.period) {
    return null;
  }

  const psy = (state.upCount / state.period) * 100;
  return Number.isFinite(psy) ? psy : null;
}
