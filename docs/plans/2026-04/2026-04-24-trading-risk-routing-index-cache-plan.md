# TradingRiskEventRuntime Routing Index 缓存化实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `TradingRiskEventRuntime` 的 routing index 从 quote 高频路径重建，改为由 SymbolRegistry 的 seat state/version 事件驱动刷新，消除每条 quote 的全局派生状态重建成本。

**Architecture:** SymbolRegistry 是席位状态与版本号的唯一权威来源，因此完整事件边界必须放在 SymbolRegistry。`TradingRiskEventRuntime` 启动时构建初始 cached routing index，并订阅 seat state changed 与 seat version changed；quote 事件和 freshness wait 前后只读取 cached index，并继续使用 `routeKey + seatVersion` 做 current-route 校验。

**Tech Stack:** Bun、TypeScript、Longbridge SDK、事件驱动 runtime、`bun:test`。

---

## 1. 背景与 P0 问题

问题来源：`docs/issues/2026-04-24-quote-candlestick-hot-path-performance-issues.md` 的 P0 章节。

当前 `TradingRiskEventRuntime` 在 quote 高频路径中重复调用 `buildTradingRiskRoutingIndex`：

- quote 到达后重建：`src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:173`
- freshness wait 前重建：`src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:221`
- freshness wait 后重建：`src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:240`

`buildTradingRiskRoutingIndex` 每次都会遍历全部 `monitorContexts`，并创建 `routesBySymbol`、`routesByKey` 两个 `Map`：`src/main/tradingRiskEventRuntime/routingIndex.ts:81`。高频 quote 下，该成本会变成：

```text
quote event × monitorContexts × directions
```

这条路径属于交易风险链路，优先级高于显示链路优化。

## 2. 必须保留的正确性语义

修复不能通过删除校验或延迟校验来换取性能。以下语义必须保留：

1. `routeKey` 校验必须保留。
2. `seatVersion` 校验必须保留。
3. freshness wait 前后都必须复核 current-route。
4. duplicate trading symbol 必须继续 fail-fast。
5. seat version-only bump 必须触发 routing index 刷新。
6. seat state 从 ACTIVE 退出后，失活 route state 必须被清理。
7. 旧 route、旧 seatVersion、旧席位标的不能继续生成保护性清仓信号。

`isTradingRiskRouteCurrent` 当前已经表达了 `routeKey + seatVersion` 校验，必须继续复用该语义：

```ts
export function isTradingRiskRouteCurrent(
  expectedRoute: TradingRiskRoute,
  routingIndex: TradingRiskRoutingIndex,
): boolean {
  const currentRoute = resolveTradingRiskRoute(routingIndex, expectedRoute.tradingSymbol);
  if (!currentRoute) {
    return false;
  }

  return (
    currentRoute.routeKey === expectedRoute.routeKey &&
    currentRoute.seatVersion === expectedRoute.seatVersion
  );
}
```

## 3. 明确禁止的方案

以下方案会破坏业务正确性或变成补丁式优化，不能进入实现：

1. quote miss 时 fallback rebuild。
2. 定时 rebuild routing index。
3. 删除或弱化 `isTradingRiskRouteCurrent`。
4. 缓存失效后静默继续使用旧 index。
5. 为兼容旧行为保留 quote-path rebuild 分支。
6. 只订阅现有 `onSeatStateChanged`，但不覆盖 `bumpSeatVersion` 的纯版本变化。
7. 在各个 `bumpSeatVersion` 调用点手动通知 `TradingRiskEventRuntime`。

## 4. 关键代码事实

### 4.1 SymbolRegistry 是 seat truth 权威来源

接口定义位于 `src/types/seat.ts`：

```ts
export interface SymbolRegistry {
  getSeatState: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => SeatState;
  getSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => number;
  resolveSeatBySymbol: (symbol: string) => {
    monitorSymbol: string;
    direction: 'LONG' | 'SHORT';
    seatState: SeatState;
    seatVersion: number;
  } | null;
  updateSeatState: (
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    nextState: SeatState,
  ) => SeatState;
  bumpSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => number;
  onSeatStateChanged: (listener: (event: SeatStateChangedEvent) => void) => Unsubscribe;
}
```

当前 `createSymbolRegistry` 位于 `src/services/autoSymbolManager/utils.ts:322`。

### 4.2 现有 `onSeatStateChanged` 不覆盖 version-only bump

`updateSeatState` 会发布 seat state changed 事件：

```ts
updateSeatState(
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
  nextState: SeatState,
): SeatState {
  const seatEntry = resolveSeatEntry(registry, monitorSymbol, direction);
  const previousState = seatEntry.state;
  const previousVersion = seatEntry.lastEventVersion;
  seatEntry.state = {
    symbol: nextState.symbol,
    status: nextState.status,
    lastSwitchAt: nextState.lastSwitchAt ?? null,
    lastSearchAt: nextState.lastSearchAt ?? null,
    lastSeatActivatedAt: nextState.lastSeatActivatedAt ?? null,
    callPrice: nextState.callPrice ?? null,
    searchFailCountToday: nextState.searchFailCountToday,
    frozenTradingDayKey: nextState.frozenTradingDayKey,
  };
  seatEntry.lastEventVersion = seatEntry.version;
  emitSeatStateChanged({
    monitorSymbol,
    direction,
    previousState,
    nextState: seatEntry.state,
    previousVersion,
    nextVersion: seatEntry.version,
  });
  return seatEntry.state;
}
```

但 `bumpSeatVersion` 当前只递增版本，不发布事件：

```ts
bumpSeatVersion(monitorSymbol: string, direction: 'LONG' | 'SHORT'): number {
  const seatEntry = resolveSeatEntry(registry, monitorSymbol, direction);
  seatEntry.version += 1;
  return seatEntry.version;
}
```

因此，只订阅 `onSeatStateChanged` 无法满足 P0 要求的“seat version-only bump 也必须触发 routing index 刷新”。

### 4.3 TradingRiskRoutingIndex 的 truth 口径

`resolveMonitorContextSeatSnapshot` 只把 `status === 'ACTIVE'` 且 `symbol` 非空的席位标的视为可消费 symbol：`src/utils/utils.ts:14`。

`buildTradingRiskRoutingIndex` 只为 ACTIVE 席位建立 route：

```ts
for (const [monitorSymbol, monitorContext] of monitorContexts) {
  const seatSnapshot = resolveMonitorContextSeatSnapshot(monitorSymbol, symbolRegistry);
  if (seatSnapshot.longSymbol !== null) {
    registerRoute({
      routesBySymbol,
      routesByKey,
      monitorContext,
      monitorSymbol,
      direction: 'LONG',
      tradingSymbol: seatSnapshot.longSymbol,
      seatVersion: seatSnapshot.seatVersion.long,
    });
  }

  if (seatSnapshot.shortSymbol !== null) {
    registerRoute({
      routesBySymbol,
      routesByKey,
      monitorContext,
      monitorSymbol,
      direction: 'SHORT',
      tradingSymbol: seatSnapshot.shortSymbol,
      seatVersion: seatSnapshot.seatVersion.short,
    });
  }
}
```

因此，风险 runtime 的 route truth 是：

```text
ACTIVE seat + symbol + seatVersion
```

## 5. 推荐设计

### 5.1 事件边界

新增独立的 seat version changed 事件，而不是把 version-only bump 伪装成 seat state changed。version 事件只表达版本边界变化，不携带 `seatState`，避免让消费者误以为 version event 同时承诺状态迁移语义。

```ts
export type SeatVersionChangedEvent = Readonly<{
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly previousVersion: number;
  readonly nextVersion: number;
}>;
```

`SymbolRegistry` 增加：

```ts
onSeatVersionChanged: (listener: (event: SeatVersionChangedEvent) => void) => Unsubscribe;
```

事件语义：

```text
updateSeatState
-> 同步写入 nextState
-> 同步发布 SeatStateChangedEvent

bumpSeatVersion
-> 同步递增 version
-> 同步发布 SeatVersionChangedEvent
```

这样 state truth 与 version truth 分离，既不破坏现有 `QuoteSubscriptionRuntime`、`SeatActivationDispatcher` 对 `onSeatStateChanged` 的语义，也能覆盖 P0 的 version-only bump。

事件 listener 必须同步执行，`TradingRiskEventRuntime` 的 `refreshRoutingIndex()` 必须在 `updateSeatState` / `bumpSeatVersion` 调用栈内完成。不能把刷新放入 async queue、timer 或 deferred task，否则 quote 可能在 seat truth 已变化但 cached index 尚未刷新时进入风险链路。

现有业务路径同时存在 `bumpSeatVersion -> updateSeatState` 与 `updateSeatState -> bumpSeatVersion` 两类顺序，因此运行期可能短暂经历“旧 seatState + 新 version”或“新 seatState + 旧 version”的中间投影。该中间态不是跨模块业务契约，不需要为它建立专门不变量；`TradingRiskEventRuntime` 的要求是每次 seat state/version truth 变化后立即同步重投影，并以 SymbolRegistry 当前权威快照为准。

### 5.2 TradingRiskEventRuntime 缓存 routing index

新增运行态引用：

```ts
let cachedRoutingIndex: TradingRiskRoutingIndex | null = null;
let routingIndexFatalError: unknown = null;
let unsubscribeSeatStateChanged: (() => void) | null = null;
let unsubscribeSeatVersionChanged: (() => void) | null = null;
```

新增同步刷新函数。刷新必须具备失败原子性：构建成功后才能替换缓存；构建失败时必须清空缓存并记录 fatal error，使后续 quote/freshness 读取直接 fail-fast，禁止继续使用旧 index。

```ts
function refreshRoutingIndex(): TradingRiskRoutingIndex {
  try {
    const routingIndex = buildTradingRiskRoutingIndex({
      monitorContexts: deps.monitorContexts,
      symbolRegistry: deps.symbolRegistry,
    });
    cachedRoutingIndex = routingIndex;
    routingIndexFatalError = null;
    pruneRouteStates(new Set(routingIndex.routesByKey.keys()));
    return routingIndex;
  } catch (error) {
    cachedRoutingIndex = null;
    routingIndexFatalError = error;
    throw error;
  }
}
```

新增只读访问函数：

```ts
function getRoutingIndex(): TradingRiskRoutingIndex {
  if (routingIndexFatalError !== null) {
    throw routingIndexFatalError;
  }

  if (cachedRoutingIndex === null) {
    throw new Error('[TradingRiskEventRuntime] routing index 尚未初始化');
  }

  return cachedRoutingIndex;
}
```

`routingIndexFatalError` 的 fail-fast 边界是“停止继续使用旧 cached route”，不是设计成进程级 crash：

- seat state/version event handler 内刷新失败：错误同步抛回 `SymbolRegistry.updateSeatState` / `SymbolRegistry.bumpSeatVersion` 的调用栈，seat writer 立即感知失败。
- quote handler 读取 `getRoutingIndex()` 时发现 fatal：错误同步抛回 `quoteClient` 的 quote listener 调用栈。
- `processRouteQueue` 内 freshness 前后读取 `getRoutingIndex()` 时发现 fatal：错误进入既有 `processRouteQueue(...).catch(...)`，记录 `[TradingRiskEventRuntime] 风险事件处理失败` 并停止该 route 本轮处理。

任何路径都不能捕获 fatal 后 fallback rebuild，也不能在缓存失效后继续使用旧 routing index。

### 5.3 事件流

目标事件流：

```text
runtime start
-> refreshRoutingIndex()
-> 成功后 running = true
-> subscribe seat state changed
-> subscribe seat version changed
-> subscribe quote updated

seat state changed / seat version changed
-> refreshRoutingIndex()
-> 成功时原子替换 cached index 并 prune inactive routeStates
-> duplicate trading symbol 或构建异常时清空 cached index、记录 fatal error、同步抛回 seat writer 调用栈
-> 后续 quote/freshness 读取 cached index 时 fail-fast，不允许继续使用旧 index

quote event
-> getRoutingIndex()
-> fatal 存在时同步抛回 quote listener 调用栈
-> resolveTradingRiskRoute(cachedIndex, event.symbol)
-> route latest-only collapse

freshness wait before
-> getRoutingIndex()
-> fatal 存在时进入 processRouteQueue 既有 async catch，记录错误并停止 route 本轮处理
-> isTradingRiskRouteCurrent(snapshotRoute, cachedIndex)

freshness wait after
-> getRoutingIndex()
-> fatal 存在时进入 processRouteQueue 既有 async catch，记录错误并停止 route 本轮处理
-> isTradingRiskRouteCurrent(snapshotRoute, cachedIndex)
-> executeDirectionalUnrealizedLoss(latestRoute, latestEvent)
```

## 6. 文件修改范围

### Modify: `src/types/seat.ts`

职责：扩展 SymbolRegistry 事件契约。

需要新增：

- `SeatVersionChangedEvent`
- `onSeatVersionChanged`

### Modify: `src/services/autoSymbolManager/utils.ts`

职责：真实 SymbolRegistry 实现。

需要新增：

- `SeatVersionChangedListener` import/type 使用
- `versionListeners` 集合
- `emitSeatVersionChanged`
- `bumpSeatVersion` 发布 version event
- `onSeatVersionChanged` 订阅/取消订阅

### Modify: `src/services/autoSymbolManager/types.ts`

职责：autoSymbolManager 内部 listener 类型定义。

需要新增：

- `SeatVersionChangedListener`

### Modify: `src/main/tradingRiskEventRuntime/types.ts`

职责：风险 runtime 依赖类型。

需要确保：

- `symbolRegistry` 类型包含 `onSeatStateChanged` 与 `onSeatVersionChanged`
- `marketDataClient` 仍只需要 `onQuoteUpdated`

### Modify: `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`

职责：风险事件 runtime。

需要完成：

- 替换 quote/freshness path 中的 rebuild 为 cached index read
- 启动时初始化 cached index
- 订阅 seat state/version 事件刷新 cached index
- 停止时取消所有订阅并清空缓存

### Modify: `tests/helpers/testDoubles.ts`

职责：测试替身。

需要让 `createSymbolRegistryDouble` 支持：

- `onSeatVersionChanged`
- `bumpSeatVersion` 发布 version event

### Modify: `tests/main/tradingRiskEventRuntime/tradingRiskEventRuntime.business.test.ts`

职责：P0 行为测试。

需要补齐：

- quote 热路径不重建 index
- seat state changed 后 route 切换
- version-only bump 后 stale route 被拦截
- duplicate 在 seat event rebuild 时 fail-fast
- stop 后事件取消订阅

### Modify: 其他测试替身中的 `SymbolRegistry` 字面量

通过搜索：

```bash
grep -R "onSeatStateChanged" tests src --include='*.ts'
```

所有手写 `SymbolRegistry` 对象都需要补 `onSeatVersionChanged: () => () => {}`，避免类型不完整。

## 7. 任务分解

### Task 1: 扩展 SymbolRegistry version 事件契约

**Files:**

- Modify: `src/types/seat.ts`
- Modify: `src/services/autoSymbolManager/types.ts`

- [ ] **Step 1: 修改 `src/types/seat.ts`，新增 version 事件类型**

在 `SeatStateChangedEvent` 后增加：

```ts
/**
 * 席位版本变化事件。
 * 类型用途：表达 SymbolRegistry 权威席位版本号发生变化，供依赖 seatVersion 隔离语义的 runtime 刷新派生状态。
 * 数据来源：由 SymbolRegistry.bumpSeatVersion 在版本递增完成后发布。
 * 使用范围：TradingRiskEventRuntime 等需要响应 version-only bump 的事件驱动链路。
 */
export type SeatVersionChangedEvent = Readonly<{
  /** 监控标的代码 */
  monitorSymbol: string;

  /** 席位方向 */
  direction: 'LONG' | 'SHORT';

  /** 递增前版本号 */
  previousVersion: number;

  /** 递增后版本号 */
  nextVersion: number;
}>;
```

- [ ] **Step 2: 修改 `SymbolRegistry` 接口**

在 `onSeatStateChanged` 后增加：

```ts
/** 订阅席位版本变化事件 */
onSeatVersionChanged: (listener: (event: SeatVersionChangedEvent) => void) => Unsubscribe;
```

- [ ] **Step 3: 修改 `src/services/autoSymbolManager/types.ts` import**

把 seat 类型 import 扩展为包含 `SeatVersionChangedEvent`：

```ts
import type {
  SeatState,
  SeatStateChangedEvent,
  SeatStatus,
  SeatVersionChangedEvent,
  SymbolRegistry,
} from '../../types/seat.js';
```

- [ ] **Step 4: 新增 listener 类型**

在 `SeatStateChangedListener` 后增加：

```ts
/**
 * 席位版本变化监听器。
 * 类型用途：SymbolRegistry 内部版本事件发射时保存 listener 集合。
 * 数据来源：由 onSeatVersionChanged 注册。
 * 使用范围：仅 autoSymbolManager 的 SymbolRegistry 实现使用。
 */
export type SeatVersionChangedListener = (event: SeatVersionChangedEvent) => void;
```

- [ ] **Step 5: 运行类型检查确认接口破坏点**

Run:

```bash
bun type-check
```

Expected: FAIL，错误集中在 `SymbolRegistry` 字面量或实现缺少 `onSeatVersionChanged`。

### Task 2: 实现 SymbolRegistry version 事件发布

**Files:**

- Modify: `src/services/autoSymbolManager/utils.ts`
- Modify: `tests/helpers/testDoubles.ts`
- Modify: 所有手写 `SymbolRegistry` 测试替身

- [ ] **Step 1: 修改 `src/services/autoSymbolManager/utils.ts` import**

把 `SeatVersionChangedListener` 加入 import：

```ts
import type {
  SeatEntry,
  SeatStateChangedListener,
  SeatUnavailableReason,
  SeatVersionChangedListener,
  SignalSeatValidationResult,
  SymbolSeatEntry,
  ValidateSignalSeatParams,
} from './types.js';
```

- [ ] **Step 2: 在 `createSymbolRegistry` 中增加 listener 集合**

在现有 `listeners` 后增加：

```ts
const versionListeners = new Set<SeatVersionChangedListener>();
```

- [ ] **Step 3: 新增 version 事件广播函数**

在 `emitSeatStateChanged` 后增加：

```ts
/**
 * 广播席位版本变化事件。
 * 事件只由 bumpSeatVersion 发布，表达 seatVersion 隔离边界变化，不表达席位状态迁移。
 */
function emitSeatVersionChanged(event: Parameters<SeatVersionChangedListener>[0]): void {
  for (const listener of versionListeners) {
    listener(event);
  }
}
```

- [ ] **Step 4: 修改 `bumpSeatVersion` 发布事件**

替换现有实现为：

```ts
bumpSeatVersion(monitorSymbol: string, direction: 'LONG' | 'SHORT'): number {
  const seatEntry = resolveSeatEntry(registry, monitorSymbol, direction);
  const previousVersion = seatEntry.version;
  seatEntry.version += 1;
  emitSeatVersionChanged({
    monitorSymbol,
    direction,
    previousVersion,
    nextVersion: seatEntry.version,
  });
  return seatEntry.version;
},
```

`emitSeatVersionChanged` 必须保持同步传播错误，不要在 `bumpSeatVersion` 内 catch listener 错误。若 `TradingRiskEventRuntime` 的 version listener 因 duplicate routing index 抛错，错误会中断 `bumpSeatVersion` 调用栈；对于“先 bump version 再 update seat state”的业务路径，这可能阻断后续 `updateSeatState` 执行。这是强 fail-fast 的明确副作用，目的是避免风险 runtime 在版本 truth 已变化但 routing projection 失败时继续使用旧 cached route。

- [ ] **Step 5: 增加 `onSeatVersionChanged` 实现**

在 `onSeatStateChanged` 后增加：

```ts
onSeatVersionChanged(listener: SeatVersionChangedListener): () => void {
  versionListeners.add(listener);
  return () => {
    versionListeners.delete(listener);
  };
},
```

- [ ] **Step 6: 修改 `tests/helpers/testDoubles.ts` import**

把 seat 类型 import 扩展为包含 `SeatVersionChangedEvent`：

```ts
import type {
  SymbolRegistry,
  SeatState,
  SeatStateChangedEvent,
  SeatVersionChangedEvent,
} from '../../src/types/seat.js';
```

- [ ] **Step 7: 修改 `createSymbolRegistryDouble` listener 集合**

在 `seatStateChangedListeners` 后增加：

```ts
const seatVersionChangedListeners = new Set<(event: SeatVersionChangedEvent) => void>();
```

- [ ] **Step 8: 新增测试替身 version 事件广播函数**

在 `emitSeatStateChanged` 后增加：

```ts
function emitSeatVersionChanged(event: SeatVersionChangedEvent): void {
  for (const listener of seatVersionChangedListeners) {
    listener(event);
  }
}
```

- [ ] **Step 9: 修改测试替身 `bumpSeatVersion`**

替换为：

```ts
bumpSeatVersion(_monitorSymbol: string, direction: 'LONG' | 'SHORT'): number {
  if (direction === 'LONG') {
    const previousVersion = longVersion;
    longVersion += 1;
    emitSeatVersionChanged({
      monitorSymbol: _monitorSymbol,
      direction,
      previousVersion,
      nextVersion: longVersion,
    });
    return longVersion;
  }

  const previousVersion = shortVersion;
  shortVersion += 1;
  emitSeatVersionChanged({
    monitorSymbol: _monitorSymbol,
    direction,
    previousVersion,
    nextVersion: shortVersion,
  });
  return shortVersion;
},
```

- [ ] **Step 10: 增加测试替身 `onSeatVersionChanged`**

在 `onSeatStateChanged` 后增加：

```ts
onSeatVersionChanged: (listener) => {
  seatVersionChangedListeners.add(listener);
  return () => {
    seatVersionChangedListeners.delete(listener);
  };
},
```

- [ ] **Step 11: 修复 TypeScript 接口演进导致的手写 SymbolRegistry 字面量**

搜索：

```bash
grep -R "onSeatStateChanged" tests src --include='*.ts'
```

对已经显式声明为完整 `SymbolRegistry` 的手写对象，补充最小空订阅实现：

```ts
onSeatVersionChanged: () => () => {},
```

这是 `SymbolRegistry` 作为 seat truth source 新增事件契约后的机械类型更新，不是业务链路扩散。不要让 `QuoteSubscriptionRuntime`、`SeatActivationDispatcher`、`AutoSearchWakeupRuntime` 订阅 version event，也不要为这些消费者增加任何 version 事件处理逻辑。

- [ ] **Step 12: 运行类型检查**

Run:

```bash
bun type-check
```

Expected: PASS，或只剩与后续 runtime 修改相关的测试期望失败。

### Task 3: 写 TradingRiskEventRuntime 缓存化失败测试

**Files:**

- Modify: `tests/main/tradingRiskEventRuntime/tradingRiskEventRuntime.business.test.ts`

- [ ] **Step 0: 调整测试类型 import 与 runtime deps helper**

把测试文件中的类型 import 扩展为：

```ts
import type { TradingRiskEventRuntimeDeps } from '../../../src/main/tradingRiskEventRuntime/types.js';
import type { QuoteUpdatedEvent } from '../../../src/types/services.js';
import type {
  SeatState,
  SeatStateChangedEvent,
  SeatVersionChangedEvent,
  SymbolRegistry,
} from '../../../src/types/seat.js';
```

并把 `createRuntimeDeps` 参数里的 `symbolRegistry` 类型从 `ReturnType<typeof createSymbolRegistryDouble>` 改为 `SymbolRegistry`：

```ts
readonly symbolRegistry?: SymbolRegistry;
```

这一步只让局部多 monitor registry 测试替身能作为 `SymbolRegistry` 传入，不改变生产代码契约。

- [ ] **Step 1: 增加 quote 热路径不读取 registry 的测试**

在 `describe('tradingRiskEventRuntime runtime flow', ...)` 内增加：

```ts
it('does not rebuild routing index on quote events after start', async () => {
  let getSeatStateCalls = 0;
  let getSeatVersionCalls = 0;
  const baseRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });
  const symbolRegistry = {
    ...baseRegistry,
    getSeatState: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => {
      getSeatStateCalls += 1;
      return baseRegistry.getSeatState(monitorSymbol, direction);
    },
    getSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => {
      getSeatVersionCalls += 1;
      return baseRegistry.getSeatVersion(monitorSymbol, direction);
    },
  };
  const executedPrices: number[] = [];
  const { deps } = createRuntimeDeps({
    symbolRegistry,
    unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
      monitorDirectionalUnrealizedLoss: async ({ quote }) => {
        executedPrices.push(quote.price);
      },
    }),
  });
  const runtime = createTradingRiskEventRuntime(deps);

  runtime.start();
  const stateCallsAfterStart = getSeatStateCalls;
  const versionCallsAfterStart = getSeatVersionCalls;

  emitQuoteUpdated('BULL.HK', 1.23);
  await waitTick();

  expect(executedPrices).toEqual([1.23]);
  expect(getSeatStateCalls).toBe(stateCallsAfterStart);
  expect(getSeatVersionCalls).toBe(versionCallsAfterStart);
  await runtime.stopAndDrain();
});
```

Expected before implementation: FAIL，因为 quote path 当前会 rebuild 并读取 registry。该测试只发一条 quote，避免与已有 single-flight latest-only collapse 语义混淆；连续 quote 收敛行为由现有 `collapses concurrent events to the latest quote for the same route` 覆盖。

- [ ] **Step 2: 增加 quote 与 freshness 不额外投影、seat event 才投影的边界测试**

```ts
it('projects routing index only on start and seat events, not quote or freshness checks', async () => {
  let getSeatStateCalls = 0;
  let getSeatVersionCalls = 0;
  const baseRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });
  const symbolRegistry = {
    ...baseRegistry,
    getSeatState: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => {
      getSeatStateCalls += 1;
      return baseRegistry.getSeatState(monitorSymbol, direction);
    },
    getSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => {
      getSeatVersionCalls += 1;
      return baseRegistry.getSeatVersion(monitorSymbol, direction);
    },
  };
  const consistencyPort = createConsistencyPort({
    started: true,
    currentVersion: 1,
    staleVersion: 1,
  });
  consistencyPort.enablePendingFreshWait();
  const { deps } = createRuntimeDeps({
    consistencyPort,
    symbolRegistry,
  });
  const runtime = createTradingRiskEventRuntime(deps);

  runtime.start();
  const stateCallsAfterStart = getSeatStateCalls;
  const versionCallsAfterStart = getSeatVersionCalls;

  emitQuoteUpdated('BULL.HK', 1.23);
  await waitTick();
  expect(getSeatStateCalls).toBe(stateCallsAfterStart);
  expect(getSeatVersionCalls).toBe(versionCallsAfterStart);

  consistencyPort.resolveFresh();
  await waitTick();
  expect(getSeatStateCalls).toBe(stateCallsAfterStart);
  expect(getSeatVersionCalls).toBe(versionCallsAfterStart);

  symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
  expect(getSeatStateCalls).toBeGreaterThan(stateCallsAfterStart);
  expect(getSeatVersionCalls).toBeGreaterThan(versionCallsAfterStart);

  const stateCallsAfterVersionEvent = getSeatStateCalls;
  const versionCallsAfterVersionEvent = getSeatVersionCalls;
  symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
    symbol: 'BULL2.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: Date.now(),
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  });
  expect(getSeatStateCalls).toBeGreaterThan(stateCallsAfterVersionEvent);
  expect(getSeatVersionCalls).toBeGreaterThan(versionCallsAfterVersionEvent);

  await runtime.stopAndDrain();
});
```

Expected before implementation: FAIL，因为 quote path 和 freshness 校验都会额外读取 registry。

- [ ] **Step 3: 增加 seat state changed 后新 route 生效测试**

```ts
it('refreshes cached route when seat state changes', async () => {
  const executedSymbols: string[] = [];
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });
  const { deps } = createRuntimeDeps({
    symbolRegistry,
    unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
      monitorDirectionalUnrealizedLoss: async ({ symbol }) => {
        executedSymbols.push(symbol);
      },
    }),
  });
  const runtime = createTradingRiskEventRuntime(deps);

  runtime.start();
  symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
    symbol: 'BULL2.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: Date.now(),
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  });

  emitQuoteUpdated('BULL.HK', 1.23);
  emitQuoteUpdated('BULL2.HK', 2.34);
  await waitTick();
  await waitTick();

  expect(executedSymbols).toEqual(['BULL2.HK']);
  await runtime.stopAndDrain();
});
```

Expected before implementation: 当前 quote path rebuild 会让该测试可能通过；它作为回归测试保留。

- [ ] **Step 4: 增加 version-only bump 后 stale route 被拦截测试**

```ts
it('skips an in-flight stale route when seat version changes without state change', async () => {
  const executedPrices: number[] = [];
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longVersion: 1,
  });
  const consistencyPort = createConsistencyPort({
    started: true,
    currentVersion: 1,
    staleVersion: 1,
  });
  consistencyPort.enablePendingFreshWait();
  const { deps } = createRuntimeDeps({
    consistencyPort,
    symbolRegistry,
    unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
      monitorDirectionalUnrealizedLoss: async ({ quote }) => {
        executedPrices.push(quote.price);
      },
    }),
  });
  const runtime = createTradingRiskEventRuntime(deps);

  runtime.start();
  emitQuoteUpdated('BULL.HK', 1.23);
  await waitTick();

  symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
  consistencyPort.resolveFresh();
  await waitTick();
  await waitTick();

  expect(executedPrices).toEqual([]);
  await runtime.stopAndDrain();
});
```

Expected before implementation: 现有 quote/freshness rebuild 可能通过；缓存化后必须继续通过，证明 version-only 事件刷新会让旧 snapshot route 失效。

- [ ] **Step 5: 增加 version-only bump 后新 quote 使用新 seatVersion 执行测试**

```ts
it('uses the refreshed seat version for quotes after a version-only bump', async () => {
  const executedSeatVersions: number[] = [];
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longVersion: 1,
  });
  const { deps } = createRuntimeDeps({
    symbolRegistry,
    unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
      monitorDirectionalUnrealizedLoss: async ({ seatVersion }) => {
        executedSeatVersions.push(seatVersion);
      },
    }),
  });
  const runtime = createTradingRiskEventRuntime(deps);

  runtime.start();
  symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
  emitQuoteUpdated('BULL.HK', 1.23);
  await waitTick();

  expect(executedSeatVersions).toEqual([2]);
  await runtime.stopAndDrain();
});
```

Expected before implementation: FAIL，因为 runtime 当前不会因 version-only bump 预先刷新 cached route；实现后必须 PASS。

- [ ] **Step 6: 增加按 monitorSymbol 隔离的 SymbolRegistry 测试替身**

该替身只放在 `tests/main/tradingRiskEventRuntime/tradingRiskEventRuntime.business.test.ts` 内，唯一目的就是表达“两个 monitor 初始无重复、seat event 后动态重复”的测试场景。不要改全局 `createSymbolRegistryDouble` 的数据模型，也不要把该局部替身推广成通用多 monitor 测试基础设施。

```ts
function createMultiMonitorSymbolRegistryDouble(params: {
  readonly seats: ReadonlyMap<
    string,
    Readonly<{
      readonly long: SeatState;
      readonly short: SeatState;
      readonly longVersion: number;
      readonly shortVersion: number;
    }>
  >;
}): SymbolRegistry {
  const entries = new Map(
    [...params.seats].map(([monitorSymbol, entry]) => [
      monitorSymbol,
      {
        long: { state: entry.long, version: entry.longVersion },
        short: { state: entry.short, version: entry.shortVersion },
      },
    ]),
  );
  const seatStateChangedListeners = new Set<(event: SeatStateChangedEvent) => void>();
  const seatVersionChangedListeners = new Set<(event: SeatVersionChangedEvent) => void>();

  function resolveEntry(monitorSymbol: string, direction: 'LONG' | 'SHORT') {
    const entry = entries.get(monitorSymbol);
    if (entry === undefined) {
      throw new Error(`Unknown monitorSymbol: ${monitorSymbol}`);
    }

    return direction === 'LONG' ? entry.long : entry.short;
  }

  return {
    getSeatState: (monitorSymbol, direction) => resolveEntry(monitorSymbol, direction).state,
    getSeatVersion: (monitorSymbol, direction) => resolveEntry(monitorSymbol, direction).version,
    resolveSeatBySymbol: (symbol) => {
      for (const [monitorSymbol, entry] of entries) {
        if (entry.long.state.symbol === symbol) {
          return {
            monitorSymbol,
            direction: 'LONG',
            seatState: entry.long.state,
            seatVersion: entry.long.version,
          };
        }

        if (entry.short.state.symbol === symbol) {
          return {
            monitorSymbol,
            direction: 'SHORT',
            seatState: entry.short.state,
            seatVersion: entry.short.version,
          };
        }
      }

      return null;
    },
    updateSeatState: (monitorSymbol, direction, nextState) => {
      const entry = resolveEntry(monitorSymbol, direction);
      const previousState = entry.state;
      entry.state = nextState;
      for (const listener of seatStateChangedListeners) {
        listener({
          monitorSymbol,
          direction,
          previousState,
          nextState,
          previousVersion: entry.version,
          nextVersion: entry.version,
        });
      }
      return entry.state;
    },
    bumpSeatVersion: (monitorSymbol, direction) => {
      const entry = resolveEntry(monitorSymbol, direction);
      const previousVersion = entry.version;
      entry.version += 1;
      for (const listener of seatVersionChangedListeners) {
        listener({
          monitorSymbol,
          direction,
          previousVersion,
          nextVersion: entry.version,
        });
      }
      return entry.version;
    },
    onSeatStateChanged: (listener) => {
      seatStateChangedListeners.add(listener);
      return () => {
        seatStateChangedListeners.delete(listener);
      };
    },
    onSeatVersionChanged: (listener) => {
      seatVersionChangedListeners.add(listener);
      return () => {
        seatVersionChangedListeners.delete(listener);
      };
    },
  };
}
```

测试文件需要补充类型 import：

```ts
import type {
  SeatState,
  SeatStateChangedEvent,
  SeatVersionChangedEvent,
  SymbolRegistry,
} from '../../../src/types/seat.js';
```

- [ ] **Step 7: 增加 seat event duplicate fail-fast 与缓存失效测试**

```ts
it('fails fast and invalidates cached route when seat state change creates duplicate ownership', async () => {
  const hsiLong: SeatState = {
    symbol: 'BULL.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
  const hsiShort: SeatState = {
    symbol: 'BEAR.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
  const techLong: SeatState = {
    symbol: 'TECHBULL.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
  const techShort: SeatState = {
    symbol: 'TECHBEAR.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
  const symbolRegistry = createMultiMonitorSymbolRegistryDouble({
    seats: new Map([
      ['HSI.HK', { long: hsiLong, short: hsiShort, longVersion: 1, shortVersion: 1 }],
      ['TECH.HK', { long: techLong, short: techShort, longVersion: 1, shortVersion: 1 }],
    ]),
  });
  const executedSymbols: string[] = [];
  const monitorContexts = new Map<string, ReturnType<typeof createMonitorContextDouble>>([
    [
      'HSI.HK',
      createMonitorContextDouble({
        config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
        symbolRegistry,
        unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
          monitorDirectionalUnrealizedLoss: async ({ symbol }) => {
            executedSymbols.push(symbol);
          },
        }),
      }),
    ],
    [
      'TECH.HK',
      createMonitorContextDouble({
        config: createMonitorConfig({ monitorSymbol: 'TECH.HK' }),
        symbolRegistry,
        unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
          monitorDirectionalUnrealizedLoss: async ({ symbol }) => {
            executedSymbols.push(symbol);
          },
        }),
      }),
    ],
  ]);
  const { deps } = createRuntimeDeps({
    symbolRegistry,
    monitorContexts,
  });
  const runtime = createTradingRiskEventRuntime(deps);

  runtime.start();

  expect(() => {
    symbolRegistry.updateSeatState('TECH.HK', 'SHORT', {
      ...techShort,
      symbol: 'BULL.HK',
    });
  }).toThrow('重复归属');

  expect(() => {
    emitQuoteUpdated('BULL.HK', 1.23);
  }).toThrow('重复归属');

  await waitTick();

  expect(executedSymbols).toEqual([]);
  await runtime.stopAndDrain();
});
```

Expected before implementation: FAIL，因为 runtime 当前不订阅 seat event，不会在 update 时 rebuild；实现后必须 PASS，并证明 duplicate 失败后不会继续使用旧 cached route。

- [ ] **Step 8: 增加 freshness wait 期间 seat state 变化拦截旧 route 测试**

```ts
it('skips an in-flight stale route when seat state changes during freshness wait', async () => {
  const executedSymbols: string[] = [];
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });
  const consistencyPort = createConsistencyPort({
    started: true,
    currentVersion: 1,
    staleVersion: 1,
  });
  consistencyPort.enablePendingFreshWait();
  const { deps } = createRuntimeDeps({
    consistencyPort,
    symbolRegistry,
    unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
      monitorDirectionalUnrealizedLoss: async ({ symbol }) => {
        executedSymbols.push(symbol);
      },
    }),
  });
  const runtime = createTradingRiskEventRuntime(deps);

  runtime.start();
  emitQuoteUpdated('BULL.HK', 1.23);
  await waitTick();

  symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
    symbol: 'BULL2.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: Date.now(),
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  });
  consistencyPort.resolveFresh();
  await waitTick();
  await waitTick();

  expect(executedSymbols).toEqual([]);
  await runtime.stopAndDrain();
});
```

该测试保护 freshness wait 前后都读取最新 cached index 的语义，避免旧标的在等待期间发生 seat state 漂移后继续生成保护性清仓信号。

- [ ] **Step 9: 增加 start 初始刷新失败不半启动测试**

```ts
it('does not leave runtime half-started when initial routing refresh fails', async () => {
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });
  const monitorContexts = new Map<string, ReturnType<typeof createMonitorContextDouble>>([
    [
      'HSI.HK',
      createMonitorContextDouble({
        config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
        symbolRegistry,
      }),
    ],
    [
      'TECH.HK',
      createMonitorContextDouble({
        config: createMonitorConfig({ monitorSymbol: 'TECH.HK' }),
        symbolRegistry,
      }),
    ],
  ]);
  const { deps } = createRuntimeDeps({
    symbolRegistry,
    monitorContexts,
  });
  const runtime = createTradingRiskEventRuntime(deps);

  expect(() => {
    runtime.start();
  }).toThrow('重复归属');

  expect(quoteUpdatedListener).toBeNull();

  await runtime.stopAndDrain();
});
```

该测试要求初始 duplicate trading symbol 时 `start()` 在订阅 quote 前失败，并保持未半启动状态。

- [ ] **Step 10: 运行新增测试确认失败点**

Run:

```bash
bun test tests/main/tradingRiskEventRuntime/tradingRiskEventRuntime.business.test.ts
```

Expected: 至少 quote 热路径不重建和 seat event duplicate fail-fast / 缓存失效测试失败。

### Task 4: 实现 TradingRiskEventRuntime cached routing index

**Files:**

- Modify: `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`

- [ ] **Step 1: 新增 unsubscribe 与缓存状态**

在现有状态附近改成：

```ts
let running = false;
let unsubscribeQuoteUpdated: (() => void) | null = null;
let unsubscribeSeatStateChanged: (() => void) | null = null;
let unsubscribeSeatVersionChanged: (() => void) | null = null;
let cachedRoutingIndex: TradingRiskRoutingIndex | null = null;
let routingIndexFatalError: unknown = null;
const routeStates = new Map<string, RouteExecutionState>();
const activeRoutePromises = new Set<Promise<void>>();
```

- [ ] **Step 2: 替换 `rebuildRoutingIndex` 为 `refreshRoutingIndex`**

将原函数：

```ts
function rebuildRoutingIndex(): TradingRiskRoutingIndex {
  const routingIndex = buildTradingRiskRoutingIndex({
    monitorContexts: deps.monitorContexts,
    symbolRegistry: deps.symbolRegistry,
  });
  pruneRouteStates(new Set(routingIndex.routesByKey.keys()));
  return routingIndex;
}
```

替换为：

```ts
function refreshRoutingIndex(): TradingRiskRoutingIndex {
  try {
    const routingIndex = buildTradingRiskRoutingIndex({
      monitorContexts: deps.monitorContexts,
      symbolRegistry: deps.symbolRegistry,
    });
    cachedRoutingIndex = routingIndex;
    routingIndexFatalError = null;
    pruneRouteStates(new Set(routingIndex.routesByKey.keys()));
    return routingIndex;
  } catch (error) {
    cachedRoutingIndex = null;
    routingIndexFatalError = error;
    throw error;
  }
}
```

- [ ] **Step 3: 新增 `getRoutingIndex`**

放在 `refreshRoutingIndex` 后：

```ts
function getRoutingIndex(): TradingRiskRoutingIndex {
  if (routingIndexFatalError !== null) {
    throw routingIndexFatalError;
  }

  if (cachedRoutingIndex === null) {
    throw new Error('[TradingRiskEventRuntime] routing index 尚未初始化');
  }

  return cachedRoutingIndex;
}
```

- [ ] **Step 4: 新增 seat event handler**

放在 `handleQuoteUpdated` 前：

```ts
function handleSeatTruthChanged(): void {
  if (!running) {
    return;
  }

  refreshRoutingIndex();
}
```

不需要读取 event 内容，因为 routing index 始终从 SymbolRegistry 权威状态重投影。`refreshRoutingIndex()` 抛错时必须向事件发布调用栈继续抛出，不能在 handler 内 catch 后继续运行旧缓存。

- [ ] **Step 5: 修改 `handleQuoteUpdated` 只读缓存**

把：

```ts
const routingIndex = rebuildRoutingIndex();
const route = resolveTradingRiskRoute(routingIndex, event.symbol);
```

替换为：

```ts
const route = resolveTradingRiskRoute(getRoutingIndex(), event.symbol);
```

- [ ] **Step 6: 修改 freshness 前 current-route 校验**

把：

```ts
const routingIndexBeforeFresh = rebuildRoutingIndex();
if (!isTradingRiskRouteCurrent(snapshotRoute, routingIndexBeforeFresh)) {
  return;
}
```

替换为：

```ts
if (!isTradingRiskRouteCurrent(snapshotRoute, getRoutingIndex())) {
  return;
}
```

- [ ] **Step 7: 修改 freshness 后 current-route 校验**

把：

```ts
const routingIndexAfterFresh = rebuildRoutingIndex();
if (!isTradingRiskRouteCurrent(snapshotRoute, routingIndexAfterFresh)) {
  return;
}
```

替换为：

```ts
if (!isTradingRiskRouteCurrent(snapshotRoute, getRoutingIndex())) {
  return;
}
```

- [ ] **Step 8: 修改 start 初始化与订阅**

替换 `start()` 中启动逻辑为：

```ts
function start(): void {
  if (running) {
    return;
  }

  refreshRoutingIndex();
  running = true;
  unsubscribeSeatStateChanged = deps.symbolRegistry.onSeatStateChanged(handleSeatTruthChanged);
  unsubscribeSeatVersionChanged = deps.symbolRegistry.onSeatVersionChanged(handleSeatTruthChanged);
  unsubscribeQuoteUpdated = deps.marketDataClient.onQuoteUpdated((event) => {
    handleQuoteUpdated(event);
  });
}
```

`refreshRoutingIndex()` 必须在 `running = true` 前完成。若初始 duplicate trading symbol 或 routing index 构建异常抛错，`start()` 直接失败，并保持 `running === false`、不订阅任何事件，避免半启动状态。

订阅顺序必须是 seat state changed、seat version changed、quote updated。quote 必须最后订阅，避免 quote 在 seat truth listener 尚未接入时进入 runtime。

- [ ] **Step 9: 在 `processRouteQueue` finally 中清理已失活 route state**

将原 `finally`：

```ts
} finally {
  routeState.inFlight = false;
  if (routeState.dirty && running) {
    routeState.inFlight = true;
    launchRouteProcessing(routeKey);
  }
}
```

替换为：

```ts
} finally {
  routeState.inFlight = false;

  if (
    routingIndexFatalError === null &&
    cachedRoutingIndex !== null &&
    !cachedRoutingIndex.routesByKey.has(routeKey)
  ) {
    routeStates.delete(routeKey);
    return;
  }

  if (routeStates.get(routeKey) === routeState && routeState.dirty && running) {
    routeState.inFlight = true;
    launchRouteProcessing(routeKey);
  }
}
```

`pruneRouteStates()` 会跳过 in-flight route，因此 seat state/version event 发生时，正在执行的失活 route state 不能立即删除；它必须在本轮 async route 结束后的 `finally` 中基于有效 cached index 做 guarded cleanup。若当前存在 `routingIndexFatalError` 或缓存为空，不能在 cleanup 分支误删 route state，必须让 fatal fail-fast 语义优先暴露。

- [ ] **Step 10: 修改 stopAndDrain 取消订阅并清空缓存**

在 `stopAndDrain()` 中加入：

```ts
unsubscribeSeatStateChanged?.();
unsubscribeSeatStateChanged = null;
unsubscribeSeatVersionChanged?.();
unsubscribeSeatVersionChanged = null;
```

并在 `routeStates.clear();` 后加入：

```ts
cachedRoutingIndex = null;
routingIndexFatalError = null;
```

完整停止顺序应为：

```ts
async function stopAndDrain(): Promise<void> {
  running = false;
  unsubscribeQuoteUpdated?.();
  unsubscribeQuoteUpdated = null;
  unsubscribeSeatStateChanged?.();
  unsubscribeSeatStateChanged = null;
  unsubscribeSeatVersionChanged?.();
  unsubscribeSeatVersionChanged = null;

  if (activeRoutePromises.size > 0) {
    await Promise.allSettled(activeRoutePromises);
  }

  routeStates.clear();
  cachedRoutingIndex = null;
  routingIndexFatalError = null;
}
```

- [ ] **Step 11: 运行 TradingRiskEventRuntime 测试**

Run:

```bash
bun test tests/main/tradingRiskEventRuntime/tradingRiskEventRuntime.business.test.ts
```

Expected: PASS。

### Task 5: 补齐 stop 后取消订阅测试

**Files:**

- Modify: `tests/main/tradingRiskEventRuntime/tradingRiskEventRuntime.business.test.ts`

- [ ] **Step 1: 增加 stop 后 seat 事件 listener 被取消订阅的测试**

先在 `tests/helpers/testDoubles.ts` 为测试替身增加返回类型，并暴露 listener 数量观察函数，供测试直接验证 unsubscribe 结果：

```ts
type SymbolRegistryDouble = SymbolRegistry &
  Readonly<{
    getSeatStateChangedListenerCount: () => number;
    getSeatVersionChangedListenerCount: () => number;
  }>;

export function createSymbolRegistryDouble(params?: {
  readonly monitorSymbol?: string;
  readonly longSeat?: SeatState;
  readonly shortSeat?: SeatState;
  readonly longVersion?: number;
  readonly shortVersion?: number;
}): SymbolRegistryDouble {
  // existing implementation
}
```

在返回对象中增加：

```ts
getSeatStateChangedListenerCount: () => seatStateChangedListeners.size,
getSeatVersionChangedListenerCount: () => seatVersionChangedListeners.size,
```

再在 `tests/main/tradingRiskEventRuntime/tradingRiskEventRuntime.business.test.ts` 增加测试：

```ts
it('unsubscribes from seat events after stopAndDrain', async () => {
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });
  const { deps } = createRuntimeDeps({ symbolRegistry });
  const runtime = createTradingRiskEventRuntime(deps);

  runtime.start();
  expect(symbolRegistry.getSeatStateChangedListenerCount()).toBe(1);
  expect(symbolRegistry.getSeatVersionChangedListenerCount()).toBe(1);

  await runtime.stopAndDrain();

  expect(symbolRegistry.getSeatStateChangedListenerCount()).toBe(0);
  expect(symbolRegistry.getSeatVersionChangedListenerCount()).toBe(0);
  expect(quoteUpdatedListener).toBeNull();
});
```

该测试直接证明 stop 后 state/version/quote 三类事件订阅都已释放，而不是只证明事件释放后没有副作用。

- [ ] **Step 2: 运行 TradingRiskEventRuntime 测试**

Run:

```bash
bun test tests/main/tradingRiskEventRuntime/tradingRiskEventRuntime.business.test.ts
```

Expected: PASS。

### Task 6: 全量验证

**Files:**

- No code changes beyond previous tasks.

- [ ] **Step 1: 运行格式化**

Run:

```bash
bun format
```

Expected: PASS，或自动格式化文件。

- [ ] **Step 2: 运行 lint**

Run:

```bash
bun lint
```

Expected: PASS。

- [ ] **Step 3: 运行类型检查**

Run:

```bash
bun type-check
```

Expected: PASS。

- [ ] **Step 4: 运行目标测试**

Run:

```bash
bun test tests/main/tradingRiskEventRuntime/tradingRiskEventRuntime.business.test.ts
```

Expected: PASS。

- [ ] **Step 5: 运行相关事件消费者测试**

Run:

```bash
bun test tests/main/quoteSubscriptionRuntime/quoteSubscriptionRuntime.business.test.ts tests/main/seatActivationDispatcher/seatActivationDispatcher.business.test.ts tests/main/autoSearchWakeupRuntime/autoSearchWakeupRuntime.business.test.ts tests/main/lifecycle/cacheDomains/seatDomain.test.ts
```

Expected: PASS。

## 8. 实现后的成功标准

完成后必须满足：

1. `TradingRiskEventRuntime` 的 quote handler 不调用 `buildTradingRiskRoutingIndex`。
2. freshness wait 前后不调用 `buildTradingRiskRoutingIndex`。
3. `buildTradingRiskRoutingIndex` 只在 runtime start、seat state changed、seat version changed 时执行。
4. `bumpSeatVersion` 发布不携带 `seatState` 的 `SeatVersionChangedEvent`，并同步传播 listener 错误。
5. seat state changed 后 cached route 立即更新。
6. version-only bump 后 cached route 的 `seatVersion` 立即更新，新 quote 使用新 seatVersion 执行。
7. stale route 在 freshness wait 后不会继续执行浮亏清仓，包括 seat state 变化和 version-only bump 两类失效来源。
8. duplicate trading symbol 在 cached index 刷新阶段 fail-fast。
9. cached index 刷新失败后必须清空缓存并记录 fatal error，后续 quote/freshness 不能继续使用旧 route。
10. 初始 refresh 失败时 `start()` 不得留下 `running=true` 或 quote/seat listener 订阅。
11. in-flight route 在 seat truth 变化后结束时必须基于有效 cached index 做 guarded cleanup。
12. 停止 runtime 后 quote/state/version 事件都不再被消费，listener count 回到 0。
13. `bun format`、`bun lint`、`bun type-check` 和目标测试全部通过。

## 9. 方案自检

### 覆盖 P0 要求

- quote 高频路径不 rebuild：Task 4 实现，Task 3 测试。
- runtime start 初始缓存：Task 4 Step 8。
- start 初始 refresh 失败不半启动：Task 3 Step 9，Task 4 Step 8。
- seat truth changed 刷新：Task 4 Step 8，Task 3 Step 3。
- seat version-only bump 刷新：Task 1/2 建事件边界，Task 3 Step 4/5。
- freshness wait 前后 current-route 校验：Task 4 Step 6/7。
- state changed during freshness 拦截旧 route：Task 3 Step 8。
- duplicate fail-fast 与缓存失效：Task 3 Step 7。
- quote/freshness 不额外投影：Task 3 Step 1/2。
- routeStates 清理：Task 4 Step 2 保留 prune，Task 4 Step 9 覆盖 in-flight finally cleanup。
- stop 后取消订阅：Task 5。

### 禁止方案检查

本方案没有：

- quote miss fallback rebuild。
- 定时 rebuild。
- 删除 current-route 校验。
- 缓存失效后静默使用旧 index。
- quote-path rebuild 兼容分支。
- 在各个 bump 调用点拼接通知。
- async queue、timer 或 deferred refresh。
- fatal 后继续使用旧 cached routing index。

### 类型与组织检查

- 新数据结构放在 `src/types/seat.ts`。
- autoSymbolManager 内部 listener 类型放在 `src/services/autoSymbolManager/types.ts`。
- runtime 行为仍由工厂函数创建。
- 无 `any`、无类型断言、无 re-export。
- 测试替身与真实接口同步更新。
