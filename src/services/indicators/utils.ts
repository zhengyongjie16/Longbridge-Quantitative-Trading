import { IS_DEBUG } from '../../constants/index.js';
import { logger } from '../../utils/logger/index.js';
import type { CandleValue } from '../../types/data.js';
import type { PoolableKDJ, PoolableMACD } from '../../utils/objectPool/types.js';
import type { EmaStreamState } from './types.js';

/**
 * 将 K 线数据值转换为数字
 * @param value K 线数据值（支持 Decimal、number、string）
 * @returns 数字值，无效值返回 0
 */
export function toNumber(value: CandleValue): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Number(value);
  }

  // Decimal 类型：使用 toString() 转换
  return Number(value.toString());
}

/**
 * 将数值按技术指标展示精度保留两位小数。默认行为：沿用 Number.toFixed 的四舍五入规则。
 *
 * @param value 原始数值
 * @returns 保留两位小数后的 number
 */
export function roundToFixed2(value: number): number {
  return Number.parseFloat(value.toFixed(2));
}

/**
 * 验证百分比值是否在 0-100 范围内。默认行为：非 number 或超出范围返回 false。
 *
 * @param value 待验证的百分比值
 * @returns 在 0-100 范围内返回 true，否则返回 false
 */
export function validatePercentage(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * 记录调试日志（仅在 IS_DEBUG 模式下输出）
 * @param message 日志消息
 * @param error 可选的错误对象
 * @returns void
 */
export function logDebug(message: string, error?: unknown): void {
  if (IS_DEBUG) {
    logger.debug(message, error);
  }
}

/**
 * 检查 PoolableKDJ 是否可以安全转换为 KDJIndicator
 * @param obj 对象池中的 KDJ 对象
 * @returns 如果所有字段都是有效数字则返回 true
 */
export function isValidKDJ(
  obj: PoolableKDJ,
): obj is PoolableKDJ & { k: number; d: number; j: number } {
  return (
    typeof obj.k === 'number' &&
    typeof obj.d === 'number' &&
    typeof obj.j === 'number' &&
    Number.isFinite(obj.k) &&
    Number.isFinite(obj.d) &&
    Number.isFinite(obj.j)
  );
}

/**
 * 检查 PoolableMACD 是否可以安全转换为 MACDIndicator
 * @param obj 对象池中的 MACD 对象
 * @returns 如果所有字段都是有效数字则返回 true
 */
export function isValidMACD(
  obj: PoolableMACD,
): obj is PoolableMACD & { macd: number; dif: number; dea: number } {
  return (
    typeof obj.macd === 'number' &&
    typeof obj.dif === 'number' &&
    typeof obj.dea === 'number' &&
    Number.isFinite(obj.macd) &&
    Number.isFinite(obj.dif) &&
    Number.isFinite(obj.dea)
  );
}

/**
 * 初始化 EMA 流式计算状态
 *
 * 前 period 个值累加作为 SMA seed，之后切换为 EMA 递推。
 * 供 RSI/EMA/MACD 等指标的流式计算共用。
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
 * 向 EMA 流式状态喂入一个新值
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
