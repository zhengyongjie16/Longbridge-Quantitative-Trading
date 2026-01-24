/**
 * 对象池模式示例
 *
 * 本示例展示对象池模式的实现，这是性能优化的必要例外：
 * 1. 对象池类型使用可变属性（而非 readonly）
 * 2. 使用 | null 标记可空属性
 * 3. 必须及时释放对象，避免内存泄漏
 * 4. 嵌套对象也需要递归释放
 *
 * ⚠️ 注意：对象池是唯一允许使用可变属性的场景！
 */

// ============================================================================
// 对象池类型定义（例外：使用可变属性）
// ============================================================================

/**
 * 可池化的信号对象
 * ⚠️ 例外：使用可变属性和 | null 标记
 */
export type PoolableSignal = {
  symbol: string | null;
  action: 'BUY' | 'SELL' | null;
  price: number | null;
  timestamp: number | null;
  indicators: PoolableIndicators | null; // 嵌套对象
};

/**
 * 可池化的指标对象
 * ⚠️ 例外：使用可变属性和 | null 标记
 */
export type PoolableIndicators = {
  rsi: number | null;
  macd: number | null;
  kdj: number | null;
};

/**
 * 对象池接口
 */
export type ObjectPool<T> = {
  acquire(): T;
  release(obj: T | null | undefined): void;
  size(): number;
  available(): number;
};

// ============================================================================
// 对象池实现
// ============================================================================

/**
 * 创建对象池的工厂函数
 *
 * @param factory - 创建新对象的工厂函数
 * @param reset - 重置对象状态的函数
 * @param maxSize - 池的最大容量
 */
export const createObjectPool = <T>(
  factory: () => T,
  reset: (obj: T) => T,
  maxSize: number = 100,
): ObjectPool<T> => {
  const pool: T[] = [];
  let totalCreated = 0;

  return {
    /**
     * 从池中获取对象
     * 如果池为空，创建新对象
     */
    acquire: () => {
      if (pool.length > 0) {
        return pool.pop()!;
      }
      totalCreated++;
      return factory();
    },

    /**
     * 释放对象回池中
     * 如果池已满或对象为空，则丢弃
     */
    release: (obj) => {
      if (!obj || pool.length >= maxSize) {
        return;
      }
      pool.push(reset(obj));
    },

    /**
     * 获取池的总容量
     */
    size: () => totalCreated,

    /**
     * 获取池中可用对象数量
     */
    available: () => pool.length,
  };
};

// ============================================================================
// 具体对象池实例
// ============================================================================

/**
 * 指标对象池
 */
export const indicatorPool = createObjectPool<PoolableIndicators>(
  // 工厂函数：创建新对象
  () => ({
    rsi: null,
    macd: null,
    kdj: null,
  }),
  // 重置函数：清空对象状态
  (obj) => {
    obj.rsi = null;
    obj.macd = null;
    obj.kdj = null;
    return obj;
  },
  50, // 最大容量
);

/**
 * 信号对象池
 */
export const signalPool = createObjectPool<PoolableSignal>(
  // 工厂函数：创建新对象
  () => ({
    symbol: null,
    action: null,
    price: null,
    timestamp: null,
    indicators: null,
  }),
  // 重置函数：清空对象状态并释放嵌套对象
  (obj) => {
    // ⚠️ 重要：释放嵌套对象
    if (obj.indicators) {
      indicatorPool.release(obj.indicators);
    }

    obj.symbol = null;
    obj.action = null;
    obj.price = null;
    obj.timestamp = null;
    obj.indicators = null;
    return obj;
  },
  100, // 最大容量
);

// ============================================================================
// 使用示例
// ============================================================================

/**
 * ✅ 正确示例：使用对象池
 */
export const correctUsageExample = () => {
  // 1. 从池中获取对象
  const signal = signalPool.acquire();
  const indicators = indicatorPool.acquire();

  // 2. 设置对象属性
  signal.symbol = 'AAPL';
  signal.action = 'BUY';
  signal.price = 150.5;
  signal.timestamp = Date.now();

  indicators.rsi = 65.5;
  indicators.macd = 0.5;
  indicators.kdj = 75.0;

  signal.indicators = indicators;

  // 3. 使用对象
  console.log('Signal:', signal);

  // 4. ⚠️ 重要：使用完毕后必须释放
  signalPool.release(signal);
  // 注意：不需要手动释放 indicators，signalPool.release 会自动处理
};

/**
 * ❌ 错误示例：忘记释放对象
 */
export const incorrectUsageExample = () => {
  const signal = signalPool.acquire();
  signal.symbol = 'AAPL';
  signal.action = 'BUY';

  // ❌ 错误：忘记释放对象
  // 这会导致内存泄漏，池中的对象越来越少
  console.log('Signal:', signal);
  // 缺少：signalPool.release(signal);
};

/**
 * ✅ 正确示例：在异步函数中使用对象池
 */
export const asyncUsageExample = async () => {
  const signal = signalPool.acquire();

  try {
    signal.symbol = 'AAPL';
    signal.action = 'BUY';
    signal.price = 150.5;

    // 模拟异步操作
    await processSignal(signal);

    console.log('Signal processed successfully');
  } catch (error) {
    console.error('Error processing signal:', error);
  } finally {
    // ⚠️ 重要：在 finally 块中释放，确保无论成功或失败都会释放
    signalPool.release(signal);
  }
};

/**
 * ✅ 正确示例：批量处理对象
 */
export const batchUsageExample = () => {
  const signals: PoolableSignal[] = [];

  try {
    // 1. 批量获取对象
    for (let i = 0; i < 10; i++) {
      const signal = signalPool.acquire();
      signal.symbol = `STOCK${i}`;
      signal.action = i % 2 === 0 ? 'BUY' : 'SELL';
      signal.price = 100 + i;
      signals.push(signal);
    }

    // 2. 批量处理
    signals.forEach((signal) => {
      console.log('Processing:', signal.symbol);
    });
  } finally {
    // 3. ⚠️ 重要：批量释放所有对象
    signals.forEach((signal) => signalPool.release(signal));
  }
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 模拟信号处理
 */
const processSignal = async (signal: PoolableSignal): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log('Processing signal:', signal.symbol);
      resolve();
    }, 100);
  });
};

/**
 * 获取对象池统计信息
 */
export const getPoolStats = () => {
  return {
    signal: {
      total: signalPool.size(),
      available: signalPool.available(),
      inUse: signalPool.size() - signalPool.available(),
    },
    indicator: {
      total: indicatorPool.size(),
      available: indicatorPool.available(),
      inUse: indicatorPool.size() - indicatorPool.available(),
    },
  };
};

// ============================================================================
// 关键要点
// ============================================================================

/**
 * 对象池模式的关键要点：
 *
 * 1. ⚠️ 唯一例外：对象池类型使用可变属性（非 readonly）
 * 2. ⚠️ 使用 | null 标记：所有属性都应该可以重置为 null
 * 3. ✅ 必须释放：使用完毕后必须调用 release()
 * 4. ✅ 嵌套释放：嵌套对象也需要递归释放
 * 5. ✅ 异常安全：在 finally 块中释放，确保异常时也能释放
 * 6. ✅ 批量处理：批量获取后要批量释放
 *
 * 为什么需要对象池：
 *
 * 1. 减少 GC 压力：避免频繁创建和销毁对象
 * 2. 提高性能：对象复用比创建新对象更快
 * 3. 内存稳定：避免内存抖动
 *
 * 何时使用对象池：
 *
 * 1. 高频创建的对象（如交易信号、K线数据）
 * 2. 对象创建成本较高
 * 3. 对象生命周期短暂
 * 4. 性能敏感的场景
 */
