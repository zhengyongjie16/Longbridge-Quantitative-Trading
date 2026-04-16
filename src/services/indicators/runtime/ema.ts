/**
 * EMA（指数移动平均线）计算模块
 *
 * 指标特点：
 * - 赋予近期数据更高权重，对价格变化更敏感
 * - 周期范围：1-250
 */
import { initEmaStreamState, feedEmaStreamState } from './utils.js';
import type { EmaStreamState } from './types.js';

/**
 * 创建 EMA 流式状态。
 *
 * @param period EMA 周期
 * @returns 初始化后的 EMA 状态
 */
export function createEmaState(period: number): EmaStreamState {
  return initEmaStreamState(period);
}

/**
 * 克隆 EMA 流式状态。
 *
 * @param state 原始状态
 * @returns 深拷贝状态
 */
export function cloneEmaState(state: EmaStreamState): EmaStreamState {
  return {
    period: state.period,
    per: state.per,
    seedCount: state.seedCount,
    seedSum: state.seedSum,
    emaValue: state.emaValue,
  };
}

/**
 * 推进 EMA 状态（提交一根有效 close）。
 *
 * @param state EMA 状态
 * @param close 收盘价
 * @returns void
 */
export function commitEmaClose(state: EmaStreamState, close: number): void {
  feedEmaStreamState(state, close);
}

/**
 * 从 EMA 状态读取当前可用值。
 *
 * @param state EMA 状态
 * @returns 可用 EMA 值，不可用返回 null
 */
export function readEmaValue(state: EmaStreamState): number | null {
  const ema = state.emaValue;
  if (ema === null || !Number.isFinite(ema) || ema <= 0) {
    return null;
  }

  return ema;
}
