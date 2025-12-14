/**
 * 对象池模块 - 减少频繁的对象创建和垃圾回收
 * 用于复用高频创建的临时对象，提升内存效率
 */

/**
 * 通用对象池类
 */
class ObjectPool {
  constructor(factory = () => ({}), reset = (obj) => obj, maxSize = 100) {
    this.pool = [];
    this.factory = factory; // 对象工厂函数
    this.reset = reset; // 对象重置函数
    this.maxSize = maxSize; // 池最大容量
    this.createdCount = 0; // 创建的对象总数（用于统计）
    this.acquireCount = 0; // 获取次数
    this.releaseCount = 0; // 释放次数
  }

  /**
   * 从池中获取一个对象
   * @returns {Object} 可用的对象
   */
  acquire() {
    this.acquireCount++;
    if (this.pool.length > 0) {
      return this.pool.pop();
    }
    // 池为空，创建新对象
    this.createdCount++;
    return this.factory();
  }

  /**
   * 将对象归还到池中
   * @param {Object} obj 要归还的对象
   */
  release(obj) {
    if (!obj) return;

    this.releaseCount++;

    // 如果池已满，直接丢弃对象（让GC回收）
    if (this.pool.length >= this.maxSize) {
      return;
    }

    // 重置对象状态
    const resetObj = this.reset(obj);
    this.pool.push(resetObj);
  }

  /**
   * 批量释放对象数组
   * @param {Array} objects 对象数组
   */
  releaseAll(objects) {
    if (!Array.isArray(objects)) return;
    objects.forEach((obj) => this.release(obj));
  }

  /**
   * 获取池的统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      poolSize: this.pool.length,
      maxSize: this.maxSize,
      createdCount: this.createdCount,
      acquireCount: this.acquireCount,
      releaseCount: this.releaseCount,
      hitRate:
        this.acquireCount > 0
          ? ((this.acquireCount - this.createdCount) / this.acquireCount) * 100
          : 0,
    };
  }

  /**
   * 清空对象池
   */
  clear() {
    this.pool = [];
  }
}

/**
 * 验证历史条目对象池
 * 用于 verificationHistory 数组中的条目对象
 */
export const verificationEntryPool = new ObjectPool(
  // 工厂函数：创建空对象
  () => ({ timestamp: null, j: null, macd: null }),
  // 重置函数：清空所有属性
  (obj) => {
    obj.timestamp = null;
    obj.j = null;
    obj.macd = null;
    return obj;
  },
  50 // 最大保存50个对象（每个信号最多120个条目，通常不会同时存在这么多待验证信号）
);

/**
 * 信号对象池
 * 用于交易信号对象的复用
 */
export const signalObjectPool = new ObjectPool(
  // 工厂函数：创建空对象
  () => ({
    symbol: null,
    symbolName: null,
    action: null,
    reason: null,
    price: null,
    lotSize: null,
    signalTriggerTime: null,
    quantity: null,
  }),
  // 重置函数：清空所有属性
  (obj) => {
    obj.symbol = null;
    obj.symbolName = null;
    obj.action = null;
    obj.reason = null;
    obj.price = null;
    obj.lotSize = null;
    obj.signalTriggerTime = null;
    obj.quantity = null;
    return obj;
  },
  20 // 通常不会同时有超过20个信号
);

/**
 * 持仓对象池
 * 用于持仓数据对象的复用
 */
export const positionObjectPool = new ObjectPool(
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
  10 // 通常不会有超过10个持仓
);
