/**
 * RSI（相对强弱指标）计算模块
 *
 * 指标特点：
 * - 周期可配置（通过参数传入）
 * - 使用本地算法计算并输出稳定数值
 * - 返回值范围 0-100
 */
import { roundToFixed3 } from './utils.js';
import type { RsiStreamState } from './types.js';

/**
 * 初始化 RSI 流式状态：前 period 根 K 线用 SMA 平滑涨跌，之后切换为 Wilder 平滑。
 *
 * @param period RSI 周期
 * @returns 初始化的 RsiStreamState
 */
export function createRsiState(period: number): RsiStreamState {
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
export function commitRsiClose(state: RsiStreamState, currentClose: number): void {
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
export function readRsiValue(state: RsiStreamState): number | null {
  if (state.lastRawValue === null) {
    return null;
  }

  if (!Number.isFinite(state.lastRawValue)) {
    // 在无下跌动量等边界场景下，统一返回上边界值，避免 NaN 传递
    return 100;
  }

  return roundToFixed3(state.lastRawValue);
}

/**
 * 克隆 RSI 流式状态。
 *
 * @param state 原始 RSI 状态
 * @returns 深拷贝状态
 */
export function cloneRsiState(state: RsiStreamState): RsiStreamState {
  return {
    period: state.period,
    per: state.per,
    previousClose: state.previousClose,
    seedDiffCount: state.seedDiffCount,
    seedUpSum: state.seedUpSum,
    seedDownSum: state.seedDownSum,
    smoothUp: state.smoothUp,
    smoothDown: state.smoothDown,
    lastRawValue: state.lastRawValue,
  };
}
