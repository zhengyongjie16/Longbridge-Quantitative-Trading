# 行情推进链路事件驱动化重构方案

## 1. 文档目的

本文档用于对“仅将行情推进链路从主循环改为事件驱动”进行全链路分析，并给出一套可以直接落地的系统性重构方案。

本文档明确回答以下问题：

1. 当前主程序里，哪些职责真正属于“行情推进链路”。
2. 哪些职责虽然现在由主循环每秒触发，但本质上不是行情驱动，不能被一起移除。
3. 在不改变业务语义的前提下，如何把行情推进改为“WebSocket 推送触发 + 1 秒合并节流”。
4. 这次重构需要修改哪些模块、建立哪些新边界、补哪些测试。

本文档只讨论运行时调度与职责拆分，不改变交易策略、风控规则、订单执行规则、生命周期规则，不允许兼容式双轨方案，不允许补丁式兜底实现。

---

## 2. 需求澄清

本次目标不是“取消所有每秒调度”，而是精确定义为：

1. 不再由全局主循环每秒统一读取行情缓存并推进监控业务。
2. 改为监听 WebSocket 市场数据推送，在收到新的市场数据后再推进监控业务。
3. 为避免高频推送导致重复推进，增加 1 秒调度合并窗口。
4. 1 秒内无论收到多少次市场数据变更，最多只推进一次监控业务。
5. 非行情驱动的时间链路保留独立时间驱动，不纳入本次移除范围。

这一定义非常重要。若把目标误解为“整个系统完全不再存在 1 秒定时驱动”，将直接破坏生命周期、末日保护、周期换标、订单超时与延迟验证采样等既有语义。

---

## 3. 当前系统事实

### 3.1 当前主入口仍是 1 秒无限循环

当前运行入口在 `src/app/runApp.ts` 中通过 `for (;;) { await runMainProgram(); await sleep(TRADING.INTERVAL_MS); }` 方式持续驱动，说明“何时推进业务”仍由固定节拍控制。

### 3.2 当前行情来源已经是 WebSocket 推送

当前 `MarketDataClient` 并不是每秒从远端拉行情，而是：

1. `QuoteContext.setOnQuote` 接收 WebSocket quote push。
2. 推送到达后更新本地 `quoteCache`。
3. `getQuotes()` 仅从本地 `quoteCache` 读取。

因此，当前主循环做的不是“远程拉行情”，而是“每秒消费一次本地实时缓存”。

### 3.3 当前主循环承担的职责并不单一

当前 `src/main/mainProgram/index.ts` 一次执行同时承担以下职责：

1. 交易时段与开盘保护计算。
2. `dayLifecycleManager.tick()` 生命周期推进。
3. 末日保护检查。
4. 运行时订阅集合同步。
5. 从本地行情缓存读取 `quotesMap`。
6. 并发执行 `processMonitor()`。
7. 驱动 `orderMonitorWorker.schedule(quotesMap)`。
8. 驱动 `postTradeRefresher.enqueue(...)`。

因此，本次重构不能简单把主循环触发条件换成“收到 quote push 就调用 mainProgram”。因为当前 `mainProgram` 混合了市场事件驱动职责和纯时间驱动职责。

---

## 4. 第一性原理分析

### 4.1 本次真正要优化的是什么

从第一性原理看，主循环的低效点不在“行情获取方式”，而在“无论市场数据是否变化，都按固定 1 秒节拍重复推进完整监控链路”。

这会导致：

1. 没有新市场数据时仍重复运行 `processMonitor`。
2. 没有新价格变化时仍重复执行 monitor 级流水线装配。
3. 行情推送已经实时到达，但业务推进仍要等下一个 tick。

因此，本次重构的正确目标是：

1. 把“是否需要推进 monitor 业务”的判断，从固定时间节拍改成市场数据事件。
2. 保留 1 秒这一吞吐边界，以维持当前系统的处理频率上限。

### 4.2 哪些链路天然应该由市场事件驱动

以下链路本质上依赖“市场数据有更新”：

1. 监控标的价格变化检测。
2. 做多/做空标的价格变化检测。
3. 距回收价风险检查。
4. 浮亏监控。
5. K 线与指标快照计算。
6. 信号生成与延迟验证入队。
7. 订单监控中的“按最新价格改单”。

这些链路改成事件驱动是合理的。

### 4.3 哪些链路本质上不属于市场事件驱动

以下链路即使市场不推送，也必须继续推进：

1. 跨日午夜清理与开盘重建。
2. 交易时段、开盘保护、生命周期门禁刷新。
3. 末日保护窗口触发。
4. 自动寻标心跳。
5. 周期换标到期判断。
6. 订单超时撤单、超时转市价、撤单重试。
7. 成交后缓存刷新待处理项的排空。
8. 延迟验证采样窗口维持。

这些链路不能被并入“收到 quote push 才推进”的新模型中。

---

## 5. 全链路隐含约束复核

本次分析确认，以下约束必须被视为刚性约束，否则重构后虽然代码可运行，但业务语义已经漂移。

### 5.1 K 线事件不能被 quote 事件替代

当前 monitor 指标链路依赖 `subscribeCandlesticks()` 后由 SDK 内部维护的 realtime candlestick cache。

当前主循环每秒读取 K 线缓存，因此：

1. 即使 quote 没明显变化，只要 K 线缓存变化，指标链路仍会推进。
2. `runIndicatorPipeline()` 会根据最新 K 线指纹决定是否复用快照或重建快照。

若重构后只监听 quote push，不监听 candlestick push，会出现以下问题：

1. K 线已经收盘更新，但没有新的 quote push。
2. monitor 指标链路不再推进。
3. 新一轮信号生成与展示滞后。

因此，市场事件源不能只包含 quote push，必须覆盖 candlestick push，或者统一抽象为 `MarketDataUpdated` 事件。

### 5.2 延迟验证不能失去每秒采样语义

当前 `IndicatorCache` 明确依赖“主循环每秒 push 一次 snapshot”，而延迟验证在验证时会读取：

1. `T0`
2. `T0 + 5s`
3. `T0 + 10s`

且允许时间容忍度仅为 `±5s`。

这意味着当前系统的隐藏契约是：

1. 即便 K 线指纹没变，主循环也会每秒把最新 snapshot 再 push 一次。
2. 延迟验证靠这一节拍持续获得近似均匀的时间采样点。

若重构后只在市场数据变化时才 push indicator snapshot，会出现以下问题：

1. 某个监控标的已有待验证信号。
2. 之后 10 秒内市场推送稀疏甚至静默。
3. `IndicatorCache` 缺少 `T0+5s` 或 `T0+10s` 附近样本。
4. 验证失败原因变成“采样点缺失”，而不是原有的趋势判定结果。

这会直接改变延迟验证语义。

因此，本次重构必须保留“延迟验证期间每秒采样”的独立时间驱动。正确做法不是修改验证口径，而是新增一个只针对“存在 pending delayed signal 的 monitorSymbol”的采样 heartbeat。

### 5.3 订单监控需要拆成报价驱动和时间驱动

当前 `src/core/trader/orderMonitor/quoteFlow.ts` 虽名为 quote flow，实际同时承担两类职责：

1. 价格变化驱动的改单。
2. 时间到期驱动的超时撤单、超时转市价、撤单重试。

若重构后仍然只保留一个 `processWithLatestQuotes(quotesMap)`，并只在市场事件到达时调用，就会导致：

1. 市场静默时订单超时不再按时评估。
2. 卖单超时转市价延迟。
3. 撤单重试节拍漂移。

因此，订单监控必须显式拆为：

1. `processQuoteDrivenChanges(quotesMap)`。
2. `processTimeDrivenChecks(now)`。

只有这样，报价事件驱动化才不会误伤订单超时逻辑。

### 5.4 成交后刷新不能再隐式依赖下一轮市场推进

当前 `postTradeRefresher.enqueue(...)` 是在主循环尾部统一消费 `trader.getAndClearPendingRefreshSymbols()`。

这意味着在现状下：

1. 订单成交后，order push 只负责写入 pending refresh。
2. 真正触发刷新的是主循环下一秒统一排空。

若重构后没有新的市场事件，而又移除了时间驱动排空，就会出现：

1. 订单已成交。
2. `refreshGate` 已被标记为 stale。
3. `pendingRefreshSymbols` 无人消费。
4. 卖出处理器和监控任务处理器长期等待 fresh，系统局部卡住。

因此，成交后刷新必须保留独立时间排空入口，不能再绑定到市场事件推进。

### 5.5 自动寻标与周期换标不能绑到市场事件

当前 `AUTO_SYMBOL_TICK` 是每个 tick 都调度一次，用于：

1. 空席位自动寻标。
2. 周期换标到期判断。
3. 周期换标 pending 状态推进。

这些逻辑依赖当前时间和席位状态，不依赖最新 quote 是否刚发生变化。

因此，`AUTO_SYMBOL_TICK` 必须从 market processing 中拆出，转移到 time-driven scheduler。

---

## 6. 结论

本次重构是可行且合理的，但必须严格限定为：

1. 行情推进链路事件驱动化。
2. 纯时间链路继续保留独立 1 秒 heartbeat。

最终形态不是“没有循环”，而是“取消大而全的市场消费主循环，改为两个职责单一的调度器”：

1. `MarketDrivenScheduler`
2. `TimeDrivenScheduler`

这是唯一能同时满足以下目标的方案：

1. 减少无行情变化时的空转 monitor 推进。
2. 保持当前 1 秒最大推进频率。
3. 不破坏生命周期、末日保护、周期换标、订单超时、延迟验证等时间语义。

---

## 7. 目标架构

## 7.1 总体结构

本次重构后，运行时应拆成三个并列调度源：

1. 市场数据事件源
2. 时间事件源
3. 订单推送事件源

其中：

1. 市场数据事件源负责触发 monitor 级市场处理。
2. 时间事件源负责维持所有非市场语义。
3. 订单推送事件源继续由现有 order monitor WebSocket 流处理，并通过 runtime store / refreshGate 向其余模块传播状态。

## 7.2 MarketDrivenScheduler

职责：

1. 监听 quote push 与 candlestick push。
2. 将高频事件合并到 1 秒窗口。
3. 单飞执行 monitor 级市场处理。
4. 若执行期间又有新市场事件，结束后再补跑一轮。

核心约束：

1. 1 秒窗口内最多启动一次市场处理。
2. 真正执行时读取的是“当前最新 quotesMap”，不是首次事件携带的旧快照。
3. 市场处理过程中不得混入生命周期、末日保护、周期换标心跳等纯时间职责。

## 7.3 TimeDrivenScheduler

职责：

1. 每秒执行一次纯时间 heartbeat。
2. 计算交易时段、开盘保护与生命周期状态。
3. 推进 `dayLifecycleManager.tick()`。
4. 执行末日保护窗口检查。
5. 同步运行时订阅集合。
6. 调度 `AUTO_SYMBOL_TICK`。
7. 处理延迟验证采样 heartbeat。
8. 排空 `pendingRefreshSymbols`。
9. 触发订单监控中的时间驱动部分。

核心约束：

1. TimeDrivenScheduler 不负责 `processMonitor()`。
2. TimeDrivenScheduler 不再每秒全量读取行情后推进 monitor 业务。
3. TimeDrivenScheduler 可以按需从本地缓存读取最新 `quotesMap`，但只用于时间链路附属功能，例如刷新展示、排空刷新任务、订单时间检查，不得重新承担市场推进入口。

---

## 8. 职责重新分配

## 8.1 市场驱动职责

以下职责归入 `MarketDrivenScheduler`：

1. 获取当前 active symbols 的 `quotesMap`。
2. 并发执行每个 `monitorSymbol` 的 market cycle。
3. 在 market cycle 中：
   1. `syncSeatState`
   2. `scheduleRiskTasks`
   3. `runIndicatorPipeline`
   4. `runSignalPipeline`
4. 触发订单监控的报价驱动部分。

## 8.2 时间驱动职责

以下职责归入 `TimeDrivenScheduler`：

1. 交易日信息与连续交易时段判断。
2. 开盘保护状态切换。
3. `dayLifecycleManager.tick()`。
4. 末日保护撤单与清仓窗口。
5. 运行时订阅集合增减同步。
6. `AUTO_SYMBOL_TICK` 调度。
7. 存在待验证信号时的 indicator sampling。
8. `trader.getAndClearPendingRefreshSymbols()` 的排空与 `postTradeRefresher.enqueue(...)`。
9. 订单监控时间驱动检查。

## 8.3 Order Push 继续保持现状

以下职责继续由现有 order push 流承担：

1. 订单状态接收。
2. 终态结算。
3. 订单记录与待成交卖出占用更新。
4. `refreshGate.markStale()`。
5. 待刷新标的写入 runtime store。

本次不改 order push 的业务语义，只改变“谁来消费 pending refresh”。

---

## 9. 详细重构方案

## 9.1 新增统一市场数据事件接口

### 目标

让上层调度器不直接感知 Longbridge SDK 的 `setOnQuote` / `setOnCandlestick`，而是只订阅内部稳定事件。

### 修改范围

1. `src/types/services.ts`
2. `src/services/quoteClient/index.ts`
3. 新增必要的 market event types

### 设计要求

`MarketDataClient` 必须新增对外事件注册接口，至少满足以下能力：

1. 订阅市场数据更新事件。
2. 事件来源覆盖 quote push 与 candlestick push。
3. 事件通知不携带重量级数据快照，只传递“哪些 symbol 发生了市场数据更新”或统一的 dirty 通知。

推荐抽象：

1. `onMarketDataUpdated(listener)`
2. `offMarketDataUpdated(listener)` 或返回 unsubscribe

不建议让上层继续分别依赖 `onQuote` 与 `onCandlestick`，因为本次重构的目标是“由市场数据驱动 monitor processing”，而不是“由 quote 接口细节驱动业务”。

## 9.2 拆分现有 mainProgram

### 目标

将当前 `src/main/mainProgram/index.ts` 中混合的职责拆成两个独立运行单元。

### 新边界

建议拆成以下两个运行函数：

1. `runTimeDrivenTick(params)`
2. `runMarketDrivenCycle(params)`

其中：

1. `runTimeDrivenTick` 只处理纯时间职责。
2. `runMarketDrivenCycle` 只处理 monitor 级市场推进职责。

### 必须移出 runMarketDrivenCycle 的职责

以下职责不能继续留在市场驱动函数中：

1. `dayLifecycleManager.tick`
2. 交易时段判断
3. 开盘保护切换
4. 末日保护检查
5. `AUTO_SYMBOL_TICK`
6. `pendingRefreshSymbols` 排空
7. 订单超时检查

## 9.3 引入 MarketDrivenScheduler

### 目标

实现“收到市场数据更新后，在 1 秒内最多执行一次 market cycle”的单飞调度器。

### 调度语义

1. 第一个市场事件到达时，开启 1 秒计时器。
2. 1 秒内再次收到市场事件，只标记 dirty，不新增更多计时器。
3. 计时器到期后执行一次 `runMarketDrivenCycle`。
4. 若执行期间又有新的市场事件，则执行结束后再开启下一轮 1 秒窗口。

### 单飞约束

必须保证：

1. 任意时刻最多只有一个 `runMarketDrivenCycle` 在执行。
2. 不允许并发地对同一批 monitor contexts 运行多个 market cycle。
3. 补跑机制只能保留“最新 dirty 状态”，不能排队堆积多轮历史事件。

这与当前 `OrderMonitorWorker` 的“最新覆盖”策略一致，可直接复用类似模式。

## 9.4 引入 TimeDrivenScheduler

### 目标

保留 1 秒 heartbeat，但只承接纯时间职责。

### 每秒 heartbeat 的固定顺序

建议固定为：

1. 计算当前 `now`
2. 刷新交易时段与开盘保护状态
3. 执行 `dayLifecycleManager.tick(now, runtimeFlags)`
4. 若生命周期门禁未放行，提前返回
5. 执行末日保护检查
6. 同步运行时 quote 订阅集合
7. 为每个 monitor 调度 `AUTO_SYMBOL_TICK`
8. 对存在 pending delayed signals 的 monitor 执行 indicator sampling
9. 执行订单监控 time-driven checks
10. 排空 `pendingRefreshSymbols`

该顺序不能任意更改，原因如下：

1. 生命周期门禁必须先于后续所有时间链路。
2. 末日保护必须在正常 monitor processing 前生效。
3. 订阅同步必须在新一轮市场事件消费前尽快完成。
4. 延迟验证采样必须在生命周期门禁放行后进行，避免跨日脏数据。

## 9.5 从 processMonitor 中移出 AUTO_SYMBOL_TICK

### 当前问题

当前 `scheduleAutoSymbolTasks()` 在 `processMonitor()` 里既调度：

1. `AUTO_SYMBOL_TICK`
2. `AUTO_SYMBOL_SWITCH_DISTANCE`

这意味着周期换标与自动寻标当前被错误地绑定到了 market processing 入口。

### 新要求

拆分后应改为：

1. `AUTO_SYMBOL_TICK` 只由 `TimeDrivenScheduler` 调度。
2. `AUTO_SYMBOL_SWITCH_DISTANCE` 继续由 market cycle 中的价格变化判断触发。

这样才能保持：

1. 自动寻标和周期换标继续按时间推进。
2. 距离换标继续由市场价格变化驱动。

## 9.6 拆分订单监控

### 目标

将当前 `quoteFlow` 中混合的时间职责与报价职责拆开。

### 新职责划分

建议拆成：

1. `processQuoteDrivenChecks(quotesMap)`
2. `processTimeDrivenChecks(now)`

其中：

1. `processQuoteDrivenChecks` 负责基于最新价格做改单。
2. `processTimeDrivenChecks` 负责买单超时、卖单超时、撤单重试、转市价判断。

### 新 worker 结构

`OrderMonitorWorker` 也应随之拆出两个调度入口：

1. `scheduleQuoteDriven(quotesMap)`
2. `scheduleTimeDriven(now)`

两者内部仍应保持单飞和最新覆盖，但不能互相污染职责。

## 9.7 延迟验证采样心跳

### 目标

在移除“主循环每秒无条件 push indicator snapshot”之后，保留延迟验证的时间采样语义。

### 新机制

新增一个 `DelayedVerificationSamplingTick`，由 `TimeDrivenScheduler` 每秒检查：

1. 哪些 `monitorContext.delayedSignalVerifier` 当前存在 pending signal
2. 仅对这些 monitor 执行一次 indicator sampling

采样规则：

1. 读取当前 monitor 的 realtime candlestick cache 和 quote cache
2. 构造当前 indicator snapshot
3. push 到 `indicatorCache`
4. 不执行 `runSignalPipeline`
5. 不执行风险任务与信号分流

这样可以保持：

1. 延迟验证仍有稳定 1 秒采样点。
2. 无 pending delayed signal 的 monitor 不会产生多余 heartbeat 成本。

## 9.8 成交后刷新排空机制

### 目标

移除“依赖下一轮 market cycle 才顺带排空 pending refresh”的隐式耦合。

### 新机制

由 `TimeDrivenScheduler` 每秒执行：

1. `const pending = trader.getAndClearPendingRefreshSymbols()`
2. `pending.length > 0` 时读取当前 active symbols 的本地 `quotesMap`
3. 调用 `postTradeRefresher.enqueue({ pending, quotesMap })`

这样保持了与当前系统一致的上限：

1. 成交后最晚下一秒开始刷新
2. 不再依赖是否发生新的市场事件

---

## 10. 模块级改造清单

## 10.1 需要新增的模块

建议新增以下模块：

1. `src/app/runtime/createMarketDrivenScheduler.ts`
2. `src/app/runtime/createTimeDrivenScheduler.ts`
3. `src/main/runtime/runMarketDrivenCycle.ts`
4. `src/main/runtime/runTimeDrivenTick.ts`
5. `src/core/trader/orderMonitor/timeFlow.ts`
6. `src/main/runtime/delayedVerificationSampler.ts`

是否使用以上精确命名可按现有目录风格调整，但职责拆分本身必须存在。

## 10.2 需要修改的核心模块

1. `src/types/services.ts`
2. `src/services/quoteClient/index.ts`
3. `src/app/runApp.ts`
4. `src/main/mainProgram/index.ts`
5. `src/main/processMonitor/index.ts`
6. `src/main/processMonitor/autoSymbolTasks.ts`
7. `src/core/trader/orderMonitor/quoteFlow.ts`
8. `src/main/asyncProgram/orderMonitorWorker/index.ts`
9. `src/main/asyncProgram/delayedSignalVerifier/index.ts`
10. `src/main/asyncProgram/indicatorCache/index.ts`

## 10.3 不应改动业务语义的模块

以下模块允许适配调度入口，但不允许改动业务判定逻辑：

1. `src/core/strategy/*`
2. `src/core/signalProcessor/*`
3. `src/core/riskController/*`
4. `src/services/autoSymbolManager/autoSearch.ts`
5. `src/services/autoSymbolManager/switchStateMachine.ts`
6. `src/core/doomsdayProtection/*`
7. `src/main/lifecycle/*`

---

## 11. 执行顺序

为了避免重构过程中逻辑漂移，实施顺序必须固定。

## 阶段 1：建立市场数据事件接口

目标：

1. `MarketDataClient` 暴露统一市场事件注册接口。
2. quote push 和 candlestick push 都能对外发出 dirty 通知。
3. 不改变现有主循环逻辑。

验收：

1. 现有行为不变。
2. 新接口可被测试替身稳定驱动。

## 阶段 2：拆出时间驱动函数和市场驱动函数

目标：

1. 从现有 `mainProgram` 中拆出 `runTimeDrivenTick`。
2. 从现有 `mainProgram` 中拆出 `runMarketDrivenCycle`。
3. `runApp` 仍可暂时保留原 1 秒循环调用二者，确保重构第一步先做职责解耦，再做触发方式替换。

验收：

1. 业务行为与当前一致。
2. 旧主循环只剩“按顺序调用两个新函数”的编排逻辑。

## 阶段 3：拆分 AUTO_SYMBOL_TICK 和订单监控时间流

目标：

1. `AUTO_SYMBOL_TICK` 从 market cycle 中移除。
2. `AUTO_SYMBOL_TICK` 改由 `runTimeDrivenTick` 调度。
3. 订单监控拆出 `timeFlow`。

验收：

1. 无市场事件时，自动寻标、周期换标、订单超时仍正常推进。
2. 市场事件到达时，只执行真正需要的价格驱动部分。

## 阶段 4：引入延迟验证采样 heartbeat

目标：

1. 在没有市场事件时，仍能为 pending delayed signals 维持 1 秒 indicator sampling。
2. 采样 heartbeat 不执行信号生成。

验收：

1. 延迟验证场景下，`T0/T0+5s/T0+10s` 采样可持续命中。
2. 静默市场下不会因样本缺失导致语义漂移。

## 阶段 5：引入 MarketDrivenScheduler

目标：

1. 将 market cycle 的触发方式从固定 1 秒调用改成市场事件合并触发。
2. 保留 1 秒窗口和单飞语义。

验收：

1. 无市场数据变化时，不再运行 `runMarketDrivenCycle`。
2. 高频市场数据变化时，最多每秒运行一次。

## 阶段 6：收缩 runApp 顶层循环

目标：

1. 移除“每秒调用 market cycle”的旧逻辑。
2. 保留 `TimeDrivenScheduler` 的独立 heartbeat。
3. 将 `runApp` 顶层运行入口改成“启动两个 scheduler 并等待退出”。

验收：

1. 主体 monitor processing 已完全由市场事件触发。
2. 时间链路继续稳定运行。

---

## 12. 验证方案

## 12.1 单元测试

至少需要补充以下单测：

1. `MarketDrivenScheduler` 的 1 秒合并窗口。
2. `MarketDrivenScheduler` 的单飞与补跑语义。
3. `MarketDataClient` 对 quote/candlestick push 的统一 dirty 事件发布。
4. `OrderMonitor` quote flow 与 time flow 拆分后的职责隔离。
5. `DelayedVerificationSampler` 在 pending signals 存在时每秒写样本。

## 12.2 集成测试

至少需要覆盖以下集成场景：

1. 高频 quote push 1 秒内多次到达，只推进一次 monitor processing。
2. 无 quote push，但存在 pending delayed signal，10 秒后验证仍可命中采样点。
3. 无 quote push，但卖单超时，time-driven order monitor 仍会触发撤单转市价。
4. 无 quote push，00:00 跨日时 lifecycle 仍能切换到午夜清理。
5. 无 quote push，开盘后 open rebuild 仍会触发。
6. 无 quote push，周期换标到期仍会进入 pending 或换标。
7. 订单成交后无后续 quote push，postTradeRefresher 仍能在 1 秒内排空刷新。
8. 仅 candlestick push 触发时，monitor 指标链路仍会推进。

## 12.3 关键回归点

本次必须重点回归以下既有业务：

1. 开盘保护期间只禁止信号生成，不阻断自动寻标和风险任务。
2. 周期换标仍按交易时段累计时间计算。
3. 延迟验证仍按三点时间序列判定。
4. 末日保护仍在时间窗口首次进入时执行一次撤买，在最后 5 分钟执行清仓。
5. 生命周期门禁关闭时，market scheduler 和 time scheduler 都不会绕过门禁提交交易。

---

## 13. 验收标准

完成本次重构后，必须同时满足以下标准：

1. monitor 级行情推进不再由固定 1 秒主循环驱动。
2. market processing 由统一市场数据事件触发。
3. market processing 具备 1 秒合并节流与单飞补跑语义。
4. quote push 与 candlestick push 都能触发 market dirty。
5. `AUTO_SYMBOL_TICK` 已从 market processing 中移出。
6. 延迟验证仍能获得稳定采样点。
7. 订单超时与改单逻辑已明确拆分为 time-driven / quote-driven 两类。
8. `pendingRefreshSymbols` 不再依赖下一轮 market processing 才能排空。
9. 生命周期、末日保护、周期换标、开盘保护语义保持不变。
10. `bun lint` 通过。
11. `bun type-check` 通过。
12. 新增与受影响测试全部通过。

---

## 14. 最终结论

本次需求是正确的，但必须按“职责拆分”而不是“替换触发器”来做。

正确方案不是：

1. 保留现有 `mainProgram` 不变。
2. 把它从每秒调用改成 quote push 时调用。

因为这样会把时间语义错误地并入市场事件语义。

正确方案只能是：

1. 把现有主循环拆为 `MarketDrivenScheduler + TimeDrivenScheduler`。
2. 让市场数据事件只负责推进 monitor 级市场处理。
3. 让所有纯时间链路继续由独立 heartbeat 维持。
4. 为 K 线事件和延迟验证采样建立显式补偿机制。

在这个前提下，本次重构既能达到你要的目标：

1. 没有新市场数据时，不再每秒空转推进 monitor 业务。
2. 有新市场数据时，能在 1 秒内尽快推进业务。

又不会破坏系统当前最关键的时间语义与一致性约束。
