当前订单监控仍采用“主循环尾部统一 schedule + 全局 worker 单航道 + processWithLatestQuotes() 全量扫描 tracked orders”的执行模型：

- 主循环在 src/main/mainProgram/index.ts 每轮 monitor 处理结束后调用 orderMonitorWorker.schedule()。
- orderMonitorWorker 在 src/main/asyncProgram/orderMonitorWorker/index.ts 负责 latest-overwrite 式单飞执行。
- 真正的超时撤单、改单、卖单超时转市价评估在 src/core/trader/orderMonitor/quoteFlow.ts 的 processWithLatestQuotes() 中，通过批量 getQuotes(trackedSymbols) 后扫描全部 tracked orders 完成。
- 订单状态推进本身已由 src/core/trader/orderMonitor/eventFlow.ts 基于 WS order push 处理；终态副作用已集中在 src/core/trader/orderMonitor/settlementFlow.ts；恢复链路已集中在 src/core/trader/orderMonitor/recoveryFlow.ts。

当前分支已经完成一轮明显的事件驱动重构：

- src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts
- src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts
- src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts
- src/app/runtime/createPostTradeConsistencyRuntime.ts

这些模块已经稳定证明当前代码库接受如下架构语言：

- 基于 marketDataClient.onQuoteUpdated(...) 直接驱动业务 runtime
- 按 route 收敛 single-flight + latest-only
- route/timer/current-route 校验
- owner 边界与 timer 投影规则明确化
- lifecycle 统一 start / stopAndDrain

本次重构目标是把订单监控从“主循环驱动的全量扫描”改为“全局 OrderMonitor 内部的按 trading symbol route 事件驱动执行模型”，满足：

1.  不再依赖主循环调度订单监控。
2.  quote push 到达时直接触发对应 trading symbol route 的订单管理评估。
3.  没有未完成订单时不运行任何订单监控逻辑。
4.  时间语义（买单超时撤单、卖单超时转市价评估、撤单/改单重试、WAIT_WS_ONLY 等）一并迁移为per-symbol route timer 驱动。
5.  不引入兼容路径、双 owner、fallback 轮询或补丁性回退逻辑。

---

Recommended Approach

总体原则

保留一个全局 OrderMonitor 业务 owner，不改其作为订单运行态、恢复、结算、order ops 统一所有者的角色；仅把它内部的执行模型改为：

- 按 trading symbol route 路由
- 由 quote event / order event / timer event 三类显式事件驱动
- 每个 symbol route 单独 single-flight + dirty collapse
- route 为空（无 unfinished orders）立即销毁并清理 timer

这不是“为每个 symbol 创建一个完整 monitor 实例”，而是：

- 逻辑上按 symbol 分监控
- 架构上仍保留一个 OrderMonitor
- 恢复、结算、幂等缓存、pending sell 占用、order WS bootstrapping 仍由单个 OrderMonitor 统一拥有

为什么 route key 必须选 symbol

不选 orderId

若按 orderId 建 route，会把同一 trading symbol 下共享同一份 quote、同一份 broker 通道约束的 unfinished orders 拆碎，导致：

- 同一笔 quote push fan-out 到多个 order route
- 同一 symbol 上的多个 broker mutation 并发抢跑
- cancel / replace / timeout / market conversion 顺序失去 symbol 级收敛
- 旧状态下重复作出第二个 mutation

订单监控的最小正确串行单元不是 order，而是 trading symbol。

不选 monitorSymbol:direction

订单监控关心的是真实订单所在 trading symbol，而不是策略席位当前归属。当前分支已有 auto symbol / switch 语义，同一 monitorSymbol:direction 在时间上会对应不同 trading symbol，而旧 symbol 仍可能存在 unfinished orders。若按 monitorSymbol:direction 路由，会把旧 symbol 挂单和新 symbol 挂单错误压进同一航道，或者让旧 symbol route 在 seat 切换后失去稳定 owner。

选 symbol 的闭环性

三条事实链天然都以 trading symbol 闭合：

- quote push 事件以 event.symbol 为主键
- WS order event 能从 tracked order 直接归属到 trading symbol
- recovery snapshot 中 unfinished orders 天然按 trading symbol 分桶

因此 route key 统一为 symbol 是当前分支最短路径且逻辑最稳的选择。

目标架构

1.  保留的全局业务 owner

继续保留以下模块与职责中心：

- src/core/trader/orderMonitor/eventFlow.ts：订单 WS 事件处理入口
- src/core/trader/orderMonitor/orderOps.ts：track / cancel / replace / state-check 统一语义
- src/core/trader/orderMonitor/settlementFlow.ts：终态副作用唯一收口
- src/core/trader/orderMonitor/recoveryFlow.ts：BOOTSTRAPPING / snapshot recovery / 回放 / 严格对账

2.  新增的内部 route runtime

在 src/core/trader/orderMonitor/ 下新增以下模块：

- routeRuntime.ts：route 生命周期、事件订阅、single-flight、dirty collapse、stopAndDrain
- routeProcessor.ts：单 symbol route 固定顺序执行器
- routingIndex.ts：作为 trackedOrderIdsBySymbol / routeStatesBySymbol 的唯一写入口，统一维护 symbol 索引、route 创建/销毁与重建
- routeTimers.ts：per-symbol route timer 注册、取消、generation 校验

3.  route state

在 src/core/trader/orderMonitor/types.ts 新增：

- OrderMonitorRouteKey = string
- OrderMonitorWakeup
- OrderMonitorWakeupKind = 'QUOTE' | 'ORDER_EVENT' | 'TIMER' | 'TRACKED' | 'RECOVERED'
- OrderMonitorTimerKind
- OrderMonitorTimerKey
- OrderMonitorSymbolRouteState

建议 OrderMonitorSymbolRouteState 至少包含：

- symbol
- generation
- inFlight
- dirty
- latestQuote: Quote | null
- timerHandles: Map<OrderMonitorTimerKey, ReturnType<typeof setTimeout>>

说明：

- symbol 下当前有哪些 unfinished order，只允许由 trackedOrders + trackedOrderIdsBySymbol 表达，不能在 route state 再维护一份 activeOrderIds 副本。
- route state 只负责执行收敛与 timer 生命周期，不拥有订单业务真相。
- wakeup 不保留 `pendingWakeups` 这类历史队列；`QUOTE / ORDER_EVENT / TIMER / TRACKED / RECOVERED` 只作为 triggerRoute(...) 的输入来源，用来刷新最小投影（如 latestQuote）并把 route 置为 dirty。
- generation 必须在每次 route 创建/重建时递增；所有 timer callback、异步 broker 调用 continuation、以及任何延后提交 runtime 写回的结果都必须携带并校验 generation。
- `OrderMonitorTimerKey` 必须是稳定的结构化标识（例如 `${orderId}:${timerKind}`），不能退化成无约束字符串约定。

4.  全局 store 新增索引

在 OrderMonitorRuntimeStore 上新增：

- trackedOrderIdsBySymbol: Map<string, Set<string>>
- routeStatesBySymbol: Map<string, OrderMonitorSymbolRouteState>
- running: boolean
- unsubscribeQuoteUpdated: (() => void) | null

说明：

- trackedOrders 继续以 orderId 为主索引，保持 recovery / settlement / orderOps 兼容。
- trackedOrderIdsBySymbol 是 symbol -> unfinished orderIds 的唯一业务索引真相，只负责 route 查找和 route 空/非空判定。
- routeStatesBySymbol 只负责执行收敛与 timer 生命周期，不拥有业务真相，也不重复维护 symbol 下订单集合。
- `trackedOrderIdsBySymbol` 与 `routeStatesBySymbol` 只能由 routingIndex.ts 统一写入；其他模块只允许调用 routingIndex 提供的 attach / detach / rebuild / ensureRoute / destroyRoute 接口，不得直接 set/delete 这两个 Map。
- 必须保证以下不变量始终由同一 owner 原子维护：
  - unfinished orderId 只能属于一个 symbol bucket
  - bucket 为空时不得残留空 Set
  - 非空 bucket 在 runtime running 时必须能映射到当前 generation 的 route
  - route 销毁后，旧 generation 下的 timer/async continuation 不得再命中新 route

三类事件如何触发 route processing

A. quote event

在 OrderMonitor 内部 runtime 直接订阅：

- 复用 marketDataClient.onQuoteUpdated(...)
- 实现风格参考：
  - src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts
  - src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts

处理流程：

1.  收到 QuoteUpdatedEvent。
2.  查 routeStatesBySymbol.get(event.symbol)。
3.  route 不存在则直接返回（无 unfinished orders 时无监控）。
4.  route 存在则更新 route.latestQuote = event.quote。
5.  追加 QUOTE wakeup。
6.  若 route 当前不在飞，则启动 processing；若在飞，则只置 dirty=true。

B. order event

保留 eventFlow.ts 作为 order WS truth owner，但改造为“更新 tracked order 后显式唤醒 symbol route”。

处理流程：

1.  按现有逻辑更新 tracked order / 部分成交 / replace/cancel 解除条件。
2.  若订单进入终态，继续由 settlementFlow.settleOrder(...) 处理副作用。
3.  找到该订单所属 symbol。
4.  若该 symbol route 仍存在，则追加 ORDER_EVENT wakeup。
5.  若该订单终态后当前 symbol 已无 unfinished orders，则销毁 route 并清 timer。

必须依赖 order event 唤醒的关键语义：

- WAIT_WS_ONLY 解除
- cancel 已确认但需要进入下一步动作
- 部分成交导致剩余数量/状态变化
- timeout market conversion 需要等待撤单终态再推进

C. timer event

所有时间语义迁移到 per-symbol route timer，不再依赖主循环扫描。timer 只是 tracked order 当前状态的投影层，不拥有独立业务状态；timer 回调只负责：

1.  带着 { symbol, generation, orderId, timerKind } 回调。
2.  查当前 route 是否仍存在且 generation 一致。
3.  不一致则直接丢弃。
4.  一致则追加 TIMER wakeup。
5.  启动或合并 route processing。

补充约束：

- buy timeout / sell timeout / cancel retry / replace blocked / state-check retry / quote retry 都必须从 tracked order 当前字段重新推导，不允许在 timer runtime 再保存一份“下一步业务动作真相”。
- terminal settlement、recovery reset、clearTrackedOrders 后，route timer 必须随 symbol route 一并取消，避免 stale callback 回写运行态。

需要迁移的 timer 类型：

- 买单超时撤单 timer
- 卖单超时“先撤单再评估转市价” timer
- cancel retry timer
- replace blocked/backoff timer
- state-check retry timer
- quote retry timer（对当前 route 缺少可用 quote 的订单）

D. track/recovery 事件

不是独立的业务源，但需要作为 route 启动信号：

- trackOrder(...) 结束后：
  - 建索引 trackedOrderIdsBySymbol
  - 若是该 symbol 首个 unfinished order，则创建 route
  - 注册必要 timer
  - 追加 TRACKED wakeup
- recoverOrderTrackingFromSnapshot(...) 完成后：
  - 按 symbol 重建 trackedOrderIdsBySymbol
  - 回放 WS 事件
  - recovery assertions 全通过后，仅保留已恢复好的 tracked truth 与 symbol 索引
  - 后续是否发 RECOVERED wakeup，只能由 startOrderMonitorRuntime() 在 runtime 真正启动时决定；recoveryFlow 本身不得直接触发 RECOVERED
  - RECOVERED 只表示“对已完成 recovery 收敛的非空 route 触发一次运行机会”，不是第二套 recovery owner，也不允许在该 wakeup 中再次写入 recovery truth

route processing 固定顺序

每个 symbol route 一律走同一固定顺序，避免不同事件类型走不同逻辑树。

第 1 步：入口校验

进入 route processing 后立即校验：

- runtime 仍在 running
- route 仍存在
- generation 一致

失败直接结束。

第 2 步：读取已收敛的 order truth

进入 route processing 时，默认本轮可见的 tracked order / terminal settlement / recovery replay 已由现有 owner 完成收敛：

- order WS 推进仍由 eventFlow.ts 负责
- 终态副作用仍由 settlementFlow.ts 负责
- recovery / bootstrapping replay 仍由 recoveryFlow.ts 负责

route processor 不重复写入订单真相，只读取当前 tracked state，并通过 routingIndex 暴露的只读视图判断当前 symbol 的 unfinished orders。

原则：先读取已经收敛的真实订单状态，再做任何 quote-driven / timer-driven 管理动作。避免 route processor 与 eventFlow / settlementFlow / recoveryFlow 形成双 owner，也避免 routeProcessor 自己直接改写 trackedOrderIdsBySymbol。

第 3 步：route 空检查

若当前 symbol 已无 unfinished orders：

- 清理该 route 全部 timer
- 删除 route state
- 直接结束

这一步是“无 unfinished orders 即无监控逻辑”的硬约束。

第 4 步：重建 timer 计划

对 surviving unfinished orders 重新计算并维护当前 route 下全部 timer：

- buy timeout
- sell timeout
- cancel retry
- replace retry
- state-check retry
- quote retry

这里不做全局扫描，只重建当前 route 的 timers。

第 5 步：固定优先级执行动作

同一 route 内动作顺序固定为：

1.  终态后续动作

- timeout cancel 后收到终态，若满足条件则转市价
- WAIT_WS_ONLY 解除后的后续动作

2.  timer 到点动作

- buy timeout cancel
- sell timeout cancel
- cancel retry
- replace retry
- state-check retry

3.  quote-driven 动作

- 比较最新 quote 与当前委托价
- 达阈值且满足门禁时 replace

同优先级内顺序固定为：

- submittedAt 升序
- 再按 orderId 字典序

第 6 步：单次 pass 只允许一个外部 mutation

一次 route pass 内，最多允许发起一个会改变 broker 外部状态的动作：

- cancelOrder
- replaceOrderPrice
- timeout 引发的 cancel
- 转市价新单提交
- 会写入 terminal query cache 的权威状态确认动作

发起后立即结束本轮 pass，把后续状态推进交给：

- order WS
- timer
- dirty rerun

这条设计约束是防止逻辑错误的关键，不是兜底。

第 7 步：异步返回后再次 current-route 校验

任何异步结果写回 store 前，都要再次校验：

- runtime 仍在 running
- route 仍存在
- generation 未变
- orderId 仍属于当前 route
- 订单当前状态仍满足该动作的前置条件

失败则直接丢弃结果，不写回。

第 8 步：dirty collapse

本轮结束后：

- 若期间 dirty=true 且 route 仍存在，则立即再跑一轮
- 否则 inFlight=false

实现风格参考：

- src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts
- src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts

---

File-by-File Changes

一、删除旧 owner 路径

1.  删除主循环对订单监控的调度

修改：

- src/main/mainProgram/index.ts

删除：

- await Promise.allSettled(monitorTasks); 之后的 orderMonitorWorker.schedule() 调用
- MainProgramContext 对 orderMonitorWorker 的依赖

2.  删除 orderMonitorWorker

删除：

- src/main/asyncProgram/orderMonitorWorker/index.ts
- src/main/asyncProgram/orderMonitorWorker/types.ts
- tests/main/asyncProgram/orderMonitorWorker/business.test.ts

3.  删除 Trader 的轮询接口

修改：

- src/types/services.ts
- src/core/trader/types.ts
- src/core/trader/index.ts

删除：

- Trader.monitorAndManageOrders()
- orderMonitor.processWithLatestQuotes() 对外暴露

二、OrderMonitor 内部新增 route runtime

4.  修改 orderMonitor/index.ts

职责调整：

- 保留 initialize() 作为 order WS 初始化入口
- 额外增加：
  - startRuntime()
  - stopRuntimeAndDrain()
- 在内部组装：
  - eventFlow
  - settlementFlow
  - recoveryFlow
  - orderOps
  - routeRuntime

新运行顺序：

- initialize() 仍只负责 private topic 订阅与 order WS 入口
- startRuntime() 才开始订阅 marketDataClient.onQuoteUpdated 并激活 route timers

5.  修改 orderMonitor/types.ts

新增：

- route runtime 类型
- route state 类型
- wakeup/timer 类型
- trackedOrderIdsBySymbol / routeStatesBySymbol / runtime lifecycle 字段

删除：

- QuoteFlow / QuoteFlowDeps / processWithLatestQuotes() 型接口

6.  删除/替换 quoteFlow.ts

建议：

- 删除 src/core/trader/orderMonitor/quoteFlow.ts
- 以 routeProcessor.ts + routeTimers.ts + routeRuntime.ts 替代

原因：

- 该文件名已经不再准确描述职责
- 它承载的是“全量扫描器”，与目标架构冲突

三、改造 order WS / track / settlement / recovery 的 route 接口

7.  修改 orderOps.ts

保留：

- trackOrder(...)
- cancelOrder(...)
- replaceOrderPrice(...)
- resumeOrderReplaceFromWsProgress(...)
- consumeQueriedTerminalState(...)
- consumeLatestReplaceOutcome(...)

新增：

- 在 trackOrder(...) 末尾通过 routingIndex.attachTrackedOrder(...) 维护 trackedOrderIdsBySymbol
- 若该 symbol route 不存在则由 routingIndex.ensureRoute(...) 创建 route
- 追加 TRACKED wakeup

注意：

- 不改 broker API 语义
- 不改 602012 / 602013 / WAIT_WS_ONLY 等逻辑语义
- 只改“谁消费这些状态”的 owner
- orderOps 不允许在 `await` 之后直接把异步结果无条件写回 runtime；所有 broker 调用完成后的本地提交必须经由 routeRuntime/routeProcessor 提供的 guarded commit（校验 running + route existence + generation + order still attached）后才能落到 runtime store。
- 也就是说，复用的是 cancel/replace/state-check 的业务语义，不是复用“异步返回后直接写 runtime”的旧提交方式。

8.  修改 eventFlow.ts

保留：

- BOOTSTRAPPING / ACTIVE 分流
- tracked order 状态推进
- 部分成交同步 pending sell
- 终态进入 settlement

新增：

- 对应 symbol route 的 ORDER_EVENT wakeup
- 终态后的索引移除与 route 销毁仍由 settlement terminal hook 统一完成，eventFlow 只负责 truth 推进与 wakeup，不直接清理 route/index

9.  修改 settlementFlow.ts

保留：

- 终态副作用唯一收口
- recordSettlementRefreshNeed(...)
- emitOrderStateChanged(...)
- runtime tracking 清理

新增：

- settlement 后通过最小 hook 调用 routingIndex.detachTrackedOrder(...)，使 trackedOrders 与 trackedOrderIdsBySymbol 在同一终态 mutation 点同步收敛
- 若对应 symbol bucket 变空，则由 routingIndex.destroyRoute(...) 统一销毁 route 与 timer
- 不把 route 逻辑放进 settlementFlow，只提供最小 hook/回调即可

10. 修改 recoveryFlow.ts

保留：

- BOOTSTRAPPING
- cache/replay order events
- 严格对账
- mismatched buy 严格撤单/确认/结算

新增：

- reset 时通过 routingIndex.rebuildFromTrackedOrders([]) / resetRoutes() 同步清理 trackedOrderIdsBySymbol / routeStatesBySymbol
- restore order 时同时通过 routingIndex.attachTrackedOrder(...) 重建 symbol 索引
- recovery 成功切到 ACTIVE 后，不直接做全量轮询，也不直接 arm timer；而是仅保留已恢复好的 tracked truth 与 symbol 索引

约束：

- recoveryFlow 仍是唯一 recovery truth owner；RECOVERED wakeup 只负责让 route runtime 在 ACTIVE 后消费已经恢复完成的 tracked state。
- 不允许把 RECOVERED 实现成“再跑一次 snapshot recovery / replay / reconciliation”的第二条恢复链路。
- recoveryFlow 不负责订阅 quote、不负责启动 route timer、也不负责直接触发 route 执行；这些动作的唯一 owner 是 startOrderMonitorRuntime()。

四、Trader 与 app/lifecycle wiring 改造

11. 修改 core/trader/index.ts

把对外暴露从：

- monitorAndManageOrders()

改为：

- startOrderMonitorRuntime()
- stopOrderMonitorRuntimeAndDrain()

同时保留：

- initializeOrderMonitor()
- recoverOrderTrackingFromSnapshot()
- onOrderStateChanged()
- cancelOrder()

12. 修改 app/runtime/createAsyncRuntime.ts

删除：

- createOrderMonitorWorker(...)
- 返回值中的 orderMonitorWorker

保留：

- monitorTaskProcessor
- buyProcessor
- sellProcessor

13. 修改 main/lifecycle/cacheDomains/signalRuntimeDomain.ts

将：

- orderMonitorWorker.start()
- orderMonitorWorker.stopAndDrain()

替换为：

- trader.startOrderMonitorRuntime()
- trader.stopOrderMonitorRuntimeAndDrain()

并明确其 owner 边界：

- startOrderMonitorRuntime() 必须挂在 signalRuntimeDomain.openRebuild()/startup runtime start 阶段，且只能发生在 globalStateDomain.openRebuild() 已完成 rebuildTradingDayState()（其中包含 recoverOrderTrackingFromSnapshot(...)）之后。
- stopOrderMonitorRuntimeAndDrain() 只负责停止 quote listener、route timer 与 in-flight route processing，不负责 reset tracked order store。

14. 修改 app/types.ts、main/mainProgram/types.ts

删除：

- 对 OrderMonitorWorker 的类型依赖与字段透传

15. 修改 app/runApp.ts、app/createCleanup.ts

确保：

- startup 首次启动路径中，route runtime 只在 rebuildTradingDayState()（含 recoverOrderTrackingFromSnapshot(...)）成功返回且 post-trade consistency baseline 完成后启动。
- process exit cleanup 只负责 stopAndDrain runtime，不承担 trader/order store reset。
- 跨日 reset 仍由 lifecycle 的 orderDomain -> trader.resetRuntimeState() 负责，且必须发生在 signalRuntimeDomain 已 stopAndDrain order monitor runtime 之后。

---

Recovery and Lifecycle Migration

1.  startup / open rebuild 固定顺序

必须区分“首次 startup 接线”与“生命周期 open rebuild 接线”，但两者的 owner 顺序约束一致：order recovery 先完成，signal runtime 后启动。

首次 startup 路径：

1.  创建 Trader / OrderMonitor store。
2.  initializeOrderMonitor()：只接 order WS，不开启 quote route runtime。
3.  拉取账户、持仓、全量订单。
4.  执行 rebuildTradingDayState(...)，其中内部固定包含：

- 同步 monitor context / seat / quote
- 重建订单记录与风险缓存
- recoverOrderTrackingFromSnapshot(allOrders)
- recoveryFlow 完成 BOOTSTRAPPING replay / reconciliation，并切 runtimeState='ACTIVE'

5.  postTradeConsistencyRuntime.start()。
6.  postTradeConsistencyRuntime.completeRebuildBaseline()。
7.  其后才允许 startOrderMonitorRuntime()：

- 订阅 onQuoteUpdated
- 基于 recovery 后留下的非空 symbol 索引 ensureRoute(...)
- 为当前非空 route 建 timer
- 触发 RECOVERED wakeups

生命周期 open rebuild 路径：

1.  dayLifecycleManager 按 cache domain 逆序执行 openRebuild。
2.  globalStateDomain.openRebuild() 先执行 executeTradingDayOpenRebuild(...)。
3.  executeTradingDayOpenRebuild(...) 内部固定为 loadTradingDayRuntimeSnapshot(...) -> rebuildTradingDayState(...)。
4.  rebuildTradingDayState(...) 内部完成 recoverOrderTrackingFromSnapshot(...)，把 order recovery 收敛到 ACTIVE。
5.  之后才轮到 signalRuntimeDomain.openRebuild()，在其中启动 postTradeConsistency baseline、risk/quote/switch runtimes、processors，以及 startOrderMonitorRuntime()。
6.  因此 arm timer / 发 RECOVERED wakeup 的唯一 owner 也是 signalRuntimeDomain.openRebuild() -> startOrderMonitorRuntime()，不是 recoveryFlow。

关键点：

- startOrderMonitorRuntime() 的正确 owner 是 signalRuntimeDomain.openRebuild()/startup runtime start 阶段，不是 rebuildTradingDayState() 内部，也不是 recoveryFlow 内部。
- recovery owner 仍是 recoveryFlow；route runtime 只消费“恢复后的正确 tracked state”。
- 不允许在 recovery 未完成前打开 quote route runtime。

2.  midnight clear 固定顺序

这里必须按 cache domain owner 分层表述，不能把 stop runtime 与 reset store 写成同一 owner：

1.  dayLifecycleManager 按注册顺序执行 midnightClear。
2.  signalRuntimeDomain.midnightClear() 先执行：

- stopOrderMonitorRuntimeAndDrain()
- 停止 quote listener
- 取消所有 route timer
- 排空所有 in-flight route processing

3.  之后才轮到 orderDomain.midnightClear()，由 trader.resetRuntimeState() 统一清：

- trackedOrders
- trackedOrderIdsBySymbol
- routeStatesBySymbol
- orderHoldRegistry
- pending sell 占用与相关缓存

关键点：

- stop runtime 的 owner 是 signalRuntimeDomain；reset tracked order store 的 owner 是 orderDomain。
- 先 stop runtime，后 reset store；禁止反过来，避免 stale callback 写回空 store。
- 不允许把 store reset 塞回 stopOrderMonitorRuntimeAndDrain()，否则会破坏现有 lifecycle domain 分层。

3.  active route 的订阅保活

保留现有 orderHoldRegistry -> orderHoldSymbols -> collectRuntimeQuoteSymbols -> allTradingSymbols 语义，不为订单监控单独维护一套 quote subscription 所有权。

也就是说：

- OrderMonitor runtime 只消费 onQuoteUpdated
- 底层 symbol 是否已订阅，仍由现有全局 runtime subscription 体系决定
- unfinished orders 通过 orderHoldRegistry 继续保活 quote 订阅

这点必须保留，否则订单 route 可能在 unfinished 时失去 quote 订阅来源。

---

Critical Reuse Points

以下现有函数/模式应明确复用，不要重写语义：

1.  事件驱动 runtime 模式

参考：

- src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts
- src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts

复用：

- per-route inFlight + dirty
- start / stopAndDrain
- route current 校验
- timer + dirty collapse 模式

2.  order truth 与 broker mutation 语义

复用：

- src/core/trader/orderMonitor/orderOps.ts
- src/core/trader/orderMonitor/eventFlow.ts
- src/core/trader/orderMonitor/settlementFlow.ts
- src/core/trader/orderMonitor/recoveryFlow.ts

特别是：

- cancelOrder() 权威状态确认语义
- replaceOrderPrice() 对 602012 / 602013 / WAIT_WS_ONLY 的处理
- settleOrder() 的幂等与 side-effect 收口
- recovery 的严格对账与 bootstrapping 回放

---

Verification

1.  单元/业务测试

重点新增或改造：

route runtime 层

- 新增 tests/core/trader/orderMonitor/routeRuntime.business.test.ts
- 覆盖：
  - quote 只唤醒目标 symbol route
  - route 不存在时 quote 不触发任何处理
  - order event / timer event 均能唤醒 route
  - in-flight 时 dirty collapse 正确
  - stale timer / stale generation 不会写回
  - stopAndDrain 后旧事件与旧 timer 不再推进
  - 一次 pass 最多一个 broker mutation
  - 同一 symbol 下多个 unfinished orders 按 submittedAt -> orderId 固定顺序选择动作对象
  - 第一单 mutation 发出后，同 symbol 后续订单必须等待下一轮 rerun / WS / timer，不能同 pass 并发突变

订单业务语义层

- 改造 tests/core/trader/orderMonitor.business.test.ts
- 确保以下链路仍成立：
  - 买单超时只撤单
  - 卖单超时：撤单确认后才转市价
  - 602012 不支持改单
  - 602013 退避与 WAIT_WS_ONLY
  - WS 推进后解除 WAIT_WS_ONLY
  - duplicate terminal event 幂等
  - partial fill 与 pending sell 占用更新正确

recovery 层

- 扩展/新增 tests/core/trader/orderMonitor/recoveryFlow.business.test.ts
- 覆盖：
  - recovery 后 routesBySymbol 正确
  - bootstrapping 回放后 route state 收敛正确
  - recovery 失败不进入 ACTIVE
  - recovery 后无需主循环也能继续推进 unfinished orders

2.  wiring / lifecycle 测试

修改：

- tests/app/createLifecycleRuntime.wiring.test.ts
- tests/app/createCleanup.business.test.ts
- tests/app/runApp.test.ts
- tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts
- tests/main/lifecycle/dayLifecycleManager.test.ts
- tests/main/lifecycle/cacheDomains/orderDomain.test.ts

验证：

- 不再创建 / 传递 orderMonitorWorker
- start / stop 顺序中由 order monitor runtime 取代 worker
- rebuild baseline 后再启动 order monitor runtime
- startup 正常路径中，只有在 rebuildTradingDayState() 与 completeRebuildBaseline() 之后才允许 startOrderMonitorRuntime()
- startupRebuildPending 路径中不得启动 order monitor runtime
- midnightClear 必须先完成 signalRuntimeDomain.stopOrderMonitorRuntimeAndDrain()，之后 orderDomain 才允许 reset tracked order store

3.  integration 测试

重点回归：

- tests/integration/main-loop-latency.integration.test.ts
- tests/integration/multi-monitor-concurrency.integration.test.ts
- tests/integration/full-business-simulation.integration.test.ts
- tests/integration/main-program-strict.integration.test.ts

验证目标：

- 主循环不再承担订单监控 owner
- 即使主循环节拍停止，quote push / order WS / route timer 仍能推进 unfinished orders
- 与现有 monitor quote / risk runtime 并存时无双驱动/无竞态

说明：

- 这些 integration 测试只作为高层回归烟测；owner 顺序、startup/openRebuild/midnightClear 边界与单航道不变量必须由更聚焦的 wiring/lifecycle/business tests 锁定，不能只靠 integration 证明。

4.  手工/端到端验证要点

1.  启动后恢复 unfinished buy/sell orders，确认无需主循环 schedule 也能继续推进。
1.  人工制造 quote 变化，确认目标 symbol route 立即评估 replace，非目标 symbol 无动作。
1.  人工制造 buy timeout / sell timeout，确认 route timer 到点即推进，无需等下一轮主循环。
1.  制造 602013，确认进入 WAIT_WS_ONLY，只有 order WS 推进后才继续。
1.  制造 terminal fill，确认 settlement、pending sell 占用更新与 postTradeConsistency stale 标记保持正确，且订单监控 route 不依赖 freshness 才能继续推进。

---

Key Design Constraints

以下是本方案用来避免逻辑错误的硬约束，不是兜底：

1.  一个 symbol route 一次只允许一个外部 broker mutation。
2.  任何 async 结果写回前都必须做 current-route + generation 校验。
3.  route processor 只读取已由 eventFlow / settlementFlow / recoveryFlow 收敛后的 order truth，再做 quote-driven 管理。
4.  WAIT_WS_ONLY 只能由 order WS 推进解除，quote/timer 不得解除。
5.  route 空即销毁；无 unfinished orders 即无监控逻辑。
6.  recovery 完成前不得启动 quote route runtime。
7.  stop runtime 必须先于 reset store。
8.  不保留 mainProgram -> orderMonitorWorker -> processWithLatestQuotes() 兼容路径。
9.  symbol -> unfinished orderIds 的业务真相只保留 trackedOrderIdsBySymbol 一份，route state 不得重复维护。
10. timer 只是 tracked order 当前状态的投影层，不得持有独立业务真相。

---

Critical Files to Modify

核心实现

- src/core/trader/orderMonitor/index.ts
- src/core/trader/orderMonitor/types.ts
- src/core/trader/orderMonitor/eventFlow.ts
- src/core/trader/orderMonitor/orderOps.ts
- src/core/trader/orderMonitor/recoveryFlow.ts
- src/core/trader/orderMonitor/settlementFlow.ts
- src/core/trader/orderMonitor/quoteFlow.ts（删除/替换）
- src/core/trader/orderMonitor/routeRuntime.ts（新增）
- src/core/trader/orderMonitor/routeProcessor.ts（新增）
- src/core/trader/orderMonitor/routingIndex.ts（新增）
- src/core/trader/orderMonitor/routeTimers.ts（新增）

Trader / app / lifecycle / main loop

- src/core/trader/index.ts
- src/core/trader/types.ts
- src/types/services.ts
- src/app/runtime/createAsyncRuntime.ts
- src/app/types.ts
- src/main/mainProgram/index.ts
- src/main/mainProgram/types.ts
- src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts
- src/app/runApp.ts
- src/app/createCleanup.ts

测试

- tests/core/trader/orderMonitor.business.test.ts
- tests/core/trader/orderMonitor/settlementFlow.business.test.ts
- tests/core/trader/orderMonitor/routeRuntime.business.test.ts（新增）
- tests/app/createLifecycleRuntime.wiring.test.ts
- tests/app/createCleanup.business.test.ts
- tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts
- tests/main/asyncProgram/orderMonitorWorker/business.test.ts（删除）
