/**
 * 类型守卫函数
 */

import { Signal, SignalType, BuySignal, SellSignal, HoldSignal } from './core.js';

/**
 * 判断是否为买入信号
 */
export function isBuySignal(signal: Signal): signal is BuySignal {
  return signal.action === SignalType.BUYCALL || signal.action === SignalType.BUYPUT;
}

/**
 * 判断是否为卖出信号
 */
export function isSellSignal(signal: Signal): signal is SellSignal {
  return signal.action === SignalType.SELLCALL || signal.action === SignalType.SELLPUT;
}

/**
 * 判断是否为持有信号
 */
export function isHoldSignal(signal: Signal): signal is HoldSignal {
  return signal.action === SignalType.HOLD;
}

/**
 * 检查值是否为有效数字
 */
export function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 检查值是否已定义（非 null 和非 undefined）
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value != null;
}

/**
 * 检查是否为正数
 */
export function isPositiveNumber(value: number): boolean {
  return value > 0;
}

/**
 * 判断信号是否为买入操作
 */
export function isBuyAction(action: SignalType | string): boolean {
  return action === SignalType.BUYCALL || action === SignalType.BUYPUT;
}

/**
 * 判断信号是否为卖出操作
 */
export function isSellAction(action: SignalType | string): boolean {
  return action === SignalType.SELLCALL || action === SignalType.SELLPUT;
}
