/**
 * MFI（资金流量指标）计算模块
 *
 * 指标参数：
 * - MFI：周期 14，结合价格和成交量
 */
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { toNumber, roundToFixed2, validatePercentage } from './utils.js';
import type { CandleData } from '../../../types/data.js';
import type { BufferNewPush, MfiStreamState } from './types.js';

/**
 * 向环形缓冲区追加一个值，满窗时覆盖最旧项并更新 sum（O(1) 滑动窗口）。
 *
 * @param buffer 环形缓冲区（含 size、pushes、sum、data）
 * @param value 待追加的数值
 * @returns 无返回值（原地更新 buffer）
 */
function pushBuffer(buffer: BufferNewPush, value: number): void {
  if (buffer.pushes >= buffer.size) {
    const old = buffer.vals[buffer.index];
    if (old !== undefined) {
      buffer.sum -= old;
    }
  }

  buffer.sum += value;
  buffer.vals[buffer.index] = value;
  buffer.pushes += 1;
  buffer.index += 1;
  if (buffer.index >= buffer.size) {
    buffer.index = 0;
  }
}

/**
 * 克隆环形缓冲区状态。
 *
 * @param buffer 原始缓冲区
 * @returns 深拷贝缓冲区
 */
function cloneBuffer(buffer: BufferNewPush): BufferNewPush {
  return {
    size: buffer.size,
    index: buffer.index,
    pushes: buffer.pushes,
    sum: buffer.sum,
    vals: [...buffer.vals],
  };
}

/**
 * 创建 MFI 流式状态。
 *
 * @param period MFI 周期
 * @returns 初始化状态
 */
export function createMfiState(period: number = 14): MfiStreamState {
  return {
    period,
    previousTypicalPrice: null,
    validOhlcvCount: 0,
    upBuffer: {
      size: period,
      index: 0,
      pushes: 0,
      sum: 0,
      vals: [],
    },
    downBuffer: {
      size: period,
      index: 0,
      pushes: 0,
      sum: 0,
      vals: [],
    },
    lastRawValue: null,
  };
}

/**
 * 克隆 MFI 状态。
 *
 * @param state 原始状态
 * @returns 深拷贝状态
 */
export function cloneMfiState(state: MfiStreamState): MfiStreamState {
  return {
    period: state.period,
    previousTypicalPrice: state.previousTypicalPrice,
    validOhlcvCount: state.validOhlcvCount,
    upBuffer: cloneBuffer(state.upBuffer),
    downBuffer: cloneBuffer(state.downBuffer),
    lastRawValue: state.lastRawValue,
  };
}

/**
 * 提交一根 K 线到 MFI 状态。
 *
 * @param state MFI 状态
 * @param candle K 线数据
 * @returns void
 */
export function commitMfiCandle(state: MfiStreamState, candle: CandleData): void {
  const high = toNumber(candle.high);
  const low = toNumber(candle.low);
  const close = toNumber(candle.close);
  const volume = toNumber(candle.volume ?? 0);
  if (
    !isValidPositiveNumber(high) ||
    !isValidPositiveNumber(low) ||
    !isValidPositiveNumber(close) ||
    !Number.isFinite(volume) ||
    volume < 0
  ) {
    return;
  }

  const typicalPrice = (high + low + close) / 3;
  if (state.previousTypicalPrice === null) {
    state.previousTypicalPrice = typicalPrice;
    state.validOhlcvCount = 1;
    return;
  }

  const moneyFlow = typicalPrice * volume;
  if (typicalPrice > state.previousTypicalPrice) {
    pushBuffer(state.upBuffer, moneyFlow);
    pushBuffer(state.downBuffer, 0);
  } else if (typicalPrice < state.previousTypicalPrice) {
    pushBuffer(state.downBuffer, moneyFlow);
    pushBuffer(state.upBuffer, 0);
  } else {
    pushBuffer(state.upBuffer, 0);
    pushBuffer(state.downBuffer, 0);
  }

  state.previousTypicalPrice = typicalPrice;
  state.validOhlcvCount += 1;
  if (state.validOhlcvCount > state.period) {
    state.lastRawValue = (state.upBuffer.sum / (state.upBuffer.sum + state.downBuffer.sum)) * 100;
  }
}

/**
 * 读取 MFI 当前可用值。
 *
 * @param state MFI 状态
 * @returns MFI 值，不可用返回 null
 */
export function readMfiValue(state: MfiStreamState): number | null {
  if (state.validOhlcvCount < state.period + 1 || state.lastRawValue === null) {
    return null;
  }

  const mfi = roundToFixed2(state.lastRawValue);
  if (!validatePercentage(mfi)) {
    return null;
  }

  return mfi;
}
