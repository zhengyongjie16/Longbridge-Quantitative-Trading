/**
 * MACD（指数平滑异同移动平均线）计算模块
 *
 * 指标参数：DIF=EMA12-EMA26，DEA=EMA9(DIF)，MACD柱=2*(DIF-DEA)
 */
import { initEmaStreamState, feedEmaStreamState, roundToFixed3 } from './utils.js';
import type { MACDIndicator } from '../../../types/quote.js';
import type { MacdStreamState } from './types.js';

/**
 * 创建 MACD 流式状态。
 *
 * @param fastPeriod 快线周期
 * @param slowPeriod 慢线周期
 * @param signalPeriod 信号线周期
 * @returns 初始化状态
 */
export function createMacdState(
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): MacdStreamState {
  return {
    fastPeriod,
    slowPeriod,
    signalPeriod,
    fastEmaState: initEmaStreamState(fastPeriod),
    slowEmaState: initEmaStreamState(slowPeriod),
    signalEmaState: initEmaStreamState(signalPeriod),
    validCloseCount: 0,
    lastDif: null,
    lastSignal: null,
    lastHistogram: null,
  };
}

/**
 * 克隆 MACD 状态。
 *
 * @param state 原始状态
 * @returns 深拷贝状态
 */
export function cloneMacdState(state: MacdStreamState): MacdStreamState {
  return {
    fastPeriod: state.fastPeriod,
    slowPeriod: state.slowPeriod,
    signalPeriod: state.signalPeriod,
    fastEmaState: {
      period: state.fastEmaState.period,
      per: state.fastEmaState.per,
      seedCount: state.fastEmaState.seedCount,
      seedSum: state.fastEmaState.seedSum,
      emaValue: state.fastEmaState.emaValue,
    },
    slowEmaState: {
      period: state.slowEmaState.period,
      per: state.slowEmaState.per,
      seedCount: state.slowEmaState.seedCount,
      seedSum: state.slowEmaState.seedSum,
      emaValue: state.slowEmaState.emaValue,
    },
    signalEmaState: {
      period: state.signalEmaState.period,
      per: state.signalEmaState.per,
      seedCount: state.signalEmaState.seedCount,
      seedSum: state.signalEmaState.seedSum,
      emaValue: state.signalEmaState.emaValue,
    },
    validCloseCount: state.validCloseCount,
    lastDif: state.lastDif,
    lastSignal: state.lastSignal,
    lastHistogram: state.lastHistogram,
  };
}

/**
 * 提交一根有效 close 到 MACD 状态。
 *
 * @param state MACD 状态
 * @param close 收盘价
 * @returns void
 */
export function commitMacdClose(state: MacdStreamState, close: number): void {
  state.validCloseCount += 1;

  const fastEmaValue = feedEmaStreamState(state.fastEmaState, close);
  const slowEmaValue = feedEmaStreamState(state.slowEmaState, close);
  if (fastEmaValue === null || slowEmaValue === null) {
    return;
  }

  const dif = fastEmaValue - slowEmaValue;
  const signalValue = feedEmaStreamState(state.signalEmaState, dif);
  if (signalValue === null) {
    return;
  }

  state.lastDif = dif;
  state.lastSignal = signalValue;
  state.lastHistogram = dif - signalValue;
}

/**
 * 读取 MACD 当前可用值。
 *
 * @param state MACD 状态
 * @returns MACD 指标值，不可用返回 null
 */
export function readMacdValue(state: MacdStreamState): MACDIndicator | null {
  if (state.validCloseCount < state.slowPeriod + state.signalPeriod) {
    return null;
  }

  if (state.lastDif === null || state.lastSignal === null || state.lastHistogram === null) {
    return null;
  }

  const macdValue = state.lastHistogram * 2;
  if (
    !Number.isFinite(state.lastDif) ||
    !Number.isFinite(state.lastSignal) ||
    !Number.isFinite(macdValue)
  ) {
    return null;
  }

  return {
    dif: roundToFixed3(state.lastDif),
    dea: roundToFixed3(state.lastSignal),
    macd: roundToFixed3(macdValue),
  };
}
