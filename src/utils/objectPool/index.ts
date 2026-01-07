/**
 * 对象池模块
 *
 * 功能：
 * - 复用高频创建的临时对象
 * - 减少频繁的对象创建和垃圾回收
 * - 提升内存效率和系统性能
 *
 * 导出的对象池：
 * - verificationEntryPool：验证历史条目对象池（最大 50 个）
 * - positionObjectPool：持仓数据对象池（最大 10 个）
 * - signalObjectPool：信号对象池
 * - kdjObjectPool / macdObjectPool：指标对象池
 *
 * 核心方法：
 * - acquire()：从池中获取对象
 * - release(obj)：将对象归还到池中
 * - releaseAll(objects)：批量释放对象数组
 */

import type { SignalType, VerificationEntry } from '../../types/index.js';

// ==================== 对象池类型 ====================

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
  triggerTime?: Date | null;
  indicators1?: Record<string, number> | null;
  verificationHistory?: VerificationEntry[] | null;
  signalTriggerTime?: Date | null;
  useMarketOrder?: boolean | null;
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
type Factory<T> = () => T;

/**
 * 重置函数类型
 */
type Reset<T> = (obj: T) => T;

/**
 * 对象池接口
 */
export interface ObjectPool<T> {
  acquire(): T;
  release(obj: T | null | undefined): void;
  releaseAll(objects: T[] | null | undefined): void;
}

/**
 * 创建通用对象池
 * @param factory 工厂函数，用于创建新对象
 * @param reset 重置函数，用于重置对象状态
 * @param maxSize 池的最大容量
 * @returns ObjectPool 接口实例
 */
export const createObjectPool = <T>(
  factory: Factory<T> = () => ({} as T),
  reset: Reset<T> = (obj) => obj,
  maxSize: number = 100,
): ObjectPool<T> => {
  // 闭包捕获的私有状态
  const pool: T[] = [];

  /**
   * 从池中获取一个对象
   */
  const acquire = (): T => {
    if (pool.length > 0) {
      return pool.pop()!;
    }
    // 池为空，创建新对象
    return factory();
  };

  /**
   * 将对象归还到池中
   */
  const release = (obj: T | null | undefined): void => {
    if (!obj) return;

    // 如果池已满，直接丢弃对象（让GC回收）
    if (pool.length >= maxSize) {
      return;
    }

    // 重置对象状态
    const resetObj = reset(obj);
    pool.push(resetObj);
  };

  /**
   * 批量释放对象数组
   */
  const releaseAll = (objects: T[] | null | undefined): void => {
    if (!Array.isArray(objects)) return;
    objects.forEach((obj) => release(obj));
  };

  return {
    acquire,
    release,
    releaseAll,
  };
};

/**
 * 验证历史条目对象池
 * 用于 verificationHistory 数组中的条目对象
 */
export const verificationEntryPool = createObjectPool<PoolableVerificationEntry>(
  // 工厂函数：创建空对象（支持动态配置的验证指标）
  () => ({ timestamp: null, indicators: null }),
  // 重置函数：清空所有属性
  (obj) => {
    obj.timestamp = null;
    obj.indicators = null; // 清空引用，避免内存泄漏
    return obj;
  },
  50, // 最大保存50个对象（每个信号最多120个条目，通常不会同时存在这么多待验证信号）
);

/**
 * 交易信号对象池
 * 用于所有类型的交易信号对象（买入、卖出、清仓等）
 */
export const signalObjectPool = createObjectPool<PoolableSignal>(
  // 工厂函数：创建信号对象
  () => ({
    symbol: null,
    symbolName: null,
    action: null,
    reason: null,
    price: null,
    lotSize: null,
    quantity: null,
    triggerTime: null,
    indicators1: null,
    verificationHistory: null,
    signalTriggerTime: null,
    useMarketOrder: false,
  }),
  // 重置函数：清空所有属性
  (obj) => {
    obj.symbol = null;
    obj.symbolName = null;
    obj.action = null;
    obj.reason = null;
    obj.price = null;
    obj.lotSize = null;
    obj.quantity = null;
    obj.triggerTime = null;
    obj.indicators1 = null;
    obj.verificationHistory = null;
    obj.signalTriggerTime = null;
    obj.useMarketOrder = false;
    return obj;
  },
  100, // 最大保存100个信号对象
);

/**
 * KDJ指标对象池
 * 用于KDJ指标数据对象的复用
 */
export const kdjObjectPool = createObjectPool<PoolableKDJ>(
  // 工厂函数：创建空对象
  () => ({
    k: null,
    d: null,
    j: null,
  }),
  // 重置函数：清空所有属性
  (obj) => {
    obj.k = null;
    obj.d = null;
    obj.j = null;
    return obj;
  },
  50, // 最大保存50个KDJ对象
);

/**
 * MACD指标对象池
 * 用于MACD指标数据对象的复用
 */
export const macdObjectPool = createObjectPool<PoolableMACD>(
  // 工厂函数：创建空对象
  () => ({
    macd: null,
    dif: null,
    dea: null,
  }),
  // 重置函数：清空所有属性
  (obj) => {
    obj.macd = null;
    obj.dif = null;
    obj.dea = null;
    return obj;
  },
  50, // 最大保存50个MACD对象
);

/**
 * 监控值对象池
 * 用于监控标的指标缓存对象的复用
 */
export const monitorValuesObjectPool = createObjectPool<PoolableMonitorValues>(
  // 工厂函数：创建空对象
  () => ({
    price: null,
    changePercent: null,
    ema: null,
    rsi: null,
    mfi: null,
    kdj: null,
    macd: null,
  }),
  // 重置函数：清空所有属性
  (obj) => {
    obj.price = null;
    obj.changePercent = null;
    obj.ema = null;
    obj.rsi = null;
    obj.mfi = null;
    obj.kdj = null;
    obj.macd = null;
    return obj;
  },
  20, // 最大保存20个监控值对象
);

/**
 * 持仓对象池
 * 用于持仓数据对象的复用
 */
export const positionObjectPool = createObjectPool<PoolablePosition>(
  // 工厂函数：创建空对象
  () => ({
    symbol: null,
    costPrice: 0,
    quantity: 0,
    availableQuantity: 0,
  }),
  // 重置函数：清空所有属性
  (obj) => {
    obj.symbol = null;
    obj.costPrice = 0;
    obj.quantity = 0;
    obj.availableQuantity = 0;
    return obj;
  },
  10, // 通常不会有超过10个持仓
);
