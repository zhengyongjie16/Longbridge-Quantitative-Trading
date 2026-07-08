/**
 * KDJ（随机指标）计算模块
 *
 * 指标参数：
 * - RSV 窗口周期：默认 9（计算最高价、最低价的窗口大小）
 * - K/D 平滑周期：3（对 RSV 与 K 分别做 rolling SMA）
 * - J = 3K - 2D
 */
import { roundToFixed3, toNumber } from './utils.js';
import type { KDJIndicator } from '../../../types/quote.js';
import type { CandleData } from '../../../types/data.js';
import type { KdjStreamState } from './types.js';

/**
 * 创建 KDJ 流式状态。
 *
 * @param period RSV 窗口周期
 * @param signalPeriod K/D 平滑周期
 * @returns 初始化状态
 */
export function createKdjState(period: number = 9, signalPeriod: number = 3): KdjStreamState {
  return {
    period,
    signalPeriod,
    index: 0,
    maxIndexDeque: [],
    maxValueDeque: [],
    minIndexDeque: [],
    minValueDeque: [],
    rsvWindow: [],
    rsvWindowSum: 0,
    kWindow: [],
    kWindowSum: 0,
    hasKdjValue: false,
    lastK: 0,
    lastD: 0,
  };
}

/**
 * 克隆 KDJ 状态。
 *
 * @param state 原始状态
 * @returns 深拷贝状态
 */
export function cloneKdjState(state: KdjStreamState): KdjStreamState {
  return {
    period: state.period,
    signalPeriod: state.signalPeriod,
    index: state.index,
    maxIndexDeque: [...state.maxIndexDeque],
    maxValueDeque: [...state.maxValueDeque],
    minIndexDeque: [...state.minIndexDeque],
    minValueDeque: [...state.minValueDeque],
    rsvWindow: [...state.rsvWindow],
    rsvWindowSum: state.rsvWindowSum,
    kWindow: [...state.kWindow],
    kWindowSum: state.kWindowSum,
    hasKdjValue: state.hasKdjValue,
    lastK: state.lastK,
    lastD: state.lastD,
  };
}

function dropOutdatedEntries(state: KdjStreamState, windowStart: number): void {
  while (state.maxIndexDeque.length > 0) {
    const headIndex = state.maxIndexDeque[0];
    if (headIndex !== undefined && headIndex < windowStart) {
      state.maxIndexDeque.shift();
      state.maxValueDeque.shift();
      continue;
    }

    break;
  }

  while (state.minIndexDeque.length > 0) {
    const headIndex = state.minIndexDeque[0];
    if (headIndex !== undefined && headIndex < windowStart) {
      state.minIndexDeque.shift();
      state.minValueDeque.shift();
      continue;
    }

    break;
  }
}

function pushRollingWindow(window: number[], nextValue: number, size: number): number {
  window.push(nextValue);
  if (window.length > size) {
    return window.shift() ?? 0;
  }

  return 0;
}

/**
 * 提交一根 K 线到 KDJ 状态。
 *
 * @param state KDJ 状态
 * @param candle K 线
 * @returns void
 */
export function commitKdjCandle(state: KdjStreamState, candle: CandleData): void {
  const i = state.index;
  state.index += 1;

  const high = toNumber(candle.high);
  if (Number.isFinite(high)) {
    while (state.maxValueDeque.length > 0) {
      const tailValue = state.maxValueDeque.at(-1);
      if (tailValue !== undefined && tailValue <= high) {
        state.maxValueDeque.pop();
        state.maxIndexDeque.pop();
        continue;
      }

      break;
    }

    state.maxIndexDeque.push(i);
    state.maxValueDeque.push(high);
  }

  const low = toNumber(candle.low);
  if (Number.isFinite(low)) {
    while (state.minValueDeque.length > 0) {
      const tailValue = state.minValueDeque.at(-1);
      if (tailValue !== undefined && tailValue >= low) {
        state.minValueDeque.pop();
        state.minIndexDeque.pop();
        continue;
      }

      break;
    }

    state.minIndexDeque.push(i);
    state.minValueDeque.push(low);
  }

  if (i < state.period - 1) {
    return;
  }

  const windowStart = i - state.period + 1;
  dropOutdatedEntries(state, windowStart);

  const highestHigh = state.maxValueDeque[0];
  const lowestLow = state.minValueDeque[0];
  if (highestHigh === undefined || lowestLow === undefined) {
    return;
  }

  const close = toNumber(candle.close);
  if (!Number.isFinite(close)) {
    return;
  }

  const range = highestHigh - lowestLow;
  if (!Number.isFinite(range) || range === 0) {
    return;
  }

  const rsv = ((close - lowestLow) / range) * 100;
  state.rsvWindowSum += rsv - pushRollingWindow(state.rsvWindow, rsv, state.signalPeriod);
  if (state.rsvWindow.length < state.signalPeriod) {
    return;
  }

  const kValue = state.rsvWindowSum / state.signalPeriod;
  state.lastK = kValue;
  state.kWindowSum += kValue - pushRollingWindow(state.kWindow, kValue, state.signalPeriod);
  if (state.kWindow.length < state.signalPeriod) {
    return;
  }

  state.lastD = state.kWindowSum / state.signalPeriod;
  state.hasKdjValue = true;
}

/**
 * 读取 KDJ 当前可用值。
 *
 * @param state KDJ 状态
 * @returns KDJ 值，不可用返回 null
 */
export function readKdjValue(state: KdjStreamState): KDJIndicator | null {
  if (!state.hasKdjValue) {
    return null;
  }

  const jValue = 3 * state.lastK - 2 * state.lastD;
  if (!Number.isFinite(state.lastK) || !Number.isFinite(state.lastD) || !Number.isFinite(jValue)) {
    return null;
  }

  return {
    k: roundToFixed3(state.lastK),
    d: roundToFixed3(state.lastD),
    j: roundToFixed3(jValue),
  };
}
