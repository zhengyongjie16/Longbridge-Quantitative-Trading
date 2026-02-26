# 对象池模式

对象池是**唯一允许使用可变属性**的场景（`readonly` 规则的例外）。用于高频创建的短生命周期对象，减少 GC 压力。

---

## 1. 对象池类型定义

对象池类型使用**可变属性**和 **`| null` 标记**（区别于普通类型的 `readonly`）：

```typescript
// ⚠️ 例外：可变属性 + | null
type PoolableSignal = {
  symbol: string | null;
  action: 'BUY' | 'SELL' | null;
  price: number | null;
  timestamp: number | null;
  indicators: PoolableIndicators | null; // 嵌套对象
};

type PoolableIndicators = {
  rsi: number | null;
  macd: number | null;
  kdj: number | null;
};
```

---

## 2. 对象池实现

```typescript
type ObjectPool<T> = {
  acquire(): T;
  release(obj: T | null | undefined): void;
  size(): number;
  available(): number;
};

const createObjectPool = <T>(
  factory: () => T,
  reset: (obj: T) => T,
  maxSize: number = 100,
): ObjectPool<T> => {
  const pool: T[] = [];
  let totalCreated = 0;

  return {
    acquire: () => {
      if (pool.length > 0) return pool.pop()!;
      totalCreated++;
      return factory();
    },
    release: (obj) => {
      if (!obj || pool.length >= maxSize) return;
      pool.push(reset(obj));
    },
    size: () => totalCreated,
    available: () => pool.length,
  };
};
```

---

## 3. 嵌套对象的释放

重置函数中**必须递归释放嵌套对象**：

```typescript
const indicatorPool = createObjectPool<PoolableIndicators>(
  () => ({ rsi: null, macd: null, kdj: null }),
  (obj) => {
    obj.rsi = null;
    obj.macd = null;
    obj.kdj = null;
    return obj;
  },
);

const signalPool = createObjectPool<PoolableSignal>(
  () => ({ symbol: null, action: null, price: null, timestamp: null, indicators: null }),
  (obj) => {
    // ⚠️ 必须先释放嵌套对象
    if (obj.indicators) indicatorPool.release(obj.indicators);
    obj.symbol = null;
    obj.action = null;
    obj.price = null;
    obj.timestamp = null;
    obj.indicators = null;
    return obj;
  },
);
```

---

## 4. 使用规范

### ✅ 正确：使用完毕后释放

```typescript
const signal = signalPool.acquire();
signal.symbol = 'AAPL';
signal.action = 'BUY';
signal.price = 150.5;
// 使用完毕后必须释放
signalPool.release(signal);
```

### ✅ 正确：异步场景在 finally 中释放

```typescript
const signal = signalPool.acquire();
try {
  signal.symbol = 'AAPL';
  await processSignal(signal);
} finally {
  // 无论成功或失败都会释放
  signalPool.release(signal);
}
```

### ✅ 正确：批量处理后批量释放

```typescript
const signals: PoolableSignal[] = [];
try {
  for (let i = 0; i < 10; i++) {
    const signal = signalPool.acquire();
    signal.symbol = `STOCK${i}`;
    signals.push(signal);
  }
  // 批量处理...
} finally {
  signals.forEach((s) => signalPool.release(s));
}
```

### ❌ 错误：忘记释放

```typescript
const signal = signalPool.acquire();
signal.symbol = 'AAPL';
console.log(signal);
// ❌ 缺少 signalPool.release(signal)，导致内存泄漏
```

---

## 关键要点

- **唯一例外**：对象池类型使用可变属性（非 `readonly`）和 `| null`
- **必须释放**：使用完毕后必须调用 `release()`
- **嵌套释放**：重置函数中递归释放嵌套的池化对象
- **异常安全**：在 `finally` 块中释放
- **适用场景**：高频创建的短生命周期对象（交易信号、K线数据等）
