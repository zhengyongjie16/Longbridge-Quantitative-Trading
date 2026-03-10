import type {
  Factory,
  Reset,
  ObjectPool,
  PoolableSignal,
  PoolableKDJ,
  PoolableMACD,
  PoolableMonitorValues,
  PoolablePosition,
  PoolableVerificationEntry,
} from './types.js';
import type { Signal } from '../../types/signal.js';
import type { MonitorValues } from '../../types/data.js';

function resetRecordObject<T extends Record<string | number, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    Reflect.deleteProperty(obj, key);
  }

  return obj;
}

/**
 * 创建通用对象池，池空时用 factory 创建新对象，release 时用 reset 重置后放回池中。默认行为：maxSize 未传时为 100。
 *
 * @param factory 工厂函数，用于创建新对象
 * @param reset 重置函数，用于归还时重置对象状态
 * @param maxSize 池的最大容量，默认 100
 * @returns ObjectPool 接口实例（acquire、release、releaseAll）
 */
function createObjectPool<T>(
  factory: Factory<T>,
  reset: Reset<T>,
  maxSize: number = 100,
): ObjectPool<T> {
  // 闭包捕获的私有状态
  const pool: T[] = [];

  /**
   * 从池中获取一个对象
   * @returns 从池中获取的对象，池空时调用工厂函数创建新对象
   */
  function acquire(): T {
    if (pool.length > 0) {
      const pooled = pool.pop();
      if (pooled !== undefined) {
        return pooled;
      }
    }

    // 池为空，创建新对象
    return factory();
  }

  /**
   * 将对象归还到池中
   * @param obj - 待归还的对象，为 null/undefined 时忽略
   * @returns 无返回值
   */
  function release(obj: T | null | undefined): void {
    if (!obj || pool.length >= maxSize) {
      return;
    }

    pool.push(reset(obj));
  }

  /**
   * 批量释放对象数组
   * @param objects - 待释放的对象数组，为 null/undefined 或非数组时忽略
   * @returns 无返回值
   */
  function releaseAll(objects: ReadonlyArray<T> | null | undefined): void {
    if (!objects) {
      return;
    }

    for (const obj of objects) {
      release(obj);
    }
  }

  return {
    acquire,
    release,
    releaseAll,
  };
}

/**
 * 验证历史条目对象池
 * 用于 verificationHistory 数组中的条目对象
 */
const verificationEntryPool = createObjectPool<PoolableVerificationEntry>(
  () => ({ timestamp: null, indicators: null }),
  (obj) => {
    obj.timestamp = null;
    obj.indicators = null; // 清空引用，避免内存泄漏
    return obj;
  },
  50, // 最大保存50个对象（延迟验证仅使用3个时间点，容量按并发信号预估）
);

/**
 * 指标记录对象池（字符串键）
 * 用于延迟验证的指标快照对象复用
 * 主要用于：
 * - core/strategy/index.ts 中的 indicators1
 * - verificationHistory entry.indicators
 *
 * 注意：此对象池需要在 signalObjectPool 之前定义，因为 signalObjectPool 的重置函数需要使用它
 */
export const indicatorRecordPool = createObjectPool<Record<string, number>>(
  () => ({}),
  resetRecordObject,
  100, // 最大保存100个对象
);

/**
 * 交易信号对象池
 * 用于所有类型的交易信号对象（买入、卖出、清仓等）
 *
 * 注意：acquire() 返回 PoolableSignal，使用时需要断言为 Signal 类型
 * 这是对象池模式的标准实现，类型断言在此场景下是安全的
 */
export const signalObjectPool = createObjectPool<PoolableSignal>(
  () => ({
    symbol: null,
    symbolName: null,
    action: null,
    reason: null,
    orderTypeOverride: null,
    isProtectiveLiquidation: null,
    price: null,
    lotSize: null,
    quantity: null,
    seatVersion: null,
    triggerTime: null,
    indicators1: null,
    verificationHistory: null,
    relatedBuyOrderIds: null,
  }),

  // 重置函数：清空所有属性
  // 注意：需要释放 indicators1 和 verificationHistory 中的对象，避免内存泄漏
  (obj) => {
    // 释放 indicators1 到 indicatorRecordPool（如果存在）
    if (obj.indicators1) {
      indicatorRecordPool.release(obj.indicators1);
    }

    // 释放 verificationHistory 中每个 entry 的 indicators 对象和 entry 本身
    if (obj.verificationHistory) {
      for (const entry of obj.verificationHistory) {
        // 先释放 entry 中的 indicators 对象
        if (entry.indicators) {
          indicatorRecordPool.release(entry.indicators);
        }

        // 再释放 entry 本身
        verificationEntryPool.release(entry);
      }
    }

    obj.symbol = null;
    obj.symbolName = null;
    obj.action = null;
    obj.reason = null;
    obj.orderTypeOverride = null;
    obj.isProtectiveLiquidation = null;
    obj.price = null;
    obj.lotSize = null;
    obj.quantity = null;
    obj.seatVersion = null;
    obj.triggerTime = null;
    obj.indicators1 = null;
    obj.verificationHistory = null;
    obj.relatedBuyOrderIds = null;
    return obj;
  },
  100, // 最大保存100个信号对象
);

/**
 * 从对象池获取一个可写的 Signal 结构。
 *
 * 重要说明：
 * - 对象池内部使用可空字段（PoolableSignal）以便 reset；
 * - 调用方必须在使用前完整填充 `symbol`、`action` 等必填字段。
 *
 * @returns 可复用的 Signal 对象（调用方负责填充必填字段）
 */
export function acquireSignal(): Signal {
  return signalObjectPool.acquire() as unknown as Signal;
}

/**
 * KDJ指标对象池
 * 用于KDJ指标数据对象的复用
 */
export const kdjObjectPool = createObjectPool<PoolableKDJ>(
  () => ({
    k: null,
    d: null,
    j: null,
  }),
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
  () => ({
    macd: null,
    dif: null,
    dea: null,
  }),
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
 *
 * 注意：acquire() 返回 PoolableMonitorValues，使用时需要断言为 MonitorValues 类型
 * 这是对象池模式的标准实现，类型断言在此场景下是安全的
 */
export const monitorValuesObjectPool = createObjectPool<PoolableMonitorValues>(
  () => ({
    price: null,
    changePercent: null,
    ema: null,
    rsi: null,
    psy: null,
    mfi: null,
    kdj: null,
    macd: null,
    adx: null,
  }),
  (obj) => {
    obj.price = null;
    obj.changePercent = null;
    obj.ema = null;
    obj.rsi = null;
    obj.psy = null;
    obj.mfi = null;
    obj.kdj = null;
    obj.macd = null;
    obj.adx = null;
    return obj;
  },
  20, // 最大保存20个监控值对象
);

/**
 * 从对象池获取一个可写的 MonitorValues 结构。
 * @returns 可复用的 MonitorValues 对象（字段默认为 null）
 */
export function acquireMonitorValues(): MonitorValues {
  return monitorValuesObjectPool.acquire() as unknown as MonitorValues;
}

/**
 * 持仓对象池
 * 用于持仓数据对象的复用
 *
 * 注意：acquire() 返回 PoolablePosition，使用时需要断言为 Position 类型
 * 这是对象池模式的标准实现，类型断言在此场景下是安全的
 */
export const positionObjectPool = createObjectPool<PoolablePosition>(
  () => ({
    accountChannel: null,
    symbol: null,
    symbolName: null,
    quantity: 0,
    availableQuantity: 0,
    currency: null,
    costPrice: 0,
    market: null,
  }),
  (obj) => {
    obj.accountChannel = null;
    obj.symbol = null;
    obj.symbolName = null;
    obj.quantity = 0;
    obj.availableQuantity = 0;
    obj.currency = null;
    obj.costPrice = 0;
    obj.market = null;
    return obj;
  },
  10, // 通常不会有超过10个持仓
);

/**
 * 周期指标记录对象池（数字键）
 * 用于 rsi、ema 等 Record<number, number> 对象的复用
 * 主要用于：
 * - indicators/index.ts 中的 rsi、ema
 * - marketMonitor/index.ts 中的 EMA/RSI 浅拷贝
 */
export const periodRecordPool = createObjectPool<Record<number, number>>(
  () => ({}),
  resetRecordObject,
  100, // 最大保存100个对象
);
