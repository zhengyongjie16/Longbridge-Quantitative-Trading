# 内部事件性能优化重构复核记录

**日期:** 2026-04-29

**复核对象:** `docs/superpowers/plans/2026-04-29-internal-event-performance-optimizations.md` 对应的队列结构、wakeup 反向索引、交易标的显示路由缓存实现。

## 结论

本轮复核没有确认到会改变交易业务动作的缺陷：买卖任务仍保持 FIFO，监控任务仍保持同 `dedupeKey` 最新任务语义，静态清仓与 pending switch wakeup 仍由原 owner 推进，交易标的显示仍是 best-effort side effect。

本轮确认的问题有两个，均已按最小范围修复，且不改变交易业务动作语义。

## Issue 1: `monitorTaskQueue.removeTasks` 在清空有效任务后可能长期保留 tombstone

**严重级别:** Minor

**位置:** `src/main/asyncProgram/monitorTaskQueue/index.ts`

**修复状态:** 已修复。

**证据:**

- `scheduleLatest` 替换旧任务时只把旧任务写入 `cancelledTaskIds`，旧任务仍留在 `items` 中。
- `removeTasks` 命中有效任务后同样只写入 `cancelledTaskIds` 并从 `taskByDedupeKey` 删除。
- `removeTasks` 末尾调用 `compactQueue()`，但 `compactQueue()` 在 `headIndex === 0` 时直接返回。
- `isEmpty()` 只看 `taskByDedupeKey.size`。当 `removeTasks` 删除了最后一个有效任务后，队列对外已空，processor 不会再 `pop()`，但 `items` 与 `cancelledTaskIds` 仍持有已取消任务对象。

**业务判断:**

这不会导致被取消任务再次执行，因为 `pop()` 会校验 `isEffectiveTask(...)`。问题在于性能优化路径本身留下了长期引用：如果 seat cleanup 或生命周期门禁期间反复调度后又被 `removeTasks` 清掉，且没有后续 `pop()` 或 `clearAll()`，内部数组会积累无效任务。这与本轮“减少 hot path 扫描和引用保留”的优化目标不完全一致。

**修复方式:**

`removeTasks` 删除有效任务后重建待消费切片，只保留仍由 `taskByDedupeKey` 指向且未取消的有效任务，并清空 `cancelledTaskIds`。该修复不会对 replacement 旧任务重复调用 `onRemove`，也不会改变未移除任务的 FIFO 顺序。

## Issue 2: 新增关键索引 helper 缺少 `typescript-project-specifications` 要求的中文函数注释

**严重级别:** Minor

**位置:**

- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
- `src/main/tradingQuoteDisplayRuntime/index.ts`

**修复状态:** 已修复。

**证据:**

新增的索引维护函数负责 wakeup 注册、删除和缓存读取，属于事件路由正确性的关键辅助函数；修复前缺少 JSDoc，例如：

- `addMonitorSymbolToStaticWakeupIndex(...)`
- `removeMonitorSymbolFromStaticWakeupIndex(...)`
- `removeStaticWakeupIndexes(...)`
- `registerStaticWakeupIndexes(...)`
- `addRouteKeyToSymbolIndex(...)`
- `removeRouteKeyFromSymbolIndex(...)`
- `removeRouteWakeupIndexes(...)`
- `registerRouteWakeupIndexes(...)`
- `rebuildRoutingIndex(...)`
- `getCurrentRoutingIndex(...)`

**业务判断:**

这不影响运行行为，`bun run lint` 与 `bun run type-check` 也不会捕获它。但按当前仓库 `typescript-project-specifications`，核心业务流程、状态机迁移、生命周期处理、异步队列处理等关键函数需要中文函数注释说明职责和副作用。本轮新增 helper 正处在事件唤醒索引与显示路由缓存的关键链路上，严格验收时应补齐。

**修复方式:**

为上述 helper 补充中文 JSDoc，说明注册、删除、重建或读取派生索引的职责与参数；仅补齐规范说明，不改 runtime 行为。

## 已二次确认但不记录为缺陷的点

1. `AUTO_SYMBOL_TICK` 仍存在，但它不属于本次 `docs/superpowers/...internal-event-performance-optimizations.md` 的目标范围；它属于另一份事件驱动主链路优化计划的后续阶段，不能在本轮误判为未完成。
2. `switchWakeupRuntime` 对 `symbol === null` 的订单事件直接返回。当前 pending switch 的 `ORDER_EVENT` wakeup 是 symbol 粒度，真实 tracked order 结算事件会携带 symbol；不扫描所有 route 是合理的最短路径，不属于兜底缺失。
3. `tradingQuoteDisplayRuntime` 没有在 seat truth 变化时显式 prune `routeStates`，但 route key 数量受 `monitorSymbol + direction` 限制，且渲染前仍用缓存索引做 route current 校验；未确认会导致旧 seatVersion 输出或交易行为偏移。

## 验证记录

已通过：

```powershell
bun format
bun test tests/main/asyncProgram/monitorTaskQueue/business.test.ts tests/main/asyncProgram/tradeTaskQueue/business.test.ts tests/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.business.test.ts tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts tests/main/tradingQuoteDisplayRuntime/business.test.ts
git diff --check
bun run lint
bun run type-check
bun test
```

结果：

- targeted tests: 42 pass, 0 fail
- full test suite: 810 pass, 0 fail
- lint/type-check: pass
