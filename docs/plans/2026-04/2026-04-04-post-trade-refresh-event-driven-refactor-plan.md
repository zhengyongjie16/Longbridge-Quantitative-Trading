# 成交后一致性运行时系统性重构方案（2026-04-04）

## 1. 文档目的

本文档不再讨论“在现有结构上加一个桥接通道”的最短路径改法，而是给出一份**系统性重构方案**。

本次重构只解决一个问题：

- 成交后刷新当前被拆散在 `settlementFlow`、`mainProgram`、`postTradeRefresher`、`signalRuntimeDomain` 四处，对象所有权与生命周期不一致。

目标是把这条链路重构为一个独立运行时域：

- `成交终态结算 -> 成交后一致性运行时接收刷新需求 -> 串行刷新 -> 推进 freshness`

本文档采用 fail-fast 原则：

1. 不保留主循环兜底。
2. 不保留双轨触发。
3. 不保留兼容接口。
4. 若启动顺序或生命周期顺序破坏本方案约束，直接抛错，不做静默降级。

---

## 2. 名词解释

## 2.1 成交后一致性

这里的“成交后一致性”指成交发生后，系统必须重新建立的一组事实：

1. 账户缓存是新的。
2. 持仓缓存是新的。
3. `positionCache` 是新的。
4. R1/N1 是基于最新订单记录重新计算过的。
5. 保护性清仓完成判定已经按最新持仓状态推进。
6. `waitForFresh()` 的等待方只会在以上动作完成后被放行。

## 2.2 成交后一致性运行时

这里新增一个独立对象，建议命名为：

- `PostTradeConsistencyRuntime`
- 中文含义：成交后一致性运行时

它不是通用事件总线，也不是主循环附属处理器，而是“成交后刷新”这条业务链路的唯一所有者。

## 2.3 结算流

这里的“结算流”指订单进入终态后的本地后置处理流程，对应：

- `src/core/trader/orderMonitor/settlementFlow.ts`

它负责识别真实成交、更新本地订单记录、记录亏损偏移和保护性清仓进度。

## 2.4 freshness 门禁

这里指当前的 `RefreshGate`，作用是：

1. 成交后先 `markStale()`。
2. 刷新完成后再 `markFresh(version)`。
3. 其他处理器通过 `waitForFresh()` 等待数据恢复一致。

系统性重构后，`RefreshGate` 仍保留，但不再作为分散对象暴露给多个模块随意操作，而是由 `PostTradeConsistencyRuntime` 内部统一拥有并推进。

---

## 3. 再次复核后的最终结论

## 3.1 可行性结论

该系统性重构**可行**。

原因如下：

1. 当前业务能力都已存在，只是归属分散：
   - 成交终态识别已存在
   - 刷新账户/持仓/R1/N1 的执行逻辑已存在
   - `RefreshGate` 已存在
   - 生命周期启停已存在
2. 本次不改交易规则，不改风控算法，不改主循环行情处理，只重构成交后一致性链路的对象所有权。
3. 当前系统明确存在“事件先发生、刷新器后可用”的窗口，因此把整条链路重构为一个运行时域在逻辑上更自然。

## 3.2 合理性结论

该系统性重构**合理**。

原因如下：

1. 成交后刷新本质上不是主循环节拍任务，而是一致性恢复任务。
2. 让主循环承担成交后刷新触发属于错误分层。
3. 让 lifecycle 自行决定何时 `markFresh`，而刷新 worker 自行决定何时 `markFresh`，属于语义分裂。
4. 把“成交事件入口 + pending 队列 + 刷新执行器 + freshness 门禁 + 生命周期语义”收口到一个运行时域，是当前问题的正确抽象。

## 3.3 本次明确不采用补丁式重构

本次不采用以下方案：

1. 只把 `enqueue` 从主循环挪到 `settlementFlow`。
2. 给现有 `postTradeRefresher` 外面再包一层兼容通道。
3. 保留主循环排空作为隐藏兜底。
4. 保留 `getAndClearPendingRefreshSymbols()` 但不再使用。
5. 继续让 `signalRuntimeDomain` 和 `runApp` 直接调用 `refreshGate.markFresh(...)`。

原因：

1. 这些都没有解决对象所有权分裂。
2. 这些都保留了新的误用入口。
3. 这些都不符合 fail-fast 原则。

---

## 4. 当前结构的根本问题

## 4.1 触发责任放错了层级

当前真实链路是：

1. `settlementFlow` 在成交后 `markStale()` 并写入 `pendingRefreshSymbols`
2. `mainProgram` 下一轮循环排空 pending
3. `postTradeRefresher` 才开始刷新

这意味着：

1. 成交事件产生的位置是正确的。
2. 刷新真正触发的位置是错误的。
3. 这条链路被主循环节拍无意义地延迟了一拍。

## 4.2 一致性门禁没有唯一所有者

当前 `markFresh` 可能发生在两类地方：

1. `postTradeRefresher` 刷新成功后
2. 启动重建或开盘重建完成后，由 `runApp` 或 `signalRuntimeDomain` 手动推进

这会导致一个结构性问题：

1. 刷新 worker 负责“真实刷新后 fresh”
2. lifecycle 又负责“重建完成后 fresh”
3. 但两者不知道对方是否还有待处理成交刷新

当前代码里已经存在这个风险：

1. `runApp` 在启动重建后直接 `markFresh`
2. `signalRuntimeDomain.openRebuild()` 在重启 `postTradeRefresher` 后直接 `markFresh`

只要这两个地方与成交待刷新队列不同步，就会提前放行 `waitForFresh()`。

## 4.3 刷新队列放错了所有者

当前 `pendingRefreshSymbols` 放在 `OrderMonitor.runtime` 内部。

这是错误归属，因为：

1. `OrderMonitor` 的职责是订单事件追踪与结算，不是成交后一致性管理。
2. `pendingRefreshSymbols` 其实属于“成交后一致性运行时状态”，不属于订单监控运行态。
3. 恢复流 `resetRecoveryTrackingState()` 现在还会清它，这使“订单恢复逻辑”能误伤“成交刷新队列”。

## 4.4 现有 `postTradeRefresher` 所有权也不正确

当前 `postTradeRefresher` 被放在 `AsyncRuntime` 中，像普通异步处理器一样管理。

这并不准确。

普通异步处理器的特征是：

1. 主动消费任务队列。
2. 停启由 runtime 统一管理。
3. 不拥有全局 freshness 语义。

而 `postTradeRefresher` 实际上：

1. 不是普通业务处理器，而是成交后一致性恢复器。
2. 它影响 `waitForFresh()`。
3. 它与启动重建、开盘重建有强耦合。

因此它应从 `AsyncRuntime` 中移出，升级为独立运行时域。

---

## 5. 目标设计

## 5.1 目标对象

新增：

- `src/app/runtime/createPostTradeConsistencyRuntime.ts`

创建后得到：

- `PostTradeConsistencyRuntime`

该对象统一拥有以下职责：

1. 接收成交后刷新需求。
2. 维护 pending 刷新集合。
3. 内部拥有 `RefreshGate`。
4. 串行执行刷新。
5. 在刷新成功后推进 freshness。
6. 在失败时保留 pending 并重试。
7. 在启动和开盘重建后决定何时允许进入 fresh 状态。
8. 对外提供等待 freshness 的唯一入口。

## 5.2 运行时域边界

重构后，成交后一致性链路的职责边界固定如下：

### `settlementFlow`

只负责：

1. 识别成交事实。
2. 更新本地订单记录。
3. 更新亏损偏移。
4. 推进保护性清仓进度原始记录。
5. 调用 `postTradeConsistencyRuntime.recordSettlementRefreshNeed(...)`。

### `PostTradeConsistencyRuntime`

只负责：

1. `markStale()`
2. 合并 pending 刷新请求
3. 串行刷新账户/持仓/R1/N1
4. 推进保护性清仓完成判定
5. 失败重试
6. `markFresh(targetVersion)`
7. 启动/重建后 fresh 基线推进

### `mainProgram`

不再负责：

1. 获取并清空 pending refresh
2. 调用 `postTradeRefresher.enqueue(...)`
3. 以任何形式触发成交后刷新

### `lifecycle`

只负责控制该运行时域的生命周期：

1. `stopAndDrain()`
2. `midnightClear()`
3. `start()`
4. `completeRebuildBaseline()`

不能再直接操作 `refreshGate`。

## 5.3 fail-fast 约束

本运行时必须具备以下硬约束：

1. 若在 `Trader` 绑定完成前启动运行时，直接抛错。
2. 若在未完成 `monitorContexts` 装配前实际执行刷新，直接抛错。
3. 若 lifecycle 或启动流程绕过运行时直接操作 `refreshGate`，视为架构违规，必须删除该路径。
4. 若系统仍保留任何 `getAndClearPendingRefreshSymbols()` 调用，视为方案未完成。

---

## 6. 详细重构方案

## 6.1 Phase 1：新增 `PostTradeConsistencyRuntime`

### 新增文件

- `src/app/runtime/createPostTradeConsistencyRuntime.ts`
- 如有必要：`src/app/runtime/postTradeConsistencyRuntimeTypes.ts`

### 对外接口

建议公开接口如下：

1. `recordSettlementRefreshNeed(pending: ReadonlyArray<PendingRefreshSymbol>): void`
2. `waitForFresh(): Promise<void>`
3. `getStatus(): { currentVersion: number; staleVersion: number }`
4. `start(): void`
5. `stopAndDrain(): Promise<void>`
6. `midnightClear(): void`
7. `completeRebuildBaseline(): void`

### 接口语义

#### `recordSettlementRefreshNeed(...)`

行为固定为：

1. 先 `markStale()`
2. 合并 pending 请求
3. 若运行时已启动且当前不在 flight，则立即调度刷新
4. 若运行时未启动，则只积压 pending，不触发刷新

#### `start()`

行为固定为：

1. 标记运行时进入可执行状态
2. 若当前已有 pending 请求，则立即调度
3. 若 `Trader` 尚未绑定，则直接抛错
4. 若 `monitorContexts` 尚未完成装配，则直接抛错

#### `completeRebuildBaseline()`

这是系统性重构的关键接口。

它表示：

- “启动重建或开盘重建已经完成，当前缓存基线已是新鲜快照，请由成交后一致性运行时决定能否进入 fresh”

它的行为固定为：

1. 若当前存在 pending 请求，什么都不做
2. 若当前存在 in-flight 刷新，什么都不做
3. 只有在 pending 为空且没有 in-flight 时，才把 `currentVersion` 推到当前 `staleVersion`

这样可以彻底删除：

1. `runApp` 里手工 `markFresh(...)`
2. `signalRuntimeDomain.openRebuild()` 里手工 `markFresh(...)`

## 6.2 Phase 2：将 `RefreshGate` 收入该运行时域

### 修改文件

- `src/app/runtime/createPostGateRuntime.ts`
- `src/app/types.ts`
- `src/utils/refreshGate/index.ts`
- 相关消费方类型文件

### 目标调整

当前 `refreshGate` 作为独立对象挂在 `postGateRuntime` 上。

重构后改为：

1. `PostTradeConsistencyRuntime` 内部创建并拥有 `RefreshGate`
2. `postGateRuntime` 暴露的是 `postTradeConsistencyRuntime`
3. 外部等待 freshness 的模块改为依赖 `postTradeConsistencyRuntime.waitForFresh`

### 为什么必须内收

因为当前问题的根源之一就是：

1. queue 在一处
2. gate 在另一处
3. worker 在第三处
4. lifecycle 在第四处

系统性重构必须把 queue、gate、worker 收到同一所有者名下。

## 6.3 Phase 3：调整创建顺序，先建一致性运行时，再建 Trader

### 修改文件

- `src/app/runtime/createPostGateRuntime.ts`
- `src/core/trader/index.ts`
- `src/core/trader/types.ts`

### 新的创建顺序

在 `createPostGateRuntime()` 中调整为：

1. 创建 `dailyLossTracker`
2. 创建 `protectiveLiquidationEpisodeTracker`
3. 创建 `monitorContexts` 空 Map
4. 创建 `lastState`
5. 创建 `postTradeConsistencyRuntime`
6. 创建 `Trader`
7. 将 `recordSettlementRefreshNeed` 注入 `Trader -> OrderMonitor -> settlementFlow`
8. 完成 `postGateRuntime` 组装

### 关于 `Trader` 依赖的处理

`PostTradeConsistencyRuntime` 需要在执行刷新时访问 `Trader`，而 `Trader` 又需要在创建 `OrderMonitor` 时拿到 `recordSettlementRefreshNeed`。

这是一个明确的装配环。

本次方案的正确处理方式是：

1. `PostTradeConsistencyRuntime` 在创建时接收 `getTrader: () => Trader`
2. 在 `createPostGateRuntime()` 内部先声明 `let traderRef: Trader | null = null`
3. 运行时的 `getTrader()` 在 `traderRef === null` 时直接抛错
4. `Trader` 创建完成后立即赋值给 `traderRef`

这是本方案唯一允许的构造时闭环打结方式。

它不是兜底，也不是兼容逻辑，因为：

1. 订单监控在 `initializeOrderMonitor()` 之前不会产生事件
2. `start()` 又要求 `Trader` 已绑定，否则直接抛错
3. 因此该闭环在运行时是可验证且 fail-fast 的

## 6.4 Phase 4：让 `settlementFlow` 只向运行时报告刷新需求

### 修改文件

- `src/core/trader/orderMonitor/settlementFlow.ts`
- `src/core/trader/orderMonitor/types.ts`
- `src/core/trader/types.ts`

### 修改内容

将当前：

1. `refreshGate?.markStale()`
2. `runtime.pendingRefreshSymbols.push(...)`

改为：

1. `postTradeConsistencyRuntime.recordSettlementRefreshNeed([{ symbol, isLongSymbol, refreshAccount: true, refreshPositions: true }])`

### 重要约束

`settlementFlow` 不再允许知道：

1. pending 队列放在哪里
2. freshness 版本如何推进
3. 是否需要重试
4. worker 是否已启动

它只能报告事实：

- “这笔终态结算产生了成交后刷新需求”

## 6.5 Phase 5：删除 `pendingRefreshSymbols` 旧结构

### 修改文件

- `src/core/trader/orderMonitor/index.ts`
- `src/core/trader/orderMonitor/types.ts`
- `src/core/trader/orderMonitor/recoveryFlow.ts`
- `src/core/trader/index.ts`
- `src/core/trader/types.ts`
- `src/types/services.ts`
- `src/main/mainProgram/index.ts`

### 必删内容

1. `OrderMonitor.runtime.pendingRefreshSymbols`
2. `OrderMonitor.getAndClearPendingRefreshSymbols()`
3. `Trader.getAndClearPendingRefreshSymbols()`
4. 所有注释中关于“主循环排空刷新队列”的描述
5. `mainProgram` 里两处 `postTradeRefresher.enqueue(...)`

### 这一步必须做彻底

若还保留这些结构，会导致：

1. 新旧队列双轨并存
2. 语义来源不唯一
3. 恢复流误清理错误对象

这不允许。

## 6.6 Phase 6：将现有 `postTradeRefresher` 内核并入运行时

### 修改文件

- `src/main/asyncProgram/postTradeRefresher/index.ts`
- `src/main/asyncProgram/postTradeRefresher/types.ts`
- `src/app/runtime/createAsyncRuntime.ts`
- `src/app/types.ts`

### 目标调整

当前 `postTradeRefresher` 是 `AsyncRuntime` 的一员。

重构后：

1. `postTradeRefresher` 这个顶层对象不再作为独立 async processor 暴露
2. 其核心逻辑迁入 `PostTradeConsistencyRuntime`
3. `AsyncRuntime` 不再持有 `postTradeRefresher`

### 运行时内部刷新顺序

执行顺序固定为：

1. 刷新账户缓存
2. 刷新持仓缓存并更新 `positionCache`
3. 推进保护性清仓完成判定
4. 对 `pending` 中仍能归属到 monitor context 的 symbol 调用 `refreshUnrealizedLossData(...)`，统一传 `null quote`
5. 若全部成功，则 `markFresh(targetVersion)`
6. 若任一步失败，则保留 pending 与 targetVersion，并按既有节奏重试

### 本次明确不做

1. 不获取行情
2. 不展示账户持仓
3. 不保留 `enqueue(...)` 接口

## 6.7 Phase 7：统一等待方依赖，去掉对裸 `refreshGate` 的直接依赖

### 修改文件

- `src/main/asyncProgram/sellProcessor/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/helpers/seatSnapshot.ts`
- 相关 types 文件

### 修改原则

等待 freshness 的模块不再依赖裸 `refreshGate`，而改为依赖：

1. `postTradeConsistencyRuntime.waitForFresh`
2. 如确有需要，再依赖 `postTradeConsistencyRuntime.getStatus`

### 这样做的原因

因为系统性重构要求 freshness 语义由单一运行时拥有。

如果等待方仍直接拿裸 gate，对象所有权又会被重新拆散。

## 6.8 Phase 8：统一启动路径

### 修改文件

- `src/app/runApp.ts`
- `src/app/types.ts`

### 新的启动顺序

1. 创建 `postGateRuntime`
2. 创建 monitor contexts
3. 执行 `rebuildTradingDayState(...)`
4. 调用 `postTradeConsistencyRuntime.start()`
5. 调用 `postTradeConsistencyRuntime.completeRebuildBaseline()`
6. 启动其他 async processors
7. 进入主循环

### `startupRebuildPending` 分支的强约束

若启动快照失败，进入 `startupRebuildPending` 路径时，规则固定为：

1. `runApp` 不执行 `postTradeConsistencyRuntime.start()`
2. `runApp` 不执行 `completeRebuildBaseline()`
3. `runApp` 不启动任何运行态 async processors
4. 运行时保持“可接收刷新需求但不可执行刷新”的停止态
5. 等待后续 lifecycle 完成首次 `openRebuild()` 后，再由 lifecycle 执行 `start() + completeRebuildBaseline()`，并启动其他 async processors

原因：

1. 启动快照失败时，当前缓存基线尚未被证明有效。
2. 若此时提前启动成交后一致性运行时，可能会在错误基线上执行刷新。
3. 若此时提前启动其他 async processors，则会形成“系统处于待重建态，但部分运行时已被提前放行”的半状态。
4. fail-fast 原则要求“先建立正确基线，再允许任何依赖该基线的运行态处理器进入执行态”。

### 必须删除

删除：

1. `runApp` 中启动重建后手工 `refreshGate.markFresh(...)`

### 为什么这里必须这样改

因为启动重建完成后是否真的可以 fresh，不应由 `runApp` 判断，而应由成交后一致性运行时根据以下事实统一判断：

1. 当前是否仍有 pending 成交刷新
2. 当前是否有 in-flight 刷新

并且在 `startupRebuildPending` 分支中，`runApp` 必须完全跳过这两个动作，不能做“先 start、后等待重建”的折中处理。

同理，`runApp` 也不能在该分支中提前启动其他 async processors，不能依赖 `isTradingEnabled=false` 让它们“空转等待”。

## 6.9 Phase 9：统一 lifecycle 路径

### 修改文件

- `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
- `src/main/lifecycle/cacheDomains/types.ts`
- `src/app/createLifecycleRuntime.ts`

### 午夜清理

顺序固定为：

1. 先停止所有可能等待 `waitForFresh()` 的异步处理器
2. 再停止 `postTradeConsistencyRuntime.stopAndDrain()`
3. 清空交易任务队列
4. 取消延迟验证
5. `postTradeConsistencyRuntime.midnightClear()`
6. 清理其他缓存

具体顺序建议为：

1. `buyProcessor.stopAndDrain()`
2. `sellProcessor.stopAndDrain()`
3. `monitorTaskProcessor.stopAndDrain()`
4. `orderMonitorWorker.stopAndDrain()`
5. `postTradeConsistencyRuntime.stopAndDrain()`
6. 清空交易任务队列与延迟验证
7. `postTradeConsistencyRuntime.midnightClear()`
8. 清理其他缓存

### 开盘重建完成后

`openRebuild()` 中固定改为：

1. `postTradeConsistencyRuntime.start()`
2. `postTradeConsistencyRuntime.completeRebuildBaseline()`
3. 启动其他异步处理器

### 必须删除

删除：

1. `signalRuntimeDomain.openRebuild()` 中手工 `refreshGate.markFresh(...)`

### 为什么这里必须这样改

因为开盘重建完成后是否可以 fresh，也不应由 lifecycle 自己判断。

只要 lifecycle 还在直接 `markFresh`，方案就没有完成。

同时午夜清理不能先停 `postTradeConsistencyRuntime` 再停等待方处理器，否则可能出现：

1. `sellProcessor` 或 `monitorTaskProcessor` 已进入 `waitForFresh()`
2. 一致性运行时先被停止，freshness 不再推进
3. 等待方的 `stopAndDrain()` 永远等不到返回，形成清理死锁

因此必须先停等待方，再停成交后一致性运行时。

`createCleanup` 的退出清理顺序也必须遵循同一原则，不能在进程退出时恢复为“先停成交后一致性运行时、后停等待方”的错误顺序。

---

## 7. 文件级改动清单

## 7.1 新增文件

1. `src/app/runtime/createPostTradeConsistencyRuntime.ts`
2. 如实现需要，可新增相邻 `types.ts`
3. `docs/plans/2026-04/2026-04-04-post-trade-refresh-event-driven-refactor-plan.md`

## 7.2 必改文件

1. `src/app/runtime/createPostGateRuntime.ts`
2. `src/app/runtime/createAsyncRuntime.ts`
3. `src/app/createLifecycleRuntime.ts`
4. `src/app/createCleanup.ts`
5. `src/app/runApp.ts`
6. `src/app/types.ts`
7. `src/core/trader/index.ts`
8. `src/core/trader/types.ts`
9. `src/core/trader/orderMonitor/index.ts`
10. `src/core/trader/orderMonitor/types.ts`
11. `src/core/trader/orderMonitor/settlementFlow.ts`
12. `src/core/trader/orderMonitor/recoveryFlow.ts`
13. `src/main/mainProgram/index.ts`
14. `src/main/mainProgram/types.ts`
15. `src/main/asyncProgram/postTradeRefresher/index.ts`
16. `src/main/asyncProgram/postTradeRefresher/types.ts`
17. `src/main/asyncProgram/sellProcessor/index.ts`
18. `src/main/asyncProgram/monitorTaskProcessor/helpers/seatSnapshot.ts`
19. `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
20. `src/main/lifecycle/cacheDomains/types.ts`
21. `src/types/services.ts`

## 7.3 原则上不改业务语义，但必须联动复核的文件

1. `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
2. `src/main/lifecycle/rebuildTradingDayState.ts`
3. `src/app/createMonitorContexts.ts`

这些文件主要用于确认启动和重建顺序在新结构下仍然闭合。

---

## 8. 测试与验证方案

## 8.1 必须新增或调整的测试点

### A. 成交后不依赖主循环即可触发刷新

验证：

1. 不运行主循环
2. 直接触发 `settlementFlow` 的终态结算
3. 运行时已启动

预期：

1. `recordSettlementRefreshNeed(...)` 被调用
2. 刷新立即进入运行时 pending 队列
3. 刷新成功后 freshness 被推进

### B. 启动阶段在运行时未启动前发生成交

验证：

1. `initializeOrderMonitor()` 后但 `postTradeConsistencyRuntime.start()` 前发生结算事件
2. 后续执行 startup rebuild
3. 再启动运行时

预期：

1. 事件不会丢失
2. `completeRebuildBaseline()` 不会提前 fresh
3. 真正刷新完成后才 fresh

### C. 开盘重建期间发生成交

验证：

1. `midnightClear()` 后运行时已停止
2. 开盘重建前发生结算事件
3. `openRebuild()` 执行后启动运行时

预期：

1. 事件不会丢失
2. lifecycle 不会提前 fresh
3. `waitForFresh()` 等待方只会在真实刷新完成后被放行

### D. 刷新失败后 freshness 不推进

验证：

1. 刷新账户或持仓阶段故意失败
2. 触发重试

预期：

1. `currentVersion < staleVersion`
2. 等待方持续阻塞
3. 重试成功后才推进 freshness

### E. 启动重建与开盘重建都不再直接操作 gate

验证：

1. 启动路径执行一次完整 rebuild
2. 开盘重建路径执行一次完整 rebuild

预期：

1. `runApp` 不再直接 `markFresh`
2. `signalRuntimeDomain` 不再直接 `markFresh`
3. 只有 `PostTradeConsistencyRuntime` 会推进 freshness

### F. 旧接口完全消失

验证：

1. 全项目搜索旧接口与旧字段

预期：

1. 不存在 `getAndClearPendingRefreshSymbols`
2. 不存在 `pendingRefreshSymbols`
3. `mainProgram` 不再引用成交后刷新器

## 8.2 验收标准

本次方案完成后，必须同时满足：

1. 成交后刷新不再依赖主循环。
2. `PostTradeConsistencyRuntime` 成为成交后一致性的唯一所有者。
3. queue、gate、worker、lifecycle 语义不再分散在多个模块。
4. 启动和开盘重建都不再直接 `markFresh`。
5. `settlementFlow` 只报告刷新需求，不持有 pending 队列。
6. `mainProgram` 不再承担任何成交后刷新职责。
7. `postTradeRefresher` 不再作为独立 async runtime 成员存在。
8. 不引入行情获取、不引入展示逻辑。
9. `bun format`、`bun lint`、`bun type-check` 全部通过。

---

## 9. 不采用的方案

本次明确不采用以下方案：

1. 只增加一个外部事件缓冲通道。
2. 保留 `postTradeRefresher` 当前所有权，仅修改事件入口。
3. 保留 `RefreshGate` 当前所有权，仅修改 enqueue 路径。
4. 继续让 startup/lifecycle 手工推进 freshness。
5. 继续让主循环保留隐藏刷新路径。
6. 让 `settlementFlow` 直接持有 `postTradeRefresher`。

理由：

1. 这些做法都没有把成交后一致性收口为单一运行时域。
2. 这些做法都会保留新的双轨或新的语义分裂。
3. 这些做法都不是系统性重构。

---

## 10. 实施顺序

推荐按以下顺序实施：

1. 新增 `PostTradeConsistencyRuntime`，先收口 queue + gate + 刷新执行内核。
2. 在 `createPostGateRuntime()` 中创建该运行时，并调整 `Trader` 注入方式。
3. 修改 `settlementFlow`，改为调用 `recordSettlementRefreshNeed(...)`。
4. 删除 `pendingRefreshSymbols`、`getAndClearPendingRefreshSymbols()` 与主循环 enqueue 路径。
5. 将等待 freshness 的消费方改为依赖运行时。
6. 修改 `runApp`，删除启动后手工 `markFresh(...)`。
7. 修改 lifecycle，删除开盘重建后手工 `markFresh(...)`。
8. 将 `postTradeRefresher` 从 `AsyncRuntime` 中移出并完成类型收口。
9. 修改 `createCleanup` 与相关 context/types，确保退出路径改为停止 `PostTradeConsistencyRuntime`。
10. 补测试。
11. 跑 `bun format`、`bun lint`、`bun type-check`。

---

## 11. 最终结论

再次分析后的最终结论是：

1. 这次问题的根本矛盾不是“缺少一个事件通道”，而是“成交后一致性链路没有唯一所有者”。
2. 正确的系统性重构方向，是把这条链路提升为独立运行时域：`PostTradeConsistencyRuntime`。
3. 只要仍然保留：
   - 主循环排空
   - lifecycle 手工 `markFresh`
   - `OrderMonitor.pendingRefreshSymbols`
   - `postTradeRefresher` 的旧所有权

   则方案都不完整。

4. 在本方案下，`settlementFlow`、pending 队列、刷新执行器、freshness 门禁、启动/重建语义都由同一运行时域统一管理，逻辑闭合且可验证。
