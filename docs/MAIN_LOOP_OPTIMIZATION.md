# 主循环非阻塞优化方案

## 概述

本文档描述将主循环中的 K 线获取和指标计算改为非阻塞模式的优化方案，解决多监控标的场景下主循环延迟累积问题。

**核心改动**：保持每秒执行一次的频率，但 K 线获取和指标计算改为"触发后不等待"模式，主循环不再阻塞等待计算完成。

---

## 1. 问题分析

### 1.1 当前架构

```
主循环 mainProgram (每秒)
    │
    ├─ 1. 交易日/时段检查
    ├─ 2. 末日保护检查
    ├─ 3. 批量获取行情（从缓存读取，无 HTTP）✅
    ├─ 4. 并发处理监控标的 ◀── 【性能瓶颈】
    │      │
    │      └─ processMonitor (每个标的)
    │           ├─ getCandlesticks()      ← HTTP 调用
    │           ├─ buildIndicatorSnapshot() ← CPU 密集型计算
    │           └─ 生成信号
    │
    └─ 5. 订单监控与缓存刷新
```

### 1.2 性能瓶颈

| 瓶颈点 | 问题 | 代码位置 |
|--------|------|----------|
| K 线获取 | 每秒每个监控标的都要 HTTP 调用 | `processMonitor/index.ts:110-112` |
| 指标计算 | CPU 密集型操作 | `processMonitor/index.ts:122-128` |
| **同步等待** | `Promise.allSettled` 等待所有标的处理完成 | `mainProgram/index.ts:233` |

**问题场景**：当监控多个标的且 K 线获取或指标计算总耗时超过 1 秒时，主循环会产生延迟累积。

### 1.3 为何不采用"价格变化触发"模式

经过分析，"价格变化触发 K 线获取和指标计算"的方案存在以下问题：

| 问题 | 说明 |
|------|------|
| WebSocket 推送频率高 | 恒生指数等活跃标的每秒可能有数十次推送 |
| K 线 API 会被限流 | LongPort 限制 1 秒内不超过 10 次调用 |
| 无效计算 | K 线是 1 分钟周期，1 秒内多次计算结果完全相同 |

**结论**：保持每秒执行一次的频率是正确的，问题的本质是**主循环被阻塞等待**。

---

## 2. 优化方案

### 2.1 核心思想

```
当前模式：主循环 → 触发计算 → 等待完成 → 下一秒
优化模式：主循环 → 触发计算（不等待）→ 下一秒
                      ↓
              后台异步完成 → 更新缓存 → 生成信号
```

### 2.2 架构设计

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           优化后的执行流程                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  T=0s     T=1s     T=2s     T=3s     T=4s                                   │
│    │       │        │        │        │                                     │
│    ▼       ▼        ▼        ▼        ▼                                     │
│  ┌───┐   ┌───┐    ┌───┐    ┌───┐    ┌───┐    ← 轻量主循环（每秒准时执行）   │
│  │ M │   │ M │    │ M │    │ M │    │ M │                                   │
│  └─┬─┘   └─┬─┘    └─┬─┘    └─┬─┘    └─┬─┘                                   │
│    │       │        │        │        │                                     │
│    │ 触发  │ 触发   │ 触发   │ 触发   │ 触发   ← 非阻塞（不等待）            │
│    ▼       ▼        ▼        ▼        ▼                                     │
│  ┌─────────────────────────────────────────┐                                │
│  │         后台计算任务（异步执行）          │                                │
│  │  T=0s 的计算 ─────────────────▶ 完成     │                                │
│  │        T=1s 的计算 ───────────▶ 完成     │                                │
│  │              T=2s 的计算 ─────▶ 完成     │                                │
│  └─────────────────────────────────────────┘                                │
│                                                                             │
│  计算完成后：更新 IndicatorCache → 生成信号 → 推入 TaskQueue                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 主循环职责变化

| 职责 | 当前 | 优化后 |
|------|------|--------|
| 行情读取 | ✅ 每秒读取缓存 | ✅ 保持不变 |
| 价格变化检测 | ✅ 同步执行 | ✅ 保持不变 |
| 浮亏监控 | ✅ 同步执行 | ✅ 保持不变 |
| 末日保护 | ✅ 同步执行 | ✅ 保持不变 |
| K 线获取 | ❌ 同步等待 | ✅ **非阻塞触发** |
| 指标计算 | ❌ 同步等待 | ✅ **非阻塞触发** |
| 信号生成 | ❌ 同步执行 | ✅ **计算完成后异步执行** |

---

## 3. 详细设计

### 3.1 新增模块：IndicatorWorker

创建 `src/main/asyncProgram/indicatorWorker/` 目录，包含以下文件：

```
src/main/asyncProgram/indicatorWorker/
├── index.ts      # 工厂函数和核心逻辑
├── types.ts      # 类型定义
└── utils.ts      # 辅助函数
```

#### 3.1.1 类型定义 (types.ts)

```typescript
import type { IndicatorSnapshot, Quote, MonitorContext } from '../../../types/index.js';
import type { IndicatorCache } from '../indicatorCache/types.js';

/**
 * 单个监控标的的计算状态
 */
export interface CalculationState {
  /** 是否正在计算 */
  isCalculating: boolean;
  /** 最近一次完成的指标快照 */
  lastSnapshot: IndicatorSnapshot | null;
  /** 最近一次计算完成时间（毫秒） */
  lastCalculationTime: number | null;
}

/**
 * IndicatorWorker 依赖
 */
export interface IndicatorWorkerDeps {
  /** 行情数据客户端 */
  marketDataClient: {
    getCandlesticks: (symbol: string, period: string, count: number) => Promise<unknown[]>;
  };
  /** 指标缓存 */
  indicatorCache: IndicatorCache;
  /** 买入任务队列 */
  buyTaskQueue: { push: (task: unknown) => void };
  /** 卖出任务队列 */
  sellTaskQueue: { push: (task: unknown) => void };
}

/**
 * IndicatorWorker 接口
 */
export interface IndicatorWorker {
  /**
   * 触发指标计算（非阻塞，立即返回）
   * @param monitorContext 监控上下文
   * @param quotesMap 行情数据
   */
  trigger(monitorContext: MonitorContext, quotesMap: ReadonlyMap<string, Quote | null>): void;

  /**
   * 获取指定标的的计算状态
   */
  getState(monitorSymbol: string): CalculationState | undefined;

  /**
   * 销毁 Worker，清理资源
   */
  destroy(): void;
}
```

#### 3.1.2 核心实现 (index.ts)

```typescript
import { buildIndicatorSnapshot } from '../../../services/indicators/index.js';
import { logger } from '../../../utils/logger/index.js';
import { formatError, formatSymbolDisplay, formatSignalLog } from '../../../utils/helpers/index.js';
import { signalObjectPool } from '../../../utils/objectPool/index.js';
import { TRADING, VALID_SIGNAL_ACTIONS } from '../../../constants/index.js';
import type { CandleData, Signal, MonitorContext, Quote } from '../../../types/index.js';
import type { IndicatorWorker, IndicatorWorkerDeps, CalculationState } from './types.js';

/**
 * 创建指标计算工作器
 */
export const createIndicatorWorker = (deps: IndicatorWorkerDeps): IndicatorWorker => {
  const { marketDataClient, indicatorCache, buyTaskQueue, sellTaskQueue } = deps;

  // 每个监控标的的计算状态
  const calculationStates = new Map<string, CalculationState>();

  /**
   * 获取或创建计算状态
   */
  const getOrCreateState = (monitorSymbol: string): CalculationState => {
    let state = calculationStates.get(monitorSymbol);
    if (!state) {
      state = {
        isCalculating: false,
        lastSnapshot: null,
        lastCalculationTime: null,
      };
      calculationStates.set(monitorSymbol, state);
    }
    return state;
  };

  /**
   * 执行指标计算和信号生成（异步）
   */
  const executeCalculation = async (
    monitorContext: MonitorContext,
    quotesMap: ReadonlyMap<string, Quote | null>,
  ): Promise<void> => {
    const { config, state: monitorState, strategy, orderRecorder } = monitorContext;
    const monitorSymbol = config.monitorSymbol;
    const { rsiPeriods, emaPeriods, psyPeriods } = monitorContext;

    try {
      // 1. 获取 K 线数据
      const monitorCandles = await marketDataClient
        .getCandlesticks(monitorSymbol, TRADING.CANDLE_PERIOD, TRADING.CANDLE_COUNT)
        .catch(() => null);

      if (!monitorCandles || monitorCandles.length === 0) {
        logger.warn(`[IndicatorWorker] 未获取到 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} K线数据`);
        return;
      }

      // 2. 计算技术指标
      const monitorSnapshot = buildIndicatorSnapshot(
        monitorSymbol,
        monitorCandles as CandleData[],
        rsiPeriods,
        emaPeriods,
        psyPeriods,
      );

      if (!monitorSnapshot) {
        logger.warn(`[IndicatorWorker] 无法构建 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} 指标快照`);
        return;
      }

      // 3. 存入 IndicatorCache（供延迟验证器查询）
      indicatorCache.push(monitorSymbol, monitorSnapshot);

      // 4. 更新计算状态
      const calcState = getOrCreateState(monitorSymbol);
      calcState.lastSnapshot = monitorSnapshot;
      calcState.lastCalculationTime = Date.now();

      // 5. 生成信号
      const { immediateSignals, delayedSignals } = strategy.generateCloseSignals(
        monitorSnapshot,
        config.longSymbol,
        config.shortSymbol,
        orderRecorder,
      );

      // 6. 补充信号信息并分发
      const longQuote = quotesMap.get(config.longSymbol) ?? null;
      const shortQuote = quotesMap.get(config.shortSymbol) ?? null;

      const enrichAndDispatch = (signal: Signal, isDelayed: boolean): void => {
        // 验证信号有效性
        if (!signal?.symbol || !signal?.action || !VALID_SIGNAL_ACTIONS.has(signal.action)) {
          signalObjectPool.release(signal);
          return;
        }

        // 补充信号信息
        if (signal.symbol === config.longSymbol && longQuote) {
          signal.symbolName ??= longQuote.name ?? null;
          signal.price ??= longQuote.price;
          signal.lotSize ??= longQuote.lotSize;
        } else if (signal.symbol === config.shortSymbol && shortQuote) {
          signal.symbolName ??= shortQuote.name ?? null;
          signal.price ??= shortQuote.price;
          signal.lotSize ??= shortQuote.lotSize;
        }

        const isSellSignal = signal.action === 'SELLCALL' || signal.action === 'SELLPUT';

        if (isDelayed) {
          // 延迟信号 → 延迟验证器
          logger.info(`[IndicatorWorker] 延迟验证信号: ${formatSignalLog(signal)}`);
          monitorContext.delayedSignalVerifier.addSignal(signal, monitorSymbol);
        } else {
          // 立即信号 → 任务队列
          logger.info(`[IndicatorWorker] 立即信号: ${formatSignalLog(signal)}`);
          if (isSellSignal) {
            sellTaskQueue.push({ type: 'IMMEDIATE_SELL', data: signal, monitorSymbol });
          } else {
            buyTaskQueue.push({ type: 'IMMEDIATE_BUY', data: signal, monitorSymbol });
          }
        }
      };

      for (const signal of immediateSignals) {
        enrichAndDispatch(signal, false);
      }
      for (const signal of delayedSignals) {
        enrichAndDispatch(signal, true);
      }

    } catch (err) {
      logger.error(`[IndicatorWorker] 计算失败: ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)}`, formatError(err));
    }
  };

  return {
    trigger(monitorContext: MonitorContext, quotesMap: ReadonlyMap<string, Quote | null>): void {
      const monitorSymbol = monitorContext.config.monitorSymbol;
      const state = getOrCreateState(monitorSymbol);

      // 防重入：正在计算中则跳过
      if (state.isCalculating) {
        logger.debug(`[IndicatorWorker] ${monitorSymbol} 正在计算中，跳过本次触发`);
        return;
      }

      // 标记开始计算
      state.isCalculating = true;

      // 非阻塞执行（不使用 await）
      executeCalculation(monitorContext, quotesMap)
        .catch((err) => {
          logger.error(`[IndicatorWorker] 异步计算异常: ${monitorSymbol}`, formatError(err));
        })
        .finally(() => {
          state.isCalculating = false;
        });
    },

    getState(monitorSymbol: string): CalculationState | undefined {
      return calculationStates.get(monitorSymbol);
    },

    destroy(): void {
      calculationStates.clear();
      logger.debug('[IndicatorWorker] 已销毁');
    },
  };
};
```

### 3.2 修改 processMonitor

将 `processMonitor` 改为轻量模式，只负责：
1. 价格变化检测
2. 浮亏监控
3. 触发 IndicatorWorker（不等待）

```typescript
// processMonitor/index.ts 改动要点

export async function processMonitor(
  context: ProcessMonitorParams,
  quotesMap: ReadonlyMap<string, Quote | null>,
): Promise<void> {
  const { monitorContext, context: mainContext, runtimeFlags } = context;
  const { indicatorWorker } = mainContext;  // 新增依赖

  // 1. 提取行情
  // ...（保持不变）

  // 2. 监控价格变化
  // ...（保持不变）

  // 3. 浮亏监控
  // ...（保持不变）

  // 4. 触发 IndicatorWorker（非阻塞）
  if (runtimeFlags.canTradeNow && !runtimeFlags.openProtectionActive) {
    indicatorWorker.trigger(monitorContext, quotesMap);
  }

  // 注意：不再在此处等待 K 线获取和指标计算
  // 信号生成已移至 IndicatorWorker 内部
}
```

### 3.3 修改 mainProgram

主循环不再等待 processMonitor 完成所有计算。

```typescript
// mainProgram/index.ts 改动要点

// 处理所有监控标的（非阻塞模式）
for (const [monitorSymbol, monitorContext] of monitorContexts) {
  // 同步执行轻量操作（价格检测、浮亏监控）
  // 触发 IndicatorWorker（非阻塞）
  processMonitor({ /* ... */ }, quotesMap);
}

// 不再使用 Promise.allSettled 等待
// await Promise.allSettled(monitorTasks);  // 删除
```

### 3.4 初始化 IndicatorWorker

在 `index.ts` 中初始化：

```typescript
// index.ts 改动要点

// 创建 IndicatorWorker
const indicatorWorker = createIndicatorWorker({
  marketDataClient,
  indicatorCache,
  buyTaskQueue,
  sellTaskQueue,
});

// 注入到 mainProgram 上下文
await mainProgram({
  // ...existing deps
  indicatorWorker,  // 新增
});

// 在 cleanup 中销毁
const cleanup = createCleanup({
  // ...existing deps
  indicatorWorker,  // 新增
});
```

---

## 4. 实施计划

### 4.1 改动文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/main/asyncProgram/indicatorWorker/index.ts` | **新增** | IndicatorWorker 实现 |
| `src/main/asyncProgram/indicatorWorker/types.ts` | **新增** | 类型定义 |
| `src/main/processMonitor/index.ts` | **修改** | 移除 K 线获取和指标计算 |
| `src/main/mainProgram/index.ts` | **修改** | 移除 Promise.allSettled 等待 |
| `src/main/mainProgram/types.ts` | **修改** | 添加 indicatorWorker 类型 |
| `src/index.ts` | **修改** | 初始化 IndicatorWorker |
| `src/services/cleanup/index.ts` | **修改** | 销毁 IndicatorWorker |

### 4.2 实施步骤

| 步骤 | 内容 | 风险 |
|------|------|------|
| Step 1 | 创建 `indicatorWorker` 模块（新增文件） | 低 |
| Step 2 | 修改 `index.ts` 初始化 IndicatorWorker | 低 |
| Step 3 | 修改 `processMonitor` 为触发模式 | 中 |
| Step 4 | 修改 `mainProgram` 移除等待 | 中 |
| Step 5 | 更新 `cleanup` 模块 | 低 |
| Step 6 | 集成测试 | - |

### 4.3 回滚方案

如需回滚，恢复以下文件到原始版本：
- `src/main/processMonitor/index.ts`
- `src/main/mainProgram/index.ts`
- `src/index.ts`

---

## 5. 预期效果

### 5.1 性能改进

| 指标 | 当前 | 优化后 |
|------|------|--------|
| 主循环执行间隔 | 可能 >1s（累积延迟） | 稳定 1s |
| 单次主循环耗时 | 100-500ms（取决于标的数量） | <50ms |
| 多标的可扩展性 | 受限 | 良好 |

### 5.2 行为变化

| 场景 | 当前行为 | 优化后行为 |
|------|----------|------------|
| 计算耗时长 | 主循环延迟 | 主循环不受影响 |
| 信号生成时机 | 同步生成 | 计算完成后异步生成 |
| 指标缓存更新 | 同步写入 | 异步写入（计算完成后） |

### 5.3 兼容性

| 功能 | 影响 |
|------|------|
| 延迟验证 | ✅ 无影响（IndicatorCache 异步更新兼容） |
| 风险检查 | ✅ 无影响（使用最新行情缓存） |
| 末日保护 | ✅ 无影响（主循环同步执行） |
| 浮亏监控 | ✅ 无影响（主循环同步执行） |

---

## 6. 不采用的方案

### 6.1 价格变化触发

**原因**：
- WebSocket 推送频率高（每秒数十次），会导致 K 线 API 限流
- K 线是 1 分钟周期，频繁获取是无效计算

### 6.2 Worker 线程（worker_threads）

**原因**：
- 实现复杂度高
- Node.js 单线程模型下异步已足够
- 收益有限（主要瓶颈是 HTTP 调用，非 CPU）

### 6.3 额外的信号时效性检查

**原因**：
- 计算耗时短（100-500ms）
- 风险检查时使用实时行情（每秒更新的缓存）
- 买入价格限制已覆盖追高场景

---

## 7. 注意事项

1. **对象池管理**：信号对象的生命周期管理移至 IndicatorWorker 内部
2. **日志格式**：新增 `[IndicatorWorker]` 前缀用于区分日志来源
3. **错误处理**：计算失败不影响主循环，仅记录日志
4. **状态隔离**：每个监控标的有独立的 `CalculationState`

---

## 8. 参考资料

- 当前主循环实现：`src/main/mainProgram/index.ts`
- 当前 processMonitor 实现：`src/main/processMonitor/index.ts`
- 指标计算模块：`src/services/indicators/index.ts`
- 指标缓存模块：`src/main/asyncProgram/indicatorCache/index.ts`
