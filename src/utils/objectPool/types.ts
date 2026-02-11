/**
 * 对象池类型定义模块
 *
 * 定义对象池相关的类型：
 * - Poolable* 系列：可池化对象类型（属性可变，支持 null）
 * - Factory：对象工厂函数类型
 * - Reset：对象重置函数类型
 * - ObjectPool：对象池接口
 *
 * 设计说明：
 * - 对象池类型使用可变属性和 | null 标记，这是性能优化的必要例外
 * - 使用对象池对象后必须及时释放，嵌套对象也需递归释放
 */
import type { OrderTypeConfig, SignalType } from '../../types/index.js';

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
  orderTypeOverride?: OrderTypeConfig | null;
  isProtectiveLiquidation?: boolean | null;
  price?: number | null;
  lotSize?: number | null;
  quantity?: number | null;
  seatVersion?: number | null;
  /**
   * 信号触发时间（统一使用此字段）
   * - 立即信号：信号生成时间
   * - 延迟信号：延迟验证的基准时间（T0）
   * - 末日保护信号：信号生成时间
   */
  triggerTime?: Date | null;
  indicators1?: Record<string, number> | null;
  verificationHistory?: PoolableVerificationEntry[] | null;
  relatedBuyOrderIds?: readonly string[] | null;
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
  psy: Record<number, number> | null;
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
export interface ObjectPool<T> {
  acquire(): T;
  release(obj: T | null | undefined): void;
  releaseAll(objects: ReadonlyArray<T> | null | undefined): void;
}

