/**
 * 对象池模块类型定义
 */

import type { SignalType, VerificationEntry } from '../../types/index.js';

/**
 * 对象池 - Signal
 * 注意：对象池类型是可变的，用于对象重用
 * 属性使用可选标记以匹配 Signal 类型
 */
export type PoolableSignal = {
  symbol: string | null;
  symbolName: string | null;
  action: SignalType | null;
  reason?: string | null;
  price?: number | null;
  lotSize?: number | null;
  quantity?: number | null;
  /**
   * 信号触发时间（统一使用此字段）
   * - 立即信号：信号生成时间
   * - 延迟信号：延迟验证的基准时间（T0）
   * - 末日保护信号：信号生成时间
   */
  triggerTime?: Date | null;
  indicators1?: Record<string, number> | null;
  verificationHistory?: VerificationEntry[] | null;
  /** @deprecated 已废弃，请使用 triggerTime */
  signalTriggerTime?: Date | null;
};

/**
 * 对象池 - KDJ
 */
export type PoolableKDJ = {
  k: number | null;
  d: number | null;
  j: number | null;
};

/**
 * 对象池 - MACD
 */
export type PoolableMACD = {
  macd: number | null;
  dif: number | null;
  dea: number | null;
};

/**
 * 对象池 - 监控数值
 */
export type PoolableMonitorValues = {
  price: number | null;
  changePercent: number | null;
  ema: Record<number, number> | null;
  rsi: Record<number, number> | null;
  mfi: number | null;
  kdj: PoolableKDJ | null;
  macd: PoolableMACD | null;
};

/**
 * 对象池 - Position
 */
export type PoolablePosition = {
  symbol: string | null;
  costPrice: number;
  quantity: number;
  availableQuantity: number;
};

/**
 * 对象池 - VerificationEntry
 * 注意：对象池类型是可变的，用于对象重用
 */
export type PoolableVerificationEntry = {
  timestamp: Date | null;
  indicators: Record<string, number> | null;
};

/**
 * 工厂函数类型
 */
export type Factory<T> = () => T;

/**
 * 重置函数类型
 */
export type Reset<T> = (obj: T) => T;

/**
 * 对象池接口
 */
export type ObjectPool<T> = {
  acquire(): T;
  release(obj: T | null | undefined): void;
  releaseAll(objects: T[] | null | undefined): void;
};

/**
 * 检查 PoolableKDJ 是否可以安全转换为 KDJIndicator
 * @param obj 对象池中的 KDJ 对象
 * @returns 如果所有字段都是有效数字则返回 true
 */
export const isValidKDJ = (obj: PoolableKDJ): obj is PoolableKDJ & { k: number; d: number; j: number } => {
  return (
    typeof obj.k === 'number' &&
    typeof obj.d === 'number' &&
    typeof obj.j === 'number' &&
    Number.isFinite(obj.k) &&
    Number.isFinite(obj.d) &&
    Number.isFinite(obj.j)
  );
};

/**
 * 检查 PoolableMACD 是否可以安全转换为 MACDIndicator
 * @param obj 对象池中的 MACD 对象
 * @returns 如果所有字段都是有效数字则返回 true
 */
export const isValidMACD = (obj: PoolableMACD): obj is PoolableMACD & { macd: number; dif: number; dea: number } => {
  return (
    typeof obj.macd === 'number' &&
    typeof obj.dif === 'number' &&
    typeof obj.dea === 'number' &&
    Number.isFinite(obj.macd) &&
    Number.isFinite(obj.dif) &&
    Number.isFinite(obj.dea)
  );
};

