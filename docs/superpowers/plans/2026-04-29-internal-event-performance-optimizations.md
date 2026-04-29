# Internal Event Performance Optimizations Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. When editing TypeScript, also use the repository-required `typescript-project-specifications` skill. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变当前交易业务语义、不引入兼容双轨、不增加兜底轮询的前提下，优化内部事件链路中三个高收益性能点：任务队列结构、quote wakeup 反向索引、交易标的显示路由索引缓存。

**Architecture:** 保留现有事件 owner 和 truth owner：`SymbolRegistry` 仍是席位 truth owner，`QuoteClient` 仍是标准化行情事件源，`PostTradeConsistencyRuntime` 仍是 freshness owner，队列 processor 仍通过 `onTaskAdded -> setImmediate` 异步消费。优化只替换高频路径的数据结构与查找方式，不能改变 trigger source、route identity、seatVersion 复核、freshness gate 或 lifecycle stop/drain 语义。

**Tech Stack:** TypeScript strict mode、Bun test runner、现有 runtime factory 与依赖注入模式。

---

## File Structure

- Modify: `src/main/asyncProgram/tradeTaskQueue/index.ts`
  - 把数组 FIFO 的 `shift()` 消费改成 head-index queue 或小型 deque。
  - 保持 `push`、`pop`、`isEmpty`、`removeTasks`、`clearAll`、`onTaskAdded` 对外契约不变。
- Modify: `src/main/asyncProgram/monitorTaskQueue/index.ts`
  - 把 `scheduleLatest` 从全队列扫描替换成 `dedupeKey` 索引驱动。
  - 保持 replacement 日志、`removeTasks`、`clearAll`、`onTaskAdded` 语义不变。
- Modify: `src/main/asyncProgram/monitorTaskQueue/utils.ts`
  - 如继续复用现有 `removeTasksFromQueue`，需要确保它能处理新的内部队列表示；否则把删除逻辑收口进 queue 实现。
- Modify: `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
  - 为静态清仓 WAIT 的 `wakeupSymbols` 增加 `symbol -> monitorSymbol Set` 反向索引。
  - route mode 切换、WAIT 更新、stop/drain 时同步清理索引。
- Modify: `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
  - 为 `SYMBOL_QUOTE` wakeup 增加 `symbol -> routeKey Set` 反向索引。
  - 为 `ORDER_EVENT` wakeup 增加 `symbol -> routeKey Set` 反向索引。
  - freshness wakeup 和 retry timer 不进入 symbol 反向索引，避免过度抽象。
- Modify: `src/main/monitorQuoteEventRuntime/types.ts`
  - 如有必要，补充仅模块内部使用的索引类型，不能把索引暴露为业务接口。
- Modify: `src/main/tradingQuoteDisplayRuntime/index.ts`
  - 缓存 trading quote display 使用的 `TradingRiskRoutingIndex`。
  - 启动时构建，监听 `symbolRegistry.onSeatTruthChanged` 后刷新。
  - quote 到达和 async `getQuotes(...)` 后都使用缓存做 route current 校验。
- Modify: `src/main/tradingQuoteDisplayRuntime/types.ts`
  - `TradingQuoteDisplayRuntimeDeps.symbolRegistry` 需要保留 `onSeatTruthChanged` 端口；如果当前类型已覆盖则只更新注释。
- Modify tests:
  - `tests/main/asyncProgram/monitorTaskQueue/business.test.ts`
  - add or modify `tests/main/asyncProgram/tradeTaskQueue/business.test.ts`
  - `tests/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.business.test.ts`
  - `tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts`
  - `tests/main/tradingQuoteDisplayRuntime/business.test.ts`

---

## 0. Non-Goals

本计划不做以下事项：

1. 不把内部监听改成 JavaScript `Proxy`。
2. 不新增任何备用轮询、兼容旧路径或 fallback producer。
3. 不把 `PostTradeConsistencyRuntime` 的 freshness 语义移动到 quote runtime。
4. 不把 display runtime 变成核心业务链路的阻塞步骤。
5. 不统一所有 one-shot timer 到全局 scheduler；当前没有足够证据说明 timer 数量是瓶颈。
6. 不在本计划内处理 listener 异常隔离；那是稳定性小改，不是本轮性能主线。

---

## 1. Current Chain and Bottleneck Map

### 1.1 Queue Chain

当前买卖队列链路：

```text
runSignalPipeline / delayedSignalVerifier.onVerified
  -> buyTaskQueue.push(...) / sellTaskQueue.push(...)
  -> notifyTaskAddedCallbacks(...)
  -> processor onTaskAdded callback
  -> setImmediate(...)
  -> processQueue()
  -> queue.pop()
```

当前监控队列链路：

```text
timeDriverProgram / seatActivationDispatcher / switch handoff owner
  -> monitorTaskQueue.scheduleLatest(...)
  -> notifyTaskAddedCallbacks(...)
  -> monitorTaskProcessor queueRunner
  -> setImmediate(...)
  -> processQueue()
  -> queue.pop()
```

瓶颈点：

1. `pop()` 使用 `shift()`，队列越长搬移越多。
2. `monitorTaskQueue.scheduleLatest(...)` 通过扫描删除相同 `dedupeKey` 的旧任务。
3. 高频小任务下 `randomUUID()` 分配会放大成本；但是否改 ID 需要先确认测试和日志依赖。

### 1.2 Monitor Quote Wakeup Chain

当前 monitor quote 链路：

```text
quoteClient.onQuoteUpdated(event)
  -> monitorQuoteEventRuntime.handleQuoteUpdated(event)
  -> direct monitor quote route OR scan routeStates wakeupSymbols
  -> triggerRoute(monitorSymbol)
  -> processRouteQueue(...)
```

当前 switch wakeup 链路：

```text
quote / order / freshness / retry timer
  -> scan routeStates[].wakeups
  -> triggerRoute(routeKey, source)
  -> processRouteQueue(...)
```

瓶颈点：

1. quote 事件是高频事件源。
2. 当前 WAIT wakeup 匹配会扫描 routeStates。
3. route 数量、pending switch 数量和 wakeup 数量增加时，扫描成本线性放大。

### 1.3 Trading Quote Display Route Chain

当前交易标的显示链路：

```text
quoteClient.onQuoteUpdated(event)
  -> tradingQuoteDisplayRuntime.handleQuoteUpdated(event)
  -> buildTradingRiskRoutingIndex(...)
  -> resolveTradingRiskRoute(...)
  -> getQuotes([monitorSymbol])
  -> buildTradingRiskRoutingIndex(...)
  -> isTradingRiskRouteCurrent(...)
  -> renderTradingQuote(...)
```

瓶颈点：

1. display 是 quote 高频消费方。
2. routing index truth 只在 seat truth 变化时才需要更新，但当前每条 quote 都重建。
3. async 后复核必须保留，但复核不必每次重新构建完整 index。

---

## 2. Optimization 1: Queue Internal Data Structures

### 2.1 Business Boundary

队列优化只能改变内部存储结构，不能改变以下行为：

1. 买卖任务仍是 FIFO。
2. `monitorTaskQueue.scheduleLatest` 仍是同 `dedupeKey` 只保留最新任务。
3. `onTaskAdded` 仍在任务成功入队后触发。
4. `removeTasks(predicate, onRemove)` 仍必须对被移除任务逐个调用 `onRemove`。
5. `clearAll(onRemove)` 仍必须对队列内所有任务逐个调用 `onRemove`。
6. processor 仍通过 `setImmediate` 异步消费，不允许在 `push` / `scheduleLatest` 调用栈内直接执行业务。

### 2.2 Implementation Shape

#### TradeTaskQueue

内部可使用：

```text
items: Task[]
headIndex: number
```

规则：

1. `push` 追加到 `items`。
2. `pop` 返回 `items[headIndex]` 并递增 `headIndex`，不使用 `shift()`。
3. 当 `headIndex` 增长到足够大且超过数组一半时，压缩数组，避免长期保留旧引用。
4. `isEmpty` 判断 `headIndex >= items.length`。
5. `removeTasks` 只扫描 active slice，即 `[headIndex, items.length)`。
6. `clearAll` 只处理 active slice，然后清空数组并重置 head。

#### MonitorTaskQueue

推荐实现为 active queue + dedupe index：

```text
items: MonitorTask[]
headIndex: number
taskByDedupeKey: Map<string, MonitorTask>
cancelledIds: Set<string>
```

`scheduleLatest` 规则：

1. 如果 `taskByDedupeKey` 已有旧任务，把旧任务标记为 cancelled。
2. 创建新任务，写入 `taskByDedupeKey`，追加到 `items`。
3. `pop` 跳过 cancelled 或已被替换的旧任务，返回第一个仍是 `taskByDedupeKey[dedupeKey]` 的任务。
4. 任务被 `pop` 返回时，从 `taskByDedupeKey` 删除对应 dedupeKey。
5. `removeTasks` 扫描 active slice，对命中的有效任务执行 `onRemove`，并从 `taskByDedupeKey` 删除；被删除项可标记 cancelled，稍后由 `pop` 或 compaction 清理。
6. `clearAll` 对所有有效任务执行 `onRemove`，清空全部结构。

这条路线避免 `scheduleLatest` 为了替换旧任务而执行 `splice()`。

### 2.3 Semantic Risks

1. 旧任务被 replacement 后不能再被 `pop()` 消费。
2. `removeTasks` 不能漏掉已 replacement 但尚未物理压缩的旧任务的清理语义；旧任务已被 replacement 时通常已经不再是有效任务，不应重复 `onRemove`。
3. `SEAT_REFRESH replaced` 日志目前依赖 removed count；新实现需要在 replacement 发生时仍能记录 `replacedCount=1`。
4. 如果保留 `randomUUID()`，性能收益仍主要来自 `shift/splice`；如果改 ID，必须先确认没有外部依赖 UUID 格式。

### 2.4 Tests

- [ ] `tradeTaskQueue` FIFO：连续 push 3 个任务后 pop 顺序不变。
- [ ] `tradeTaskQueue.removeTasks`：只移除匹配任务，`onRemove` 调用次数准确。
- [ ] `tradeTaskQueue.clearAll`：只清理 active tasks，不重复处理已 pop 任务。
- [ ] `monitorTaskQueue.scheduleLatest`：同 dedupeKey 只 pop 最新任务。
- [ ] `monitorTaskQueue.scheduleLatest`：不同 dedupeKey 保持入队顺序。
- [ ] `monitorTaskQueue.removeTasks`：能移除尚未 pop 的有效任务，并更新 dedupe index。
- [ ] `monitorTaskQueue.clearAll`：清空 active queue、dedupe index、cancelled markers。
- [ ] `onTaskAdded`：replacement 入队仍触发一次 task added callback。

---

## 3. Optimization 2: Wakeup Reverse Indexes

### 3.1 Business Boundary

反向索引只是 route lookup 加速层，不是新的业务 truth。

必须保持：

1. `monitorQuoteEventRuntime` 的静态清仓 WAIT 仍由 `StaticLiquidationRuntimeResult.WAIT` 注册 `wakeupSymbols`。
2. `quoteSubscriptionRuntime.retainSymbols(...)` / `releaseRetain(...)` 仍由 WAIT 状态维护。
3. `SwitchWakeupRuntime` 的 route identity 仍是 `monitorSymbol + direction + seatVersion`。
4. 每次合法 wakeup 后仍重新读取当前权威 `monitorContext`、seat state、positions 和 freshness 状态。
5. `retryTimer` 和 freshness 事件仍按当前 owner 触发，不为了索引统一而改成 symbol 事件。

### 3.2 MonitorQuoteEventRuntime Index

新增模块内部结构：

```text
staticWakeupsBySymbol: Map<string, Set<string>>
```

其中 key 是 `wakeupSymbol`，value 是 `monitorSymbol Set`。

更新点：

1. route mode 从 `STATIC_LIQUIDATION` 切换到 `DISTANCE_SWITCH` 时：
   - 清 route retry timer。
   - 释放 retain。
   - 从 `staticWakeupsBySymbol` 删除该 monitorSymbol 的旧 wakeup 注册。
2. `updateStaticLiquidationWaitState(...)` 收到 WAIT 时：
   - 先删除该 monitorSymbol 旧 wakeups。
   - 写入新的 `routeState.wakeupSymbols`。
   - 为每个 wakeupSymbol 添加 `staticWakeupsBySymbol[wakeupSymbol].add(monitorSymbol)`。
   - 继续执行 retain 和 retry timer 逻辑。
3. WAIT 结束、NOOP/COMPLETED、stopAndDrain 时：
   - 删除该 monitorSymbol 的 wakeup 索引。
   - 释放 retain。
4. `handleQuoteUpdated(event)`：
   - 直接 monitor quote route 逻辑保持不变。
   - 对静态 WAIT 唤醒，不再扫描全部 routeStates，改为读取 `staticWakeupsBySymbol.get(event.symbol)`。

### 3.3 SwitchWakeupRuntime Index

新增模块内部结构：

```text
quoteWakeupsBySymbol: Map<string, Set<SwitchWakeupRouteKey>>
orderWakeupsBySymbol: Map<string, Set<SwitchWakeupRouteKey>>
```

更新点：

1. handoff 或 route wakeups 更新时：
   - 先移除 routeKey 的旧 quote/order 索引。
   - 遍历当前 `routeState.wakeups`：
     - `SYMBOL_QUOTE` 写入 `quoteWakeupsBySymbol`。
     - `ORDER_EVENT` 的 symbols 写入 `orderWakeupsBySymbol`。
     - `FRESHNESS` 不写 symbol index。
     - `RETRY_TIMER` 仍由 timer handle 直接触发 route。
2. `handleQuoteUpdated(symbol)`：
   - 查 `quoteWakeupsBySymbol.get(symbol)`，只触发命中的 routeKey。
3. `handleOrderStateChanged(symbol)`：
   - `symbol === null` 时保守处理：只能触发现有含 ORDER_EVENT wakeup 的 route，或直接返回，需按当前业务测试确认。
   - `symbol !== null` 时查 `orderWakeupsBySymbol.get(symbol)`。
4. route 完成、失败、stopAndDrain、版本失效时：
   - 删除该 routeKey 在全部索引中的注册。
   - 清 retry timer。
   - 释放 quote retain。

### 3.4 Semantic Risks

1. 不允许只用 `direction + seatVersion` 做 key；多 monitor 并发会串 route。
2. 索引必须跟 `routeState.wakeups` 同步更新，否则会出现漏唤醒或 stale wakeup。
3. stopAndDrain 后不得留下旧 routeKey；否则下一次 start 可能被旧事件唤醒。
4. order event 的 `symbol` 如果为空，不能猜测 symbol；必须按现有事件契约处理。

### 3.5 Tests

- [ ] `monitorQuoteEventRuntime`：WAIT 注册两个 wakeupSymbols 后，只有对应 quote 触发 route。
- [ ] `monitorQuoteEventRuntime`：WAIT 更新 wakeupSymbols 后，旧 symbol 不再触发，新 symbol 触发。
- [ ] `monitorQuoteEventRuntime`：mode 切换到 DISTANCE_SWITCH 后，旧静态 WAIT 索引清空。
- [ ] `monitorQuoteEventRuntime`：stopAndDrain 后 quote 不再触发旧 WAIT route。
- [ ] `switchWakeupRuntime`：SYMBOL_QUOTE wakeup 只唤醒匹配 symbol 的 route。
- [ ] `switchWakeupRuntime`：ORDER_EVENT wakeup 只唤醒匹配 symbol 的 route。
- [ ] `switchWakeupRuntime`：handoff 更新 wakeups 后旧索引失效。
- [ ] `switchWakeupRuntime`：route 版本失效或 stopAndDrain 后索引完全清理。

---

## 4. Optimization 3: Trading Quote Display Routing Index Cache

### 4.1 Business Boundary

display runtime 是 best-effort side effect，不能成为业务 truth owner。

必须保持：

1. display 消费 `quoteClient.onQuoteUpdated(...)` 标准化事件。
2. display route truth 仍来自 `buildTradingRiskRoutingIndex(...)` 和 `isTradingRiskRouteCurrent(...)`。
3. seat truth 变化后必须刷新缓存。
4. async `getQuotes([monitorSymbol])` 之后必须再次复核 route current，不能打印旧 seatVersion。
5. display failure 只能 warn，不能阻断风险执行、信号生成、seat sync 或 freshness。

### 4.2 Implementation Shape

在 `createTradingQuoteDisplayRuntime` 内新增：

```text
cachedRoutingIndex: TradingRiskRoutingIndex | null
routingIndexFatalError: Error | null
unsubscribeSeatTruthChanged: (() => void) | null
```

规则：

1. `start()`：
   - 构建一次 routing index。
   - 注册 `symbolRegistry.onSeatTruthChanged(...)`。
   - 注册 `marketDataClient.onQuoteUpdated(...)`。
2. `handleSeatTruthChanged()`：
   - 重新构建 routing index。
   - prune 不再活跃且未 in-flight 的 display route state。
   - 构建失败时进入 fatal 状态，后续 quote display 返回，不使用旧缓存。
3. `handleQuoteUpdated(event)`：
   - gate 未开时返回。
   - 从缓存 index 查 route。
   - 命中后进入原有 route-level single-flight。
4. `processRoute(routeKey)`：
   - async `getQuotes([route.monitorSymbol])` 后，读取当前缓存 index。
   - 使用 `isTradingRiskRouteCurrent(route, cachedRoutingIndex)` 复核。
   - 若缓存 fatal 或 route stale，返回。
5. `stopAndDrain()`：
   - 取消 quote listener。
   - 取消 seat truth listener。
   - 等待 active promises。
   - 清 routeStates、cachedRoutingIndex、fatal error。

### 4.3 Semantic Risks

1. 不能把 `TradingRiskEventRuntime` 的内部缓存直接共享给 display，除非后续单独抽象 shared owner。本计划只在 display 内本地缓存。
2. 缓存刷新失败时不能继续使用旧 index，否则 seat ownership 可能过期。
3. async 后如果期间 seat truth 变化，必须由 current-route 校验拦截旧 route。
4. display cache 不得影响 `TradingRiskEventRuntime` 的风险执行缓存。

### 4.4 Tests

- [ ] start 时构建 routing index，quote 命中 ACTIVE route 后渲染。
- [ ] seat truth changed 后新 symbol quote 能渲染，旧 symbol quote 不渲染。
- [ ] `getQuotes` await 期间 seatVersion 改变，最终不渲染旧 route。
- [ ] routing index 构建失败后不使用旧 cache 渲染。
- [ ] stopAndDrain 后 quote listener 和 seat truth listener 都被注销。

---

## 5. Implementation Order

- [ ] **Task 1: Queue performance tests first**
  - Add/adjust queue tests to lock existing semantics.
  - Verify tests fail only where new performance behavior is not implemented yet.

- [ ] **Task 2: Implement queue internal structure changes**
  - Update `tradeTaskQueue`.
  - Update `monitorTaskQueue`.
  - Keep public APIs unchanged.
  - Run queue tests.

- [ ] **Task 3: Add monitor quote WAIT reverse-index tests**
  - Cover static liquidation WAIT registration, update, cleanup, stopAndDrain.
  - Cover switch wakeup quote/order index behavior.

- [ ] **Task 4: Implement wakeup reverse indexes**
  - Update `monitorQuoteEventRuntime`.
  - Update `switchWakeupRuntime`.
  - Run monitor quote runtime tests.

- [ ] **Task 5: Add trading quote display routing-cache tests**
  - Cover startup cache, seat truth refresh, async stale route, fatal cache failure, stopAndDrain cleanup.

- [ ] **Task 6: Implement trading quote display routing cache**
  - Add local cache and seat truth listener.
  - Preserve post-async route validation.
  - Run display runtime tests.

- [ ] **Task 7: Full verification**
  - Run targeted tests first:

```bash
bun test tests/main/asyncProgram/monitorTaskQueue/business.test.ts
bun test tests/main/asyncProgram/tradeTaskQueue/business.test.ts
bun test tests/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.business.test.ts
bun test tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts
bun test tests/main/tradingQuoteDisplayRuntime/business.test.ts
```

- Then run project checks:

```bash
bun run lint
bun run type-check
bun test
```

---

## 6. Acceptance Criteria

1. No business trigger source changes:
   - quote still comes from `quoteClient.onQuoteUpdated(...)`.
   - seat truth still comes from `symbolRegistry`.
   - freshness still comes from `postTradeConsistencyRuntime`.
   - queue processors still consume through `setImmediate`.
2. No compatibility dual-track:
   - no old scan path kept alongside new reverse index for the same wakeup family.
   - no new periodic fallback scan.
3. Queue behavior remains externally identical:
   - FIFO for trade queue.
   - latest-only by `dedupeKey` for monitor queue.
   - cleanup callbacks preserved.
4. Route identity remains complete:
   - switch route key includes `monitorSymbol + direction + seatVersion`.
   - display route post-async validation remains active.
5. Lifecycle cleanup is complete:
   - stopAndDrain clears queue runner handles, route indexes, listeners, retains and timers already owned by each runtime.
6. Verification commands pass.

---

## 7. Expected Performance Effect

1. Queue optimization removes `shift()` array movement and most `scheduleLatest` scanning from high-frequency task paths.
2. Wakeup reverse indexes turn quote/order event matching from `O(routeStates * wakeups)` into `O(matchedRoutes)` for symbol-scoped wakeups.
3. Trading quote display routing cache removes repeated full routing-index rebuilds from the per-quote display path and limits rebuilds to seat truth changes.

These are structural improvements in hot paths. They do not promise lower broker/API latency; they reduce local JavaScript allocation, scanning and redundant routing work.
