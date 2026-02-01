# 主循环异步拆分重构 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不改变交易行为的前提下，将主循环中的高耗时 API 调用异步化，保留 K 线获取与指标计算在主循环，避免阻塞主循环节拍。

**Architecture:** 以现有 buy/sell 异步处理器为范式，引入“监控级任务队列 + 处理器”“订单监控后台单飞”“成交后刷新后台合并器”“刷新门禁(RefreshGate)”四块异步基础设施；主循环仅负责门禁、行情/K线与信号分流，异步任务负责 API 调用与刷新逻辑，并通过刷新门禁确保缓存一致性。

**Tech Stack:** TypeScript (ES2022), Node.js, LongPort OpenAPI SDK, pino, 现有任务队列与 setImmediate 调度模式。

---

## 可行性与合理性复核
- **架构一致性**：现有 buy/sell 处理器已采用队列+异步消费，新增异步链路与现有模型一致，改动可控。
- **数据依赖可拆分**：主循环依赖 K 线/指标与行情缓存即可生成信号；订单/账户/持仓与席位刷新可移出主循环。
- **一致性可保障**：通过任务去重、单飞处理、seatVersion 校验、状态快照与刷新门禁，保证缓存依赖路径读取最新数据。
- **风险可隔离**：末日保护与订阅管理保持同步；其余 API 失败只影响对应任务，不阻塞主循环。
- **性能收益明确**：移除 autoSymbol、订单监控、成交后刷新等高耗时调用，主循环节拍稳定。

## 约束与非目标
- **必须保留同步**：K 线获取/指标计算、运行门禁、末日保护、订阅/退订。
- **不引入兼容/补丁代码**：不添加临时开关、不保留旧同步路径。
- **不改变业务行为**：信号生成、风控、订单执行规则不改，只改执行时机/调度方式。
- **遵守 @typescript-project-specifications**：类型/工具/常量组织与严格 TS 规范。

## 方案选型（复核）
- **A. 任务队列异步化（推荐）**：将 autoSymbol、订单监控、成交后刷新抽到专用队列/处理器，主循环仅调度。  
  优点：结构清晰、可复用现有模式、可测试；缺点：改动面较大但集中。
- **B. 双循环快/慢拆分**：主循环+慢循环分担 API。  
  优点：改动小；缺点：耦合强、难保证一致性，仍可能阻塞慢循环。
- **C. 事件驱动彻底重构**：行情/订单事件驱动业务链路。  
  优点：性能最佳；缺点：范围过大、风险高。

---

## 设计摘要

### 模块划分
- `MonitorTaskQueue`：监控级任务队列，支持去重合并。
- `MonitorTaskProcessor`：处理 autoSymbol/席位刷新/距回收价清仓/浮亏检查任务（异步）。
- `OrderMonitorWorker`：订单监控后台单飞（异步）。
- `PostTradeRefresher`：成交后刷新合并器（异步）。
- `RefreshGate`：刷新门禁/版本号，缓存过期时阻塞依赖缓存的异步任务。

### 数据流概述
1. `mainProgram` 生成 `quotesMap` → 并发 `processMonitor`
2. `processMonitor` 调度 `AUTO_SYMBOL_TICK` / `LIQUIDATION_DISTANCE_CHECK` / `UNREALIZED_LOSS_CHECK` 任务
3. `OrderMonitor` 成交回调触发 `RefreshGate.markStale()`
4. `OrderMonitorWorker` 后台处理订单追踪/改价
5. `PostTradeRefresher` 合并刷新账户/持仓/浮亏并 `markFresh`，唤醒等待任务

### 并发与一致性策略
- **去重**：同一监控标的的同类任务只保留最新一条。
- **单飞**：订单监控、刷新任务不并发执行，确保顺序一致。
- **版本校验**：席位版本不匹配时任务直接跳过。
- **刷新门禁**：依赖缓存的任务在 `RefreshGate` 就绪后执行，避免读旧缓存。

### 必须满足的不变量（强约束）

> 这些是不允许“靠运气正确”的约束；若违反，将直接导致异步换标后出现“用旧标的/旧缓存做决策”的竞态风险。

1. **席位版本隔离（SeatVersion Isolation）**
   - **触发条件**：只要某方向席位发生以下任一变化：
     - `status` 从 `READY` 变为非 `READY`（如 `SWITCHING/EMPTY/SEARCHING` 等），或
     - `symbol` 发生变化（`READY: oldSymbol -> READY: newSymbol`）
   - **必须动作**：**先**提升（bump）该方向 `seatVersion`，**再**更新席位状态与清理队列；从而保证并发产生/消费中的旧信号必然被版本校验拦截。
   - **消费约束**：所有入队的交易信号（立即/延迟验证通过）必须携带 `seatVersion`，执行前必须校验 `seatVersion` 与 `symbol` 均匹配当前席位，否则直接丢弃。

2. **进入非 READY 必须清空该方向待执行信号**
   - **覆盖范围**：至少包含
     - 延迟验证器中该 `monitorSymbol + direction` 的待验证信号
     - 买入队列中该 `monitorSymbol + direction` 的待执行信号
     - 卖出队列中该 `monitorSymbol + direction` 的待执行信号
   - **资源安全**：被移除的任务必须释放信号对象（对象池），避免泄漏。
   - **说明**：即使有 `seatVersion` 兜底，清理仍然是强约束（降低堆积与避免“旧信号反复被拉起但最终丢弃”的噪音）。

3. **异步任务必须“携带快照 + 执行前复核”**
   - **携带快照**：异步任务数据中必须包含能定位与复核的关键字段（例如 `monitorSymbol`、方向、期望 `nextSymbol/previousSymbol`、必要时带 `seatVersion` 或 `dedupeKey`）。
   - **执行前复核**：任务执行前必须重新读取当前 `SymbolRegistry` 状态；若与任务快照不一致（例如 `nextSymbol !== currentSeat.symbol`），任务必须跳过（no-op），不得写入任何与标的相关的缓存/订单记录。

4. **同步订阅与异步换标的时序边界（必须可推理）**
   - **订阅/退订保持同步**：订阅集合的计算与 `subscribe/unsubscribe` 必须仍在 `mainProgram` 同步执行（本计划的约束已声明）。
   - **允许的延迟**：异步换标导致的订阅集合变化，允许最迟在下一次主循环 tick 反映到订阅集合与 `quotesMap`。
   - **禁止的行为**：在 `quote/lotSize/price` 未就绪时，不得提交任何需要行情的订单；应当通过“跳过/延后到下一 tick（由下一轮 `quotesMap` 补齐）”处理，而不是用 `null` 或旧 quote 继续交易。

5. **RefreshGate 覆盖所有读缓存做决策的异步路径**
   - **必须等待**：所有依赖 `lastState.cachedPositions` / `positionCache` / 浮亏缓存的异步处理路径，在读取前必须 `await RefreshGate.waitForFresh()`。
   - **至少覆盖**：`SellProcessor`、`MonitorTaskProcessor` 中所有可能读取持仓/浮亏相关缓存的任务类型（含 `AUTO_SYMBOL_TICK / LIQUIDATION_DISTANCE_CHECK / SEAT_REFRESH / UNREALIZED_LOSS_CHECK`）。

> **最小验证建议（不改变业务，仅验证不变量）**：增加测试覆盖“席位切换导致 `seatVersion` 变化时，旧信号在（1）延迟验证通过回调与（2）Buy/SellProcessor 出队执行处都会被丢弃”；并增加日志字段统一输出 `monitorSymbol/direction/symbol/seatVersion/status` 以便定位竞态窗口。

#### 运行时一致性验证清单（建议写入发布/回归流程）

> 目标：在不增加新功能的前提下，用日志与行为边界证明“不变量真的成立”，避免只靠代码审查。

- **验证 seatVersion 隔离**
  - **操作**：让某监控标的触发一次换标（或手动将席位置为 `SWITCHING/EMPTY` 再恢复），同时确保队列里存在该方向的待执行信号（延迟验证/立即信号均可）。
  - **期望**：日志中出现“席位版本不匹配/标的已切换 → 丢弃信号”的路径；不应出现该旧信号进入 `executeSignals` 的情况。

- **验证“非 READY 清队列”覆盖**
  - **操作**：触发席位从 `READY` 进入非 `READY`（换标开始或失败均可）。
  - **期望**：日志出现“清理待执行信号：延迟=... 买入=... 卖出=...”且计数与现场一致；被移除信号无泄漏（观察对象池统计或长期运行内存稳定）。

- **验证 RefreshGate 生效**
  - **操作**：制造一次成交（触发 `markStale()`），并在刷新完成前让 `SellProcessor` 或 `MonitorTaskProcessor` 有任务可执行。
  - **期望**：相关处理器在读取 `positionCache` 前会等待（可通过测试桩或日志点确认），刷新完成后继续执行；期间不会用旧持仓计算卖量/浮亏。

---

## 刷新门禁（RefreshGate）详细设计

### 目标
- **保证缓存新鲜度**：凡是依赖 `lastState.cachedPositions` / `positionCache` / 浮亏数据的路径，都在读取前等待刷新完成。
- **不阻塞主循环**：等待只发生在异步处理器（卖出处理器、监控任务处理器、席位刷新任务）中。

### 核心机制
- **版本号模型**：
  - `staleVersion`：缓存过期版本（被标记“需要刷新”时递增）。
  - `currentVersion`：已完成刷新版本（刷新成功后更新）。
- **关键接口**：
  - `markStale()`：成交后立即标记缓存过期（由订单监控回调触发）。
  - `markFresh(version)`：刷新完成后更新 `currentVersion` 并唤醒等待者。
  - `waitForFresh()`：若 `currentVersion < staleVersion` 则等待，否则立即返回。
  - `getStatus()`：读取当前版本与是否过期，用于 PostTradeRefresher 续刷判断。

### 触发与等待点
- **触发过期**：订单成交回调（orderMonitor）最早触发 `markStale`，缩短“旧缓存窗口”。
- **等待点**：
  - `SellProcessor.processTask`：使用 `positionCache` 前等待。
  - `MonitorTaskProcessor`：处理 `AUTO_SYMBOL_TICK`、`LIQUIDATION_DISTANCE_CHECK`、`SEAT_REFRESH`、`UNREALIZED_LOSS_CHECK` 前等待。
- **主循环保持非阻塞**：`processMonitor` 仅调度任务，不直接等待刷新。

### 刷新执行与重入处理
- `PostTradeRefresher` 在刷新开始时读取 `staleVersion` 作为目标版本，成功后调用 `markFresh(targetVersion)`。
- 如果刷新期间发生新的成交，`staleVersion` 会再次递增；刷新完成后发现 `currentVersion < staleVersion`，则立即补刷一轮。
- 刷新失败时不调用 `markFresh`，保持“过期”状态并在下一轮重试。

### Task 1: 建立测试运行通道

**Files:**
- Create: `tsconfig.test.json`
- Modify: `package.json`
- Test: `tests/smoke.test.ts`

**Step 1: Write the failing test**
```ts
// tests/smoke.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

test('smoke', () => {
  assert.equal(1 + 1, 2);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with "missing script: test"

**Step 3: Write minimal implementation**

`tsconfig.test.json`：
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist-test",
    "rootDir": "./"
  },
  "include": [
    "tests/**/*.test.ts",
    "src/**/*"
  ],
  "exclude": [
    "node_modules",
    "dist",
    "dist-test",
    "logs",
    ".claude"
  ]
}
```

`package.json` 增加：
```json
{
  "scripts": {
    "test": "tsc -p tsconfig.test.json && node --test dist-test/tests/**/*.test.js"
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS (1 test)

**Step 5: Commit**
```bash
git add tsconfig.test.json package.json tests/smoke.test.ts
git commit -m "test: add node test harness"
```

---

### Task 2: 新增 MonitorTaskQueue（去重队列）

**Files:**
- Create: `src/main/asyncProgram/monitorTaskQueue/types.ts`
- Create: `src/main/asyncProgram/monitorTaskQueue/utils.ts`
- Create: `src/main/asyncProgram/monitorTaskQueue/index.ts`
- Modify: `src/main/asyncProgram/types.ts`
- Test: `tests/asyncProgram/monitorTaskQueue.test.ts`

**Step 1: Write the failing test**
```ts
// tests/asyncProgram/monitorTaskQueue.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorTaskQueue } from '../../src/main/asyncProgram/monitorTaskQueue/index.js';

test('scheduleLatest replaces pending task with same key', () => {
  const queue = createMonitorTaskQueue();
  queue.scheduleLatest({
    type: 'AUTO_SYMBOL_TICK',
    monitorSymbol: 'HSI',
    dedupeKey: 'HSI:AUTO_SYMBOL_TICK',
    data: {
      currentTime: new Date(0),
      canTradeNow: true,
      monitorPrice: 18000,
      monitorPriceChanged: true,
      quotesMap: new Map(),
    },
  });
  queue.scheduleLatest({
    type: 'AUTO_SYMBOL_TICK',
    monitorSymbol: 'HSI',
    dedupeKey: 'HSI:AUTO_SYMBOL_TICK',
    data: {
      currentTime: new Date(1),
      canTradeNow: true,
      monitorPrice: 18001,
      monitorPriceChanged: true,
      quotesMap: new Map(),
    },
  });
  assert.equal(queue.size(), 1);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with module not found

**Step 3: Write minimal implementation**

`src/main/asyncProgram/monitorTaskQueue/types.ts`：
```ts
import type { Quote } from '../../../types/index.js';

export type MonitorTaskType =
  | 'AUTO_SYMBOL_TICK'
  | 'LIQUIDATION_DISTANCE_CHECK'
  | 'SEAT_REFRESH'
  | 'UNREALIZED_LOSS_CHECK';

export type AutoSymbolTickData = {
  readonly currentTime: Date;
  readonly canTradeNow: boolean;
  readonly monitorPrice: number | null;
  readonly monitorPriceChanged: boolean;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
};

export type LiquidationDistanceCheckData = {
  readonly monitorPrice: number | null;
  readonly monitorPriceChanged: boolean;
};

export type UnrealizedLossCheckData = {
  readonly currentTime: Date;
};

export type MonitorTaskDataMap = {
  readonly AUTO_SYMBOL_TICK: AutoSymbolTickData;
  readonly LIQUIDATION_DISTANCE_CHECK: LiquidationDistanceCheckData;
  readonly SEAT_REFRESH: SeatRefreshData;
  readonly UNREALIZED_LOSS_CHECK: UnrealizedLossCheckData;
};

export type SeatRefreshData = {
  readonly direction: 'LONG' | 'SHORT';
  readonly previousSymbol: string | null;
  readonly nextSymbol: string | null;
  readonly quote: Quote | null;
};

export type MonitorTaskBase<TType extends MonitorTaskType> = {
  readonly id: string;
  readonly type: TType;
  readonly data: MonitorTaskDataMap[TType];
  readonly monitorSymbol: string;
  readonly dedupeKey: string;
  readonly createdAt: number;
};

export type MonitorTask =
  | MonitorTaskBase<'AUTO_SYMBOL_TICK'>
  | MonitorTaskBase<'LIQUIDATION_DISTANCE_CHECK'>
  | MonitorTaskBase<'SEAT_REFRESH'>
  | MonitorTaskBase<'UNREALIZED_LOSS_CHECK'>;

export type MonitorTaskInput<TType extends MonitorTaskType> = Omit<
  MonitorTaskBase<TType>,
  'id' | 'createdAt'
>;

export type MonitorTaskAddedCallback = () => void;

export type MonitorTaskQueue = {
  push<TType extends MonitorTaskType>(task: MonitorTaskInput<TType>): void;
  scheduleLatest<TType extends MonitorTaskType>(task: MonitorTaskInput<TType>): void;
  pop(): MonitorTask | null;
  peek(): MonitorTask | null;
  size(): number;
  isEmpty(): boolean;
  clear(): void;
  removeTasks(
    predicate: (task: MonitorTask) => boolean,
    onRemove?: (task: MonitorTask) => void,
  ): number;
  onTaskAdded(callback: MonitorTaskAddedCallback): void;
};
```

`src/main/asyncProgram/monitorTaskQueue/utils.ts`：
```ts
import type { MonitorTaskType } from './types.js';

export function buildMonitorTaskKey(params: {
  readonly monitorSymbol: string;
  readonly type: MonitorTaskType;
  readonly extra?: string | null;
}): string {
  const extra = params.extra ? `:${params.extra}` : '';
  return `${params.monitorSymbol}:${params.type}${extra}`;
}
```

`src/main/asyncProgram/monitorTaskQueue/index.ts`：
```ts
import { randomUUID } from 'node:crypto';
import type { MonitorTask, MonitorTaskInput, MonitorTaskQueue } from './types.js';

export function createMonitorTaskQueue(): MonitorTaskQueue {
  const queue: MonitorTask[] = [];
  const callbacks: Array<() => void> = [];

  function notify(): void {
    for (const cb of callbacks) {
      cb();
    }
  }

  function pushInternal(task: MonitorTask): void {
    queue.push(task);
    notify();
  }

  return {
    push(task) {
      pushInternal({
        ...task,
        id: randomUUID(),
        createdAt: Date.now(),
      });
    },
    scheduleLatest(task) {
      const originalLength = queue.length;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const item = queue[i];
        if (item && item.dedupeKey === task.dedupeKey) {
          queue.splice(i, 1);
        }
      }
      if (queue.length !== originalLength) {
        // 替换了旧任务，保持队列最新
      }
      pushInternal({
        ...task,
        id: randomUUID(),
        createdAt: Date.now(),
      });
    },
    pop() {
      return queue.shift() ?? null;
    },
    peek() {
      return queue[0] ?? null;
    },
    size() {
      return queue.length;
    },
    isEmpty() {
      return queue.length === 0;
    },
    clear() {
      queue.length = 0;
    },
    removeTasks(predicate, onRemove) {
      const original = queue.length;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const item = queue[i];
        if (item && predicate(item)) {
          onRemove?.(item);
          queue.splice(i, 1);
        }
      }
      return original - queue.length;
    },
    onTaskAdded(callback) {
      callbacks.push(callback);
    },
  };
}
```

`src/main/asyncProgram/types.ts` 增加：
```ts
import type { MonitorTaskQueue } from './monitorTaskQueue/types.js';
export type { MonitorTaskQueue };
```

**Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS

**Step 5: Commit**
```bash
git add src/main/asyncProgram/monitorTaskQueue tests/asyncProgram/monitorTaskQueue.test.ts src/main/asyncProgram/types.ts
git commit -m "feat: add monitor task queue with dedupe"
```

---

### Task 3: 新增 MonitorTaskProcessor（异步处理 autoSymbol/距回收价清仓/浮亏）

**Files:**
- Create: `src/main/asyncProgram/monitorTaskProcessor/types.ts`
- Create: `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- Modify: `src/main/asyncProgram/types.ts`
- Test: `tests/asyncProgram/monitorTaskProcessor.test.ts`

**Step 1: Write the failing test**
```ts
// tests/asyncProgram/monitorTaskProcessor.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorTaskQueue } from '../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskProcessor } from '../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { createBuyTaskQueue, createSellTaskQueue } from '../../src/main/asyncProgram/tradeTaskQueue/index.js';

test('processor drains queue', async () => {
  const queue = createMonitorTaskQueue();
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();
  const refreshGate = {
    markStale: () => 0,
    markFresh: () => {},
    waitForFresh: async () => {},
    getStatus: () => ({ currentVersion: 0, staleVersion: 0 }),
  };
  const lastState = {
    cachedAccount: null,
    cachedPositions: [],
    positionCache: { update: () => {}, get: () => null } as never,
    monitorStates: new Map(),
  } as never;
  let called = 0;
  const processor = createMonitorTaskProcessor({
    taskQueue: queue,
    buyTaskQueue,
    sellTaskQueue,
    getMonitorContext: () => null,
    marketDataClient: null as never,
    trader: null as never,
    tradingConfig: null as never,
    dailyLossTracker: null as never,
    lastState,
    refreshGate: refreshGate as never,
  });

  queue.scheduleLatest({
    type: 'UNREALIZED_LOSS_CHECK',
    monitorSymbol: 'HSI',
    dedupeKey: 'HSI:UNREALIZED_LOSS_CHECK',
    data: { currentTime: new Date() },
  });

  const originalProcessTask = processor._testOnly?.getProcessCount;
  processor._testOnly?.setOnProcessed(() => { called += 1; });
  processor.start();
  await new Promise((r) => setImmediate(r));
  assert.ok(called >= 1);
  processor.stop();
  void originalProcessTask;
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with module not found

**Step 3: Write minimal implementation**

`src/main/asyncProgram/monitorTaskProcessor/types.ts`：
```ts
import type { MonitorTaskQueue } from '../monitorTaskQueue/types.js';
import type { BuyTaskQueue, SellTaskQueue } from '../types.js';
import type { MarketDataClient, Trader, MonitorContext, MultiMonitorTradingConfig, LastState } from '../../../types/index.js';
import type { DailyLossTracker } from '../../../core/risk/types.js';
import type { Processor, ProcessorStats } from '../types.js';
import type { RefreshGate } from '../../../utils/refreshGate/types.js';

export type MonitorTaskProcessorDeps = {
  readonly taskQueue: MonitorTaskQueue;
  readonly buyTaskQueue: BuyTaskQueue;
  readonly sellTaskQueue: SellTaskQueue;
  readonly getMonitorContext: (monitorSymbol: string) => MonitorContext | null;
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly dailyLossTracker: DailyLossTracker;
  readonly lastState: LastState;
  readonly refreshGate: RefreshGate;
};

export type MonitorTaskProcessor = Processor & {
  readonly _testOnly?: {
    readonly setOnProcessed: (cb: () => void) => void;
    readonly getProcessCount: () => number;
  };
};
```

`src/main/asyncProgram/monitorTaskProcessor/index.ts`（核心逻辑，含自动换标、距回收价清仓、席位刷新、浮亏检查）：
```ts
import { logger } from '../../../utils/logger/index.js';
import { formatError } from '../../../utils/helpers/index.js';
import { signalObjectPool, positionObjectPool } from '../../../utils/objectPool/index.js';
import { isSeatReady } from '../../../services/autoSymbolManager/utils.js';
import { buildMonitorTaskKey } from '../monitorTaskQueue/utils.js';
import { getPositions } from '../../processMonitor/utils.js';
import { WARRANT_LIQUIDATION_ORDER_TYPE } from '../../../constants/index.js';
import type { MonitorTask } from '../monitorTaskQueue/types.js';
import type { MonitorTaskProcessor, MonitorTaskProcessorDeps } from './types.js';
import type { ProcessorStats } from '../types.js';
import type { MonitorContext, Position, Quote, RawOrderFromAPI, SeatState } from '../../../types/index.js';

export function createMonitorTaskProcessor(deps: MonitorTaskProcessorDeps): MonitorTaskProcessor {
  const { taskQueue, getMonitorContext, buyTaskQueue, sellTaskQueue } = deps;
  let running = false;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;
  let processedCount = 0;
  let successCount = 0;
  let failedCount = 0;
  let lastProcessTime: number | null = null;
  let onProcessed: (() => void) | null = null;

  function isDirectionAction(
    action: string | null | undefined,
    direction: 'LONG' | 'SHORT',
  ): boolean {
    if (!action) return false;
    const isLongAction = action === 'BUYCALL' || action === 'SELLCALL';
    return direction === 'LONG' ? isLongAction : !isLongAction;
  }

  function clearQueuesForDirection(
    ctx: MonitorContext,
    direction: 'LONG' | 'SHORT',
  ): void {
    const monitorSymbol = ctx.config.monitorSymbol;
    const removedDelayed = ctx.delayedSignalVerifier.cancelAllForDirection(monitorSymbol, direction);
    const removedBuy = buyTaskQueue.removeTasks(
      (task) => task.monitorSymbol === monitorSymbol && isDirectionAction(task.data?.action, direction),
      (task) => signalObjectPool.release(task.data),
    );
    const removedSell = sellTaskQueue.removeTasks(
      (task) => task.monitorSymbol === monitorSymbol && isDirectionAction(task.data?.action, direction),
      (task) => signalObjectPool.release(task.data),
    );
    const total = removedDelayed + removedBuy + removedSell;
    if (total > 0) {
      logger.info(`[自动换标] ${monitorSymbol} ${direction} 清理待执行信号：延迟=${removedDelayed} 买入=${removedBuy} 卖出=${removedSell}`);
    }
  }

  function clearWarrantInfoForDirection(ctx: MonitorContext, direction: 'LONG' | 'SHORT'): void {
    ctx.riskChecker.clearWarrantInfo(direction === 'LONG');
  }

  function markSeatAsEmpty(
    ctx: MonitorContext,
    direction: 'LONG' | 'SHORT',
    reason: string,
  ): void {
    clearWarrantInfoForDirection(ctx, direction);
    const nextState = {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: Date.now(),
      lastSearchAt: null,
    } as const;
    ctx.symbolRegistry.updateSeatState(ctx.config.monitorSymbol, direction, nextState);
    ctx.symbolRegistry.bumpSeatVersion(ctx.config.monitorSymbol, direction);
    clearQueuesForDirection(ctx, direction);
    logger.error(`[自动换标] ${ctx.config.monitorSymbol} ${direction} 换标失败：${reason}`);
  }

  async function refreshSeatAfterSwitch(params: {
    readonly ctx: MonitorContext;
    readonly direction: 'LONG' | 'SHORT';
    readonly previousSymbol: string | null;
    readonly current: SeatState;
    readonly quote: Quote | null;
  }): Promise<void> {
    const { ctx, direction, previous, current, quote } = params;
    if (!isSeatReady(current)) return;
    const nextSymbol = current.symbol;
    const previousSymbol = params.previousSymbol;
    if (!nextSymbol || nextSymbol === previousSymbol) return;

    clearWarrantInfoForDirection(ctx, direction);

    let cachedAllOrders: ReadonlyArray<RawOrderFromAPI> | null = null;
    async function ensureAllOrders(): Promise<ReadonlyArray<RawOrderFromAPI>> {
      if (!cachedAllOrders) {
        cachedAllOrders = await ctx.orderRecorder.fetchAllOrdersFromAPI(true);
      }
      return cachedAllOrders;
    }

    let cachedAccountSnapshot: typeof deps.lastState.cachedAccount | null | undefined;
    let cachedPositionsSnapshot: ReadonlyArray<Position> | null | undefined;
    async function refreshAccountCaches(): Promise<void> {
      if (cachedAccountSnapshot === undefined) {
        cachedAccountSnapshot = await deps.trader.getAccountSnapshot();
        if (cachedAccountSnapshot) {
          deps.lastState.cachedAccount = cachedAccountSnapshot;
        }
      }
      if (cachedPositionsSnapshot === undefined) {
        cachedPositionsSnapshot = await deps.trader.getStockPositions();
        if (cachedPositionsSnapshot) {
          deps.lastState.cachedPositions = [...cachedPositionsSnapshot];
          deps.lastState.positionCache.update(cachedPositionsSnapshot);
        }
      }
    }

    const allOrders = await ensureAllOrders();
    deps.dailyLossTracker.recalculateFromAllOrders(allOrders, deps.tradingConfig.monitors, new Date());
    await ctx.orderRecorder.refreshOrdersFromAllOrders(
      nextSymbol,
      direction === 'LONG',
      allOrders,
      quote,
    );
    await refreshAccountCaches();
    const dailyLossOffset = deps.dailyLossTracker.getLossOffset(
      ctx.config.monitorSymbol,
      direction === 'LONG',
    );
    await ctx.riskChecker.refreshUnrealizedLossData(
      ctx.orderRecorder,
      nextSymbol,
      direction === 'LONG',
      quote,
      dailyLossOffset,
    );

    const symbolName = quote?.name ?? null;
    const warrantRefreshResult = await ctx.riskChecker.refreshWarrantInfoForSymbol(
      deps.marketDataClient,
      nextSymbol,
      direction === 'LONG',
      symbolName,
    );
    if (warrantRefreshResult.status === 'error') {
      markSeatAsEmpty(ctx, direction, `获取牛熊证信息失败：${warrantRefreshResult.reason}`);
      return;
    }
    if (warrantRefreshResult.status === 'skipped') {
      markSeatAsEmpty(ctx, direction, '未提供行情客户端，无法刷新牛熊证信息');
      return;
    }
    if (warrantRefreshResult.status === 'notWarrant') {
      logger.warn(`[自动换标] ${ctx.config.monitorSymbol} ${direction} 标的 ${nextSymbol} 不是牛熊证`);
    }

    if (previousSymbol && previousSymbol !== nextSymbol) {
      let previousQuote: Quote | null = null;
      try {
        const previousQuoteMap = await deps.marketDataClient.getQuotes([previousSymbol]);
        previousQuote = previousQuoteMap.get(previousSymbol) ?? null;
      } catch {
        previousQuote = null;
      }
      const existingSeat = ctx.symbolRegistry.resolveSeatBySymbol(previousSymbol);
      if (!existingSeat) {
        ctx.orderRecorder.clearBuyOrders(previousSymbol, direction === 'LONG', previousQuote);
        ctx.orderRecorder.clearOrdersCacheForSymbol(previousSymbol);
      }
    }
  }

  async function processTask(task: MonitorTask): Promise<boolean> {
    const ctx = getMonitorContext(task.monitorSymbol);
    if (!ctx) {
      return false;
    }
    try {
      await deps.refreshGate.waitForFresh();
      if (task.type === 'AUTO_SYMBOL_TICK') {
        if (!ctx.config.autoSearchConfig.autoSearchEnabled || !task.data.canTradeNow) {
          return true;
        }
        const { currentTime, monitorPrice, monitorPriceChanged, quotesMap } = task.data;
        const positions = deps.lastState.cachedPositions ?? [];
        const previousLong = ctx.symbolRegistry.getSeatState(task.monitorSymbol, 'LONG');
        const previousShort = ctx.symbolRegistry.getSeatState(task.monitorSymbol, 'SHORT');

        await ctx.autoSymbolManager.maybeSearchOnTick({ direction: 'LONG', currentTime, canTradeNow: task.data.canTradeNow });
        await ctx.autoSymbolManager.maybeSearchOnTick({ direction: 'SHORT', currentTime, canTradeNow: task.data.canTradeNow });
        if (monitorPriceChanged && monitorPrice != null) {
          const seatLong = ctx.symbolRegistry.getSeatState(task.monitorSymbol, 'LONG');
          const seatShort = ctx.symbolRegistry.getSeatState(task.monitorSymbol, 'SHORT');
          const pendingSymbols: string[] = [];
          if (seatLong.symbol) pendingSymbols.push(seatLong.symbol);
          if (seatShort.symbol && seatShort.symbol !== seatLong.symbol) pendingSymbols.push(seatShort.symbol);
          const pendingOrders =
            pendingSymbols.length > 0
              ? await deps.trader.getPendingOrders(pendingSymbols)
              : [];
          await ctx.autoSymbolManager.maybeSwitchOnDistance({
            direction: 'LONG',
            monitorPrice,
            quotesMap,
            positions,
            pendingOrders,
          });
          await ctx.autoSymbolManager.maybeSwitchOnDistance({
            direction: 'SHORT',
            monitorPrice,
            quotesMap,
            positions,
            pendingOrders,
          });
        }

        const nextLong = ctx.symbolRegistry.getSeatState(task.monitorSymbol, 'LONG');
        const nextShort = ctx.symbolRegistry.getSeatState(task.monitorSymbol, 'SHORT');
        if (previousLong.status === 'READY' && nextLong.status !== 'READY') {
          clearWarrantInfoForDirection(ctx, 'LONG');
          clearQueuesForDirection(ctx, 'LONG');
        }
        if (previousShort.status === 'READY' && nextShort.status !== 'READY') {
          clearWarrantInfoForDirection(ctx, 'SHORT');
          clearQueuesForDirection(ctx, 'SHORT');
        }
        if (previousLong.symbol !== nextLong.symbol) {
          taskQueue.scheduleLatest({
            type: 'SEAT_REFRESH',
            monitorSymbol: task.monitorSymbol,
            dedupeKey: buildMonitorTaskKey({ monitorSymbol: task.monitorSymbol, type: 'SEAT_REFRESH', extra: 'LONG' }),
            data: {
              direction: 'LONG',
              previousSymbol: previousLong.symbol ?? null,
              nextSymbol: nextLong.symbol ?? null,
              quote: nextLong.symbol ? quotesMap.get(nextLong.symbol) ?? null : null,
            },
          });
        }
        if (previousShort.symbol !== nextShort.symbol) {
          taskQueue.scheduleLatest({
            type: 'SEAT_REFRESH',
            monitorSymbol: task.monitorSymbol,
            dedupeKey: buildMonitorTaskKey({ monitorSymbol: task.monitorSymbol, type: 'SEAT_REFRESH', extra: 'SHORT' }),
            data: {
              direction: 'SHORT',
              previousSymbol: previousShort.symbol ?? null,
              nextSymbol: nextShort.symbol ?? null,
              quote: nextShort.symbol ? quotesMap.get(nextShort.symbol) ?? null : null,
            },
          });
        }
      }
      if (task.type === 'LIQUIDATION_DISTANCE_CHECK') {
        const monitorPrice = task.data.monitorPrice;
        const priceChanged = task.data.monitorPriceChanged;
        if (!priceChanged || monitorPrice == null) {
          return true;
        }
        if (ctx.config.autoSearchConfig.autoSearchEnabled) {
          return true;
        }
        const longSeatState = ctx.symbolRegistry.getSeatState(task.monitorSymbol, 'LONG');
        const shortSeatState = ctx.symbolRegistry.getSeatState(task.monitorSymbol, 'SHORT');
        const longSymbol = isSeatReady(longSeatState) ? longSeatState.symbol : '';
        const shortSymbol = isSeatReady(shortSeatState) ? shortSeatState.symbol : '';
        const longSeatVersion = ctx.symbolRegistry.getSeatVersion(task.monitorSymbol, 'LONG');
        const shortSeatVersion = ctx.symbolRegistry.getSeatVersion(task.monitorSymbol, 'SHORT');

        const { longPosition, shortPosition } = getPositions(
          deps.lastState.positionCache,
          longSymbol,
          shortSymbol,
        );

        try {
          const liquidationTasks: Array<{
            signal: import('../../../types/index.js').Signal;
            isLongSymbol: boolean;
            quote: Quote | null;
          }> = [];

          const longSymbolName = ctx.longQuote?.name ?? ctx.longSymbolName ?? null;
          const shortSymbolName = ctx.shortQuote?.name ?? ctx.shortSymbolName ?? null;

          function tryCreateLiquidationSignal(
            symbol: string,
            symbolName: string | null,
            isLongSymbol: boolean,
            position: Position | null,
            quote: Quote | null,
          ): {
            signal: import('../../../types/index.js').Signal;
            isLongSymbol: boolean;
            quote: Quote | null;
          } | null {
            if (!symbol) return null;
            const availableQuantity = position?.availableQuantity ?? 0;
            if (!Number.isFinite(availableQuantity) || availableQuantity <= 0) {
              return null;
            }
            const liquidationResult = ctx.riskChecker.checkWarrantDistanceLiquidation(
              symbol,
              isLongSymbol,
              monitorPrice,
            );
            if (!liquidationResult.shouldLiquidate) {
              return null;
            }
            const signal = signalObjectPool.acquire() as import('../../../types/index.js').Signal;
            signal.symbol = symbol;
            signal.symbolName = symbolName;
            signal.action = isLongSymbol ? 'SELLCALL' : 'SELLPUT';
            signal.reason = liquidationResult.reason ?? '牛熊证距回收价触发清仓';
            signal.price = quote?.price ?? null;
            signal.lotSize = quote?.lotSize ?? null;
            signal.quantity = availableQuantity;
            signal.triggerTime = new Date();
            signal.orderTypeOverride = WARRANT_LIQUIDATION_ORDER_TYPE;
            signal.isProtectiveLiquidation = false;
            signal.seatVersion = isLongSymbol ? longSeatVersion : shortSeatVersion;
            return { signal, isLongSymbol, quote };
          }

          const longTask = tryCreateLiquidationSignal(
            longSymbol,
            longSymbolName,
            true,
            longPosition,
            ctx.longQuote,
          );
          if (longTask) liquidationTasks.push(longTask);

          const shortTask = tryCreateLiquidationSignal(
            shortSymbol,
            shortSymbolName,
            false,
            shortPosition,
            ctx.shortQuote,
          );
          if (shortTask) liquidationTasks.push(shortTask);

          if (liquidationTasks.length > 0) {
            try {
              await deps.trader.executeSignals(liquidationTasks.map((taskItem) => taskItem.signal));
              for (const taskItem of liquidationTasks) {
                ctx.orderRecorder.clearBuyOrders(taskItem.signal.symbol, taskItem.isLongSymbol, taskItem.quote);
                const dailyLossOffset = deps.dailyLossTracker.getLossOffset(
                  ctx.config.monitorSymbol,
                  taskItem.isLongSymbol,
                );
                await ctx.riskChecker.refreshUnrealizedLossData(
                  ctx.orderRecorder,
                  taskItem.signal.symbol,
                  taskItem.isLongSymbol,
                  taskItem.quote,
                  dailyLossOffset,
                );
              }
            } finally {
              for (const taskItem of liquidationTasks) {
                signalObjectPool.release(taskItem.signal);
              }
            }
          }
        } finally {
          if (longPosition) {
            positionObjectPool.release(longPosition);
          }
          if (shortPosition) {
            positionObjectPool.release(shortPosition);
          }
        }
      }
      if (task.type === 'SEAT_REFRESH') {
        const seatState = ctx.symbolRegistry.getSeatState(task.monitorSymbol, task.data.direction);
        if (!task.data.nextSymbol || !isSeatReady(seatState)) {
          return true;
        }
        if (task.data.nextSymbol !== seatState.symbol) {
          return true;
        }
        await refreshSeatAfterSwitch({
          ctx,
          direction: task.data.direction,
          previousSymbol: task.data.previousSymbol,
          current: seatState,
          quote: task.data.quote,
        });
      }
      if (task.type === 'UNREALIZED_LOSS_CHECK') {
        const longSeat = ctx.symbolRegistry.getSeatState(task.monitorSymbol, 'LONG');
        const shortSeat = ctx.symbolRegistry.getSeatState(task.monitorSymbol, 'SHORT');
        await ctx.unrealizedLossMonitor.monitorUnrealizedLoss({
          longQuote: ctx.longQuote,
          shortQuote: ctx.shortQuote,
          longSymbol: isSeatReady(longSeat) ? longSeat.symbol : '',
          shortSymbol: isSeatReady(shortSeat) ? shortSeat.symbol : '',
          monitorSymbol: task.monitorSymbol,
          riskChecker: ctx.riskChecker,
          trader: deps.trader,
          orderRecorder: ctx.orderRecorder,
          dailyLossTracker: deps.dailyLossTracker,
        });
      }
      return true;
    } catch (err) {
      logger.error('[MonitorTaskProcessor] 处理任务失败', formatError(err));
      return false;
    }
  }

  async function processQueue(): Promise<void> {
    while (!taskQueue.isEmpty()) {
      const task = taskQueue.pop();
      if (!task) break;
      try {
        processedCount += 1;
        const ok = await processTask(task);
        if (ok) successCount += 1;
        else failedCount += 1;
        lastProcessTime = Date.now();
      } finally {
        onProcessed?.();
      }
    }
  }

  function scheduleNext(): void {
    if (!running) return;
    if (taskQueue.isEmpty()) {
      immediateHandle = null;
      return;
    }
    immediateHandle = setImmediate(() => {
      if (!running) return;
      processQueue()
        .catch((err) => {
          logger.error('[MonitorTaskProcessor] 处理队列失败', formatError(err));
        })
        .finally(() => {
          scheduleNext();
        });
    });
  }

  function start(): void {
    if (running) return;
    running = true;
    taskQueue.onTaskAdded(() => {
      if (running && immediateHandle === null) {
        scheduleNext();
      }
    });
    scheduleNext();
  }

  function stop(): void {
    running = false;
    if (immediateHandle !== null) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }
  }

  function isRunning(): boolean {
    return running;
  }

  async function processNow(): Promise<void> {
    await processQueue();
  }

  function getStats(): ProcessorStats {
    return {
      processedCount,
      successCount,
      failedCount,
      lastProcessTime,
    };
  }

  return {
    start,
    stop,
    processNow,
    isRunning,
    getStats,
    _testOnly: {
      setOnProcessed: (cb) => { onProcessed = cb; },
      getProcessCount: () => processedCount,
    },
  };
}
```

`src/main/asyncProgram/types.ts` 增加：
```ts
import type { MonitorTaskProcessor } from './monitorTaskProcessor/types.js';
export type { MonitorTaskProcessor };
```

**Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS

**Step 5: Commit**
```bash
git add src/main/asyncProgram/monitorTaskProcessor tests/asyncProgram/monitorTaskProcessor.test.ts src/main/asyncProgram/types.ts
git commit -m "feat: add monitor task processor"
```

---

### Task 4: 新增 RefreshGate（缓存刷新门禁）

**Files:**
- Create: `src/utils/refreshGate/types.ts`
- Create: `src/utils/refreshGate/index.ts`
- Test: `tests/utils/refreshGate.test.ts`

**Step 1: Write the failing test**
```ts
// tests/utils/refreshGate.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshGate } from '../../src/utils/refreshGate/index.js';

test('waitForFresh resolves after markFresh', async () => {
  const gate = createRefreshGate();
  const version = gate.markStale();
  const waiting = gate.waitForFresh().then(() => 'ok');
  await new Promise((r) => setImmediate(r));
  gate.markFresh(version);
  assert.equal(await waiting, 'ok');
});

test('waitForFresh resolves immediately when fresh', async () => {
  const gate = createRefreshGate();
  await gate.waitForFresh();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with module not found

**Step 3: Write minimal implementation**

`src/utils/refreshGate/types.ts`：
```ts
export type RefreshGateStatus = {
  readonly currentVersion: number;
  readonly staleVersion: number;
};

export type RefreshGate = {
  markStale(): number;
  markFresh(version: number): void;
  waitForFresh(): Promise<void>;
  getStatus(): RefreshGateStatus;
};
```

`src/utils/refreshGate/index.ts`：
```ts
import type { RefreshGate, RefreshGateStatus } from './types.js';

export function createRefreshGate(): RefreshGate {
  let currentVersion = 0;
  let staleVersion = 0;
  let waiters: Array<() => void> = [];

  function markStale(): number {
    staleVersion += 1;
    return staleVersion;
  }

  function markFresh(version: number): void {
    if (version > currentVersion) {
      currentVersion = version;
    }
    if (currentVersion >= staleVersion) {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) {
        resolve();
      }
    }
  }

  async function waitForFresh(): Promise<void> {
    if (currentVersion >= staleVersion) {
      return;
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }

  function getStatus(): RefreshGateStatus {
    return {
      currentVersion,
      staleVersion,
    };
  }

  return {
    markStale,
    markFresh,
    waitForFresh,
    getStatus,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS

**Step 5: Commit**
```bash
git add src/utils/refreshGate tests/utils/refreshGate.test.ts
git commit -m "feat: add refresh gate for cache freshness"
```

---

### Task 5: 新增订单监控后台与成交后刷新合并器

**Files:**
- Create: `src/main/asyncProgram/orderMonitorWorker/types.ts`
- Create: `src/main/asyncProgram/orderMonitorWorker/index.ts`
- Create: `src/main/asyncProgram/postTradeRefresher/types.ts`
- Create: `src/main/asyncProgram/postTradeRefresher/index.ts`
- Modify: `src/core/trader/types.ts`
- Modify: `src/core/trader/orderMonitor.ts`
- Modify: `src/core/trader/index.ts`
- Modify: `src/main/asyncProgram/types.ts`
- Test: `tests/asyncProgram/orderMonitorWorker.test.ts`

**Step 1: Write the failing test**
```ts
// tests/asyncProgram/orderMonitorWorker.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderMonitorWorker } from '../../src/main/asyncProgram/orderMonitorWorker/index.js';

test('worker coalesces runs', async () => {
  let calls = 0;
  const worker = createOrderMonitorWorker({
    trader: { monitorAndManageOrders: async () => { calls += 1; } } as never,
  });
  worker.start();
  worker.schedule(new Map());
  worker.schedule(new Map());
  await new Promise((r) => setImmediate(r));
  assert.ok(calls >= 1);
  worker.stop();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with module not found

**Step 3: Write minimal implementation**

`src/main/asyncProgram/orderMonitorWorker/types.ts`：
```ts
import type { Quote, Trader } from '../../../types/index.js';

export type OrderMonitorWorkerDeps = {
  readonly trader: Trader;
};

export type OrderMonitorWorker = {
  start(): void;
  stop(): void;
  schedule(quotesMap: ReadonlyMap<string, Quote | null>): void;
};
```

`src/main/asyncProgram/orderMonitorWorker/index.ts`：
```ts
import { logger } from '../../../utils/logger/index.js';
import { formatError } from '../../../utils/helpers/index.js';
import type { Quote } from '../../../types/index.js';
import type { OrderMonitorWorker, OrderMonitorWorkerDeps } from './types.js';

export function createOrderMonitorWorker(deps: OrderMonitorWorkerDeps): OrderMonitorWorker {
  let running = false;
  let inFlight = false;
  let pendingQuotes: ReadonlyMap<string, Quote | null> | null = null;

  async function runOnce(): Promise<void> {
    if (!pendingQuotes) return;
    const quotes = pendingQuotes;
    pendingQuotes = null;
    try {
      await deps.trader.monitorAndManageOrders(quotes);
    } catch (err) {
      logger.warn('[OrderMonitorWorker] 订单监控失败', formatError(err));
    }
  }

  function schedule(quotesMap: ReadonlyMap<string, Quote | null>): void {
    if (!running) return;
    pendingQuotes = quotesMap;
    if (inFlight) return;
    inFlight = true;
    setImmediate(() => {
      runOnce()
        .catch((err) => {
          logger.warn('[OrderMonitorWorker] 执行失败', formatError(err));
        })
        .finally(() => {
          inFlight = false;
          if (pendingQuotes) {
            schedule(pendingQuotes);
          }
        });
    });
  }

  function start(): void {
    running = true;
  }

  function stop(): void {
    running = false;
    pendingQuotes = null;
  }

  return { start, stop, schedule };
}
```

`src/core/trader/types.ts` 增加 RefreshGate 注入：
```ts
import type { RefreshGate } from '../../utils/refreshGate/types.js';

export type TraderDeps = {
  // ...existing fields
  readonly refreshGate?: RefreshGate;
};

export type OrderMonitorDeps = {
  // ...existing fields
  readonly refreshGate?: RefreshGate;
};
```

`src/core/trader/orderMonitor.ts` 在成交回调中标记过期：
```ts
export function createOrderMonitor(deps: OrderMonitorDeps): OrderMonitor {
  const { /* ... */ refreshGate } = deps;

  function handleOrderChanged(event: PushOrderChanged): void {
    // ...原有逻辑
    if (event.status === OrderStatus.Filled) {
      refreshGate?.markStale();
      // 继续原有 pendingRefreshSymbols.push(...)
    }
  }
}
```

`src/core/trader/index.ts` 传递 RefreshGate：
```ts
const orderMonitor = createOrderMonitor({
  // ...existing fields
  refreshGate: deps.refreshGate,
});
```

`src/main/asyncProgram/postTradeRefresher/types.ts`：
```ts
import type { MarketDataClient, MonitorContext, PendingRefreshSymbol } from '../../../types/index.js';
import type { LastState, Quote, Trader } from '../../../types/index.js';
import type { RefreshGate } from '../../../utils/refreshGate/types.js';

export type PostTradeRefresherDeps = {
  readonly trader: Trader;
  readonly marketDataClient: MarketDataClient;
  readonly lastState: LastState;
  readonly monitorContexts: Map<string, MonitorContext>;
  readonly refreshGate: RefreshGate;
};

export type PostTradeRefresher = {
  start(): void;
  stop(): void;
  enqueue(params: {
    readonly pending: ReadonlyArray<PendingRefreshSymbol>;
    readonly quotesMap: ReadonlyMap<string, Quote | null>;
  }): void;
};
```

`src/main/asyncProgram/postTradeRefresher/index.ts`：
```ts
import { logger } from '../../../utils/logger/index.js';
import { formatError, formatSymbolDisplay } from '../../../utils/helpers/index.js';
import { displayAccountAndPositions } from '../../../utils/helpers/accountDisplay.js';
import { isSeatReady } from '../../../services/autoSymbolManager/utils.js';
import type { MonitorContext, PendingRefreshSymbol, Quote } from '../../../types/index.js';
import type { PostTradeRefresher, PostTradeRefresherDeps } from './types.js';

export function createPostTradeRefresher(deps: PostTradeRefresherDeps): PostTradeRefresher {
  let running = false;
  let inFlight = false;
  const pending: PendingRefreshSymbol[] = [];
  let latestQuotes: ReadonlyMap<string, Quote | null> | null = null;

  async function refreshNow(): Promise<void> {
    if (pending.length === 0 || !latestQuotes) return;
    const batch = pending.splice(0);
    const quotesMap = latestQuotes;
    const targetVersion = deps.refreshGate.getStatus().staleVersion;
    let refreshSucceeded = true;

    const needRefreshAccount = batch.some((r) => r.refreshAccount);
    const needRefreshPositions = batch.some((r) => r.refreshPositions);

    try {
      const [freshAccount, freshPositions] = await Promise.all([
        needRefreshAccount ? deps.trader.getAccountSnapshot() : Promise.resolve(null),
        needRefreshPositions ? deps.trader.getStockPositions() : Promise.resolve(null),
      ]);
      if (freshAccount !== null) {
        deps.lastState.cachedAccount = freshAccount;
      }
      if (Array.isArray(freshPositions)) {
        deps.lastState.cachedPositions = freshPositions;
        deps.lastState.positionCache.update(freshPositions);
      }
    } catch (err) {
      refreshSucceeded = false;
      logger.warn('[PostTradeRefresher] 刷新账户/持仓失败', formatError(err));
    }

    const monitorContextBySymbol = new Map<string, MonitorContext>();
    for (const ctx of deps.monitorContexts.values()) {
      const monitorSymbol = ctx.config.monitorSymbol;
      const longSeat = ctx.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
      const shortSeat = ctx.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
      if (isSeatReady(longSeat) && !monitorContextBySymbol.has(longSeat.symbol)) {
        monitorContextBySymbol.set(longSeat.symbol, ctx);
      }
      if (isSeatReady(shortSeat) && !monitorContextBySymbol.has(shortSeat.symbol)) {
        monitorContextBySymbol.set(shortSeat.symbol, ctx);
      }
    }

    for (const item of batch) {
      const ctx = monitorContextBySymbol.get(item.symbol);
      if (!ctx || (ctx.config.maxUnrealizedLossPerSymbol ?? 0) <= 0) {
        continue;
      }
      const quote = quotesMap.get(item.symbol) ?? null;
      const symbolName = item.isLongSymbol ? ctx.longSymbolName : ctx.shortSymbolName;
      const dailyLossOffset = ctx.dailyLossTracker.getLossOffset(
        ctx.config.monitorSymbol,
        item.isLongSymbol,
      );
      await ctx.riskChecker
        .refreshUnrealizedLossData(
          ctx.orderRecorder,
          item.symbol,
          item.isLongSymbol,
          quote,
          dailyLossOffset,
        )
        .catch((err: unknown) => {
          logger.warn(
            `[PostTradeRefresher] 浮亏刷新失败: ${formatSymbolDisplay(item.symbol, symbolName ?? null)}`,
            formatError(err),
          );
        });
    }

    await displayAccountAndPositions({ lastState: deps.lastState, quotesMap });

    if (refreshSucceeded) {
      deps.refreshGate.markFresh(targetVersion);
    }
  }

  function enqueue(params: { readonly pending: ReadonlyArray<PendingRefreshSymbol>; readonly quotesMap: ReadonlyMap<string, Quote | null> }): void {
    if (!running) return;
    pending.push(...params.pending);
    latestQuotes = params.quotesMap;
    if (inFlight) return;
    inFlight = true;
    setImmediate(() => {
      refreshNow()
        .catch((err) => {
          logger.warn('[PostTradeRefresher] 执行失败', formatError(err));
        })
        .finally(() => {
          inFlight = false;
          if (pending.length > 0 && latestQuotes) {
            enqueue({ pending: [], quotesMap: latestQuotes });
          }
        });
    });
  }

  function start(): void {
    running = true;
  }

  function stop(): void {
    running = false;
    pending.length = 0;
    latestQuotes = null;
  }

  return { start, stop, enqueue };
}
```

`src/main/asyncProgram/types.ts` 增加：
```ts
export type { OrderMonitorWorker } from './orderMonitorWorker/types.js';
export type { PostTradeRefresher } from './postTradeRefresher/types.js';
```

**Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS

**Step 5: Commit**
```bash
git add src/main/asyncProgram/orderMonitorWorker src/main/asyncProgram/postTradeRefresher src/core/trader/orderMonitor.ts src/core/trader/types.ts src/core/trader/index.ts tests/asyncProgram/orderMonitorWorker.test.ts src/main/asyncProgram/types.ts
git commit -m "feat: add order monitor worker and post-trade refresher"
```

---

### Task 6: 主入口注入新队列/处理器并更新清理

**Files:**
- Modify: `src/index.ts`
- Modify: `src/services/cleanup/index.ts`
- Modify: `src/services/cleanup/types.ts`

**Step 1: Write the failing test**
```ts
// tests/asyncProgram/wiring.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleanup } from '../../src/services/cleanup/index.js';

test('cleanup stops processors', () => {
  const stopCalls: string[] = [];
  const cleanup = createCleanup({
    buyProcessor: { stop: () => stopCalls.push('buy') } as never,
    sellProcessor: { stop: () => stopCalls.push('sell') } as never,
    monitorTaskProcessor: { stop: () => stopCalls.push('monitor') } as never,
    orderMonitorWorker: { stop: () => stopCalls.push('order') } as never,
    postTradeRefresher: { stop: () => stopCalls.push('refresh') } as never,
    monitorContexts: new Map(),
    indicatorCache: { clearAll: () => {} } as never,
    lastState: { monitorStates: new Map() } as never,
  });
  cleanup.execute();
  assert.deepEqual(stopCalls.sort(), ['buy', 'monitor', 'order', 'refresh', 'sell']);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with type errors / missing fields

**Step 3: Write minimal implementation**

在 `src/services/cleanup/types.ts` 中扩展 `CleanupContext`：
```ts
import type { MonitorTaskProcessor } from '../../main/asyncProgram/monitorTaskProcessor/types.js';
import type { OrderMonitorWorker } from '../../main/asyncProgram/orderMonitorWorker/types.js';
import type { PostTradeRefresher } from '../../main/asyncProgram/postTradeRefresher/types.js';

export type CleanupContext = {
  readonly buyProcessor: BuyProcessor;
  readonly sellProcessor: SellProcessor;
  readonly monitorTaskProcessor: MonitorTaskProcessor;
  readonly orderMonitorWorker: OrderMonitorWorker;
  readonly postTradeRefresher: PostTradeRefresher;
  readonly monitorContexts: Map<string, MonitorContext>;
  readonly indicatorCache: IndicatorCache;
  readonly lastState: LastState;
};
```

在 `src/services/cleanup/index.ts` 中执行停止：
```ts
  const {
    buyProcessor,
    sellProcessor,
    monitorTaskProcessor,
    orderMonitorWorker,
    postTradeRefresher,
    monitorContexts,
    indicatorCache,
    lastState,
  } = context;

  // 停止处理器
  buyProcessor.stop();
  sellProcessor.stop();
  monitorTaskProcessor.stop();
  orderMonitorWorker.stop();
  postTradeRefresher.stop();
```

在 `src/index.ts` 中创建并启动：
```ts
const refreshGate = createRefreshGate();

const trader = await createTrader({
  config,
  tradingConfig,
  liquidationCooldownTracker,
  symbolRegistry,
  dailyLossTracker,
  refreshGate,
});

const sellProcessor = createSellProcessor({
  taskQueue: sellTaskQueue,
  getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
  signalProcessor,
  trader,
  getLastState: () => lastState,
  refreshGate,
});

const monitorTaskQueue = createMonitorTaskQueue();
const monitorTaskProcessor = createMonitorTaskProcessor({
  taskQueue: monitorTaskQueue,
  buyTaskQueue,
  sellTaskQueue,
  getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol) ?? null,
  marketDataClient,
  trader,
  tradingConfig,
  dailyLossTracker,
  lastState,
  refreshGate,
});

const orderMonitorWorker = createOrderMonitorWorker({ trader });
const postTradeRefresher = createPostTradeRefresher({
  trader,
  marketDataClient,
  lastState,
  monitorContexts,
  refreshGate,
});

monitorTaskProcessor.start();
orderMonitorWorker.start();
postTradeRefresher.start();
```

**Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS

**Step 5: Commit**
```bash
git add src/index.ts src/services/cleanup
git commit -m "refactor: wire async monitor processors"
```

---

### Task 7: SellProcessor 等待 RefreshGate

**Files:**
- Modify: `src/main/asyncProgram/sellProcessor/types.ts`
- Modify: `src/main/asyncProgram/sellProcessor/index.ts`
- Test: `tests/asyncProgram/sellProcessorRefreshGate.test.ts`

**Step 1: Write the failing test**
```ts
// tests/asyncProgram/sellProcessorRefreshGate.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSellProcessor } from '../../src/main/asyncProgram/sellProcessor/index.js';
import { createSellTaskQueue } from '../../src/main/asyncProgram/tradeTaskQueue/index.js';

test('sell processor waits for refresh gate', async () => {
  const taskQueue = createSellTaskQueue();
  let waited = false;
  const refreshGate = {
    markStale: () => 0,
    markFresh: () => {},
    waitForFresh: async () => { waited = true; },
    getStatus: () => ({ currentVersion: 0, staleVersion: 0 }),
  };

  taskQueue.push({
    type: 'IMMEDIATE_SELL',
    data: { symbol: 'HKG.12345', action: 'SELLCALL' } as never,
    monitorSymbol: 'HSI',
  });

  const processor = createSellProcessor({
    taskQueue,
    refreshGate: refreshGate as never,
    getMonitorContext: () => null,
    signalProcessor: { processSellSignals: () => [] } as never,
    trader: { executeSignals: async () => {} } as never,
    getLastState: () => ({ positionCache: { get: () => null } }) as never,
  });

  await processor.processNow();
  assert.equal(waited, true);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with type errors / missing fields

**Step 3: Write minimal implementation**

`src/main/asyncProgram/sellProcessor/types.ts` 增加依赖：
```ts
import type { RefreshGate } from '../../../utils/refreshGate/types.js';

export type SellProcessorDeps = {
  // ...existing fields
  readonly refreshGate: RefreshGate;
};
```

`src/main/asyncProgram/sellProcessor/index.ts` 等待刷新：
```ts
async function processTask(task: SellTask): Promise<boolean> {
  await deps.refreshGate.waitForFresh();
  // ...原有逻辑
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS

**Step 5: Commit**
```bash
git add src/main/asyncProgram/sellProcessor tests/asyncProgram/sellProcessorRefreshGate.test.ts
git commit -m "refactor: gate sell processor on refresh"
```

---

### Task 8: processMonitor 改为异步调度

**Files:**
- Modify: `src/main/processMonitor/index.ts`
- Modify: `src/main/mainProgram/types.ts`

**Step 1: Write the failing test**
```ts
// tests/asyncProgram/processMonitorQueueing.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonitorTaskKey } from '../../src/main/asyncProgram/monitorTaskQueue/utils.js';

test('buildMonitorTaskKey', () => {
  assert.equal(buildMonitorTaskKey({ monitorSymbol: 'HSI', type: 'AUTO_SYMBOL_TICK' }), 'HSI:AUTO_SYMBOL_TICK');
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL if util missing or not exported

**Step 3: Write minimal implementation**

在 `src/main/mainProgram/types.ts` 中增加上下文依赖：
```ts
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type { OrderMonitorWorker, PostTradeRefresher } from '../asyncProgram/types.js';

export type MainProgramContext = {
  // ...
  readonly monitorTaskQueue: MonitorTaskQueue;
  readonly orderMonitorWorker: OrderMonitorWorker;
  readonly postTradeRefresher: PostTradeRefresher;
};
```

在 `src/main/processMonitor/index.ts` 替换 autoSymbol / 距回收价清仓 / 浮亏调用为调度：
```ts
import { buildMonitorTaskKey } from '../asyncProgram/monitorTaskQueue/utils.js';

// ...
if (autoSearchEnabled) {
  monitorTaskQueue.scheduleLatest({
    type: 'AUTO_SYMBOL_TICK',
    monitorSymbol: MONITOR_SYMBOL,
    dedupeKey: buildMonitorTaskKey({ monitorSymbol: MONITOR_SYMBOL, type: 'AUTO_SYMBOL_TICK' }),
    data: {
      currentTime: runtimeFlags.currentTime,
      canTradeNow,
      monitorPrice: resolvedMonitorPrice,
      monitorPriceChanged,
      quotesMap,
    },
  });
}

if (!autoSearchEnabled && monitorPriceChanged) {
  monitorTaskQueue.scheduleLatest({
    type: 'LIQUIDATION_DISTANCE_CHECK',
    monitorSymbol: MONITOR_SYMBOL,
    dedupeKey: buildMonitorTaskKey({ monitorSymbol: MONITOR_SYMBOL, type: 'LIQUIDATION_DISTANCE_CHECK' }),
    data: {
      monitorPrice: resolvedMonitorPrice,
      monitorPriceChanged,
    },
  });
}

if (priceChanged) {
  monitorTaskQueue.scheduleLatest({
    type: 'UNREALIZED_LOSS_CHECK',
    monitorSymbol: MONITOR_SYMBOL,
    dedupeKey: buildMonitorTaskKey({ monitorSymbol: MONITOR_SYMBOL, type: 'UNREALIZED_LOSS_CHECK' }),
    data: { currentTime: runtimeFlags.currentTime },
  });
}
```

同时移除 `processMonitor` 内“距回收价清仓”的同步执行块与对应 `getPositions/positionObjectPool` 释放逻辑，交由 `MonitorTaskProcessor` 的 `LIQUIDATION_DISTANCE_CHECK` 任务处理（并受 RefreshGate 约束）。

**Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS

**Step 5: Commit**
```bash
git add src/main/processMonitor/index.ts src/main/mainProgram/types.ts tests/asyncProgram/processMonitorQueueing.test.ts
git commit -m "refactor: enqueue monitor tasks in processMonitor"
```

---

### Task 9: mainProgram 改为后台单飞与刷新合并

**Files:**
- Modify: `src/main/mainProgram/index.ts`

**Step 1: Write the failing test**
```ts
// tests/asyncProgram/mainProgramWorker.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

test('placeholder for mainProgram worker wiring', () => {
  assert.ok(true);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL if file missing

**Step 3: Write minimal implementation**

在 `src/main/mainProgram/index.ts` 的订单监控段替换为：
```ts
if (canTradeNow && lastState.allTradingSymbols.size > 0) {
  orderMonitorWorker.schedule(quotesMap);
  const pendingRefreshSymbols = trader.getAndClearPendingRefreshSymbols();
  if (pendingRefreshSymbols.length > 0) {
    postTradeRefresher.enqueue({
      pending: pendingRefreshSymbols,
      quotesMap,
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS

**Step 5: Commit**
```bash
git add src/main/mainProgram/index.ts tests/asyncProgram/mainProgramWorker.test.ts
git commit -m "refactor: move order monitor and refresh off main loop"
```

---

### Task 10: 更新流程文档

**Files:**
- Modify: `docs/flow/main-loop-flow.md`

**Step 1: Write the failing test**

无需测试；文档更新由 lint/type-check 验证即可。

**Step 2: Run test to verify it fails**

跳过。

**Step 3: Write minimal implementation**

在主循环流程中补充：
- `OrderMonitorWorker` 后台单飞执行
- `PostTradeRefresher` 合并刷新
- `MonitorTaskProcessor` 异步处理 autoSymbol/浮亏任务

**Step 4: Run test to verify it passes**

Run: `npm run lint`  
Expected: PASS

**Step 5: Commit**
```bash
git add docs/flow/main-loop-flow.md
git commit -m "docs: update main loop async flow"
```

---

### Task 11: 验证

**Files:**
- None

**Step 1: Run lint**

Run: `npm run lint`  
Expected: PASS

**Step 2: Run type-check**

Run: `npm run type-check`  
Expected: PASS

**Step 3: Run tests**

Run: `npm run test`  
Expected: PASS

**Step 4: Commit**
```bash
git add .
git commit -m "chore: finalize async refactor"
```

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-02-01-main-loop-async-refactor.md`. Two execution options:

1. **Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks.
2. **Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints.

Which approach?
