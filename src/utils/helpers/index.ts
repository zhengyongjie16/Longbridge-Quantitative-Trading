import type { MonitorState } from '../../types/state.js';
import type { MonitorConfig } from '../../types/config.js';
import type { SignalType } from '../../types/signal.js';
import type { DecimalLike } from './types.js';

/**
 * 类型保护：判断 unknown 是否为可索引对象。
 *
 * @param value 待判断值
 * @returns true 表示可按键读取字段，否则返回 false
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 将 Decimal 类型转换为数字。
 *
 * @param decimalLike Decimal 对象、数字、字符串或 null/undefined
 * @returns 转换后的数字，null/undefined 时返回 NaN
 */
export function decimalToNumber(
  decimalLike: DecimalLike | number | string | null | undefined,
): number {
  if (decimalLike === null || decimalLike === undefined) {
    return Number.NaN;
  }

  if (typeof decimalLike === 'object' && 'toNumber' in decimalLike) {
    return decimalLike.toNumber();
  }

  return Number(decimalLike);
}

/**
 * 检查值是否为有效的正数。
 *
 * @param value 待检查的值
 * @returns 为有限正数时返回 true，否则返回 false
 */
export function isValidPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 判断是否为买入操作。
 *
 * @param action 信号类型
 * @returns 为 BUYCALL 或 BUYPUT 时返回 true
 */
export function isBuyAction(action: SignalType): boolean {
  return action === 'BUYCALL' || action === 'BUYPUT';
}

/**
 * 根据监控配置初始化单标的监控状态。
 *
 * @param config 监控配置（monitorSymbol 等）
 * @returns 初始化的 MonitorState
 */
export function initMonitorState(config: MonitorConfig): MonitorState {
  return {
    monitorSymbol: config.monitorSymbol,
    signal: null,
    pendingDelayedSignals: [],
    lastMonitorSnapshot: null,
    incrementalIndicatorRuntime: null,
  };
}
