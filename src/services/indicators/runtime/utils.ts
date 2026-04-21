import type { CandleData } from '../../../types/data.js';
import type { EmaStreamState } from './types.js';

/**
 * 将 K 线数据值转换为数字。
 *
 * @param value K 线数据值（支持 Decimal、number、string）
 * @returns 数字值，无效值返回 0
 */
export function toNumber(value: CandleData['close']): number {
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return Number(value);
  }

  return Number(value.toString());
}

/**
 * 将数值按技术指标展示精度保留三位小数。
 *
 * @param value 原始数值
 * @returns 保留三位小数后的 number
 */
export function roundToFixed3(value: number): number {
  return Number.parseFloat(value.toFixed(3));
}

/**
 * 验证百分比值是否在 0-100 范围内。
 *
 * @param value 待验证的百分比值
 * @returns 在 0-100 范围内返回 true，否则返回 false
 */
export function validatePercentage(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * 初始化 EMA 流式计算状态。
 *
 * 前 period 个值累加作为 SMA seed，之后切换为 EMA 递推。
 * 供 EMA 与 MACD 等指标的流式计算共用。
 *
 * @param period EMA 周期
 * @returns 初始化后的 EmaStreamState
 */
export function initEmaStreamState(period: number): EmaStreamState {
  return {
    period,
    per: 2 / (period + 1),
    seedCount: 0,
    seedSum: 0,
    emaValue: null,
  };
}

/**
 * 向 EMA 流式状态喂入一个新值。
 *
 * @param state EMA 流式计算状态
 * @param value 新的输入值
 * @returns 当前 EMA 值，seed 阶段未就绪时返回 null
 */
export function feedEmaStreamState(state: EmaStreamState, value: number): number | null {
  if (state.emaValue === null) {
    state.seedSum += value;
    state.seedCount += 1;
    if (state.seedCount === state.period) {
      state.emaValue = state.seedSum / state.period;
      return state.emaValue;
    }

    return null;
  }

  state.emaValue = (value - state.emaValue) * state.per + state.emaValue;
  return state.emaValue;
}
