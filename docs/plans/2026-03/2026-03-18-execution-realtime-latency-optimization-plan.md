# 成交实时性与价格漂移最短路径优化方案

> 日期：2026-03-18 范围：只优化成交实时性、应用侧延迟与价格漂移问题；不改动任何交易业务规则、风控口径、生命周期语义与清仓语义。目标：在保持现有“主循环 + 异步处理器 + 生命周期门禁”总体骨架不变的前提下，以最短路径提升窝轮 / 牛熊证自动交易中的价格感知速度、追价反应速度与订单快速成交性。

## 1. 文档目的

本文档用于对“是否能在现有 Longbridge SDK 与当前代码结构下，提高成交实时性、降低延迟与 drift/slippage”这一问题做一次完整复核，并给出一套**最短路径、非补丁式、严格限定边界**的改造方案。

本文档只回答以下问题：

1. Longbridge OpenAPI / Node.js SDK 在实时行情、订单状态、改单撤单方面，哪些能力已经具备。
2. 当前仓库中，哪些环节真正导致了成交链路滞后与价格漂移。
3. 在**不改交易业务规则**的前提下，最短路径应该改哪里、不该改哪里。
4. 最终应落成什么样的架构边界、文件边界与测试边界。

本文档明确不讨论以下方向：

1. 不重写主程序整体架构。
2. 不重构信号生成规则、延迟验证规则、风控规则、保护性清仓规则、末日保护规则。
3. 不通过删除 `refreshGate`、生命周期门禁、席位一致性校验等方式换取表面上的“速度提升”。
4. 不引入兼容式双轨方案，例如“旧快照追价逻辑保留，同时旁路新增一套新逻辑”。
5. 不把问题错误地收敛为“只调几个时间参数”。

---

## 2. 边界与约束

### 2.1 本次方案的刚性边界

用户已明确要求：

1. 方案必须严格限定为**实时性 / 延迟 / 漂移优化**。
2. 不允许顺带修改任何交易业务规则与风控口径。
3. 不允许兼容性补丁式方案。
4. 必须走最短路径，但不能牺牲逻辑正确性。

因此，本次方案中的“最短路径”固定解释为：

1. 保留现有 `mainProgram` 主循环骨架。
2. 保留现有异步处理器边界：`buyProcessor`、`sellProcessor`、`monitorTaskProcessor`、`orderMonitorWorker`、`postTradeRefresher`。
3. 保留现有生命周期、交易门禁、刷新门禁、席位一致性与订单记录口径。
4. 仅重构**价格敏感执行链路**：行情订阅输入面、订单监控取价模型、订单监控调度优先级、执行前实时取价口径。

### 2.2 本次方案不允许触碰的业务语义

以下语义被视为业务不变量，本次禁止修改：

1. `mainProgram` 的交易日 / 交易时段 / 开盘保护 / 生命周期门禁语义。
2. `buyProcessor` 的风险检查顺序、买入拒绝语义、买入冷却语义。
3. `sellProcessor` 的刷新等待、智能平仓、保护性清仓、末日清仓语义。
4. `monitorTaskProcessor` 的浮亏、距回收价、自动寻标、周期换标语义。
5. `orderMonitor` 的成交结算、撤单确认、终态确认、超时转市价业务边界。
6. `refreshGate` 的 stale/fresh 语义。
7. `OrderRecorder`、`OrderHoldRegistry`、`DailyLossTracker`、保护性清仓 episode tracker 的业务语义。

换句话说，本次不是“为了更快成交而重写交易逻辑”，而是“在现有交易逻辑不变的前提下，让系统更快地看到价格、判断价格、追踪价格”。

---

## 3. SDK 能力复核结论

### 3.1 Longbridge SDK 已明确具备的能力

经本地参考文档与官方 Node.js 文档复核，Longbridge SDK 已明确支持：

1. `QuoteContext` 长连接行情上下文。
2. `subscribe(symbols, subTypes)` 行情订阅。
3. `SubType.Quote` / `SubType.Depth` / `SubType.Trade` 等实时数据通道。
4. `realtimeQuote`、`realtimeDepth`、`realtimeTrades` 等读取当前实时状态的能力。
5. `TradeContext` 的 `submitOrder`、`cancelOrder`、`replaceOrder`。
6. `TopicType.Private` + `setOnOrderChanged(...)` 订单状态实时推送。
7. `OrderType.LO` / `ELO` / `MO` 等订单类型。

这说明：

1. SDK 不缺“更实时地读行情”的能力。
2. SDK 不缺“更实时地跟单/改单”的能力。
3. SDK 也不缺“订单状态 push 驱动”的能力。

### 3.2 SDK 做不到的事情

SDK 没有提供，也不能假设提供以下能力：

1. 交易所级超低延迟保证。
2. 券商路由级最佳执行保证。
3. 自动追价成交引擎。
4. 港股窝轮 / 牛熊证的“最优订单类型”自动判定。
5. 自动把你的业务系统从节拍式处理变成事件驱动。

因此，本次优化的正确方向不是“更换 SDK”，而是“把现有系统用 SDK 的方式改对”。

---

## 4. 当前系统事实复核

## 4.1 当前行情链路并非纯轮询，而是“订阅 realtime + 主循环节拍消费”

当前 `src/services/quoteClient/index.ts` 已经确认：

1. `getQuotes()` 直接从 SDK `ctx.realtimeQuote(...)` 读取。
2. `createMarketDataClient()` 会创建长期复用的 `QuoteContext`。
3. 当前应用层已经不再维护动态 `quoteCache`，而是依赖 SDK realtime 状态。

因此，当前系统的主要问题不是“还在 HTTP 拉行情”，而是：

1. 已有 realtime 数据，
2. 但上层业务仍主要按主循环节拍去消费这些 realtime 状态，
3. 且对最敏感的订单跟价链路消费得不够及时。

## 4.2 当前只订阅了 `Quote`，没有把 `Depth` / `Trade` 接入到内部行情模型

当前 `subscribeSymbols()` 只订阅：

- `SubType.Quote`

这意味着系统目前看到的是：

1. `lastDone` 级别的当前价。
2. 但看不到最关键的盘口侧信息与逐笔成交节奏。

对窝轮 / 牛熊证，这会直接导致：

1. 看见的“当前价”不等于可立即成交价。
2. 追价与改单缺少盘口依据。
3. 更容易在 spread 扩大或深度突变时出现 drift。

## 4.3 当前 `orderMonitor` 依赖主循环尾部下发的 `quotesMap`

当前 `src/main/mainProgram/index.ts` 的顺序是：

1. 批量获取 `quotesMap`。
2. 并发跑完所有 `processMonitor(...)`。
3. `Promise.allSettled(monitorTasks)` 完成。
4. 再调用 `orderMonitorWorker.schedule(quotesMap)`。

这意味着：

1. 订单监控天然被放在 monitor 业务之后。
2. `orderMonitorWorker` 消费的是某一轮主循环快照，而不是执行当下最新 realtime 状态。
3. 已到达 SDK 的新价格，不能立刻进入追价判断。

## 4.4 当前 `orderMonitorWorker` 是“最新覆盖”单飞行，但输入仍是主循环快照

`src/main/asyncProgram/orderMonitorWorker/index.ts` 当前采用：

1. `schedule(quotesMap)` 记录 latestQuotes。
2. 若当前无 inFlight 任务，立即执行。
3. 若 inFlight 中，则覆盖待执行快照，避免堆积。

这个模型本身是合理的：

1. 保证单飞行。
2. 避免旧快照排队。

但它的问题不在 worker 模型本身，而在输入来源：

1. 它拿到的是主循环下发的快照，
2. 而不是“当前这一刻”订单相关标的的最新 realtime 状态。

## 4.5 当前执行前最新价覆写方向是正确的，不能删

当前买卖执行路径已明确：

1. `buyProcessor` 会在执行前重新获取最新行情。
2. `sellProcessor` 也会在执行前重新获取最新行情。

这是正确的，因为它避免了：

1. 信号生成价格落后，
2. 执行时还继续用旧价下单。

本次方案不但不能删除这条链路，反而要把它与 `orderMonitor` 的取价口径统一。

---

## 5. 第一性原理分析

### 5.1 当前真正拖慢成交的不是“行情获取”，而是“价格敏感链路消费顺序”

从第一性原理看，一个自动交易系统在成交速度上的关键，不是“行情有没有到”，而是：

1. 行情到达后系统多久能看到。
2. 系统多久能把这个价格用于现有订单的改价/撤单/成交决策。
3. 决策时使用的是 `lastDone`、盘口价还是更陈旧的轮次快照。

当前系统已经完成了第 1 步的一半：

- SDK realtime 已经在接收实时行情。

但在第 2 步和第 3 步上仍有结构性延迟：

1. 订单监控在主循环中被后置执行。
2. 追价使用的是主循环快照。
3. 当前只订阅 `Quote`，缺少 `Depth/Trade`，无法更接近真实可成交状态。

### 5.2 对窝轮 / 牛熊证而言，`lastDone` 不是充分的成交参考价

对这类产品，真实成交速度更多取决于：

1. 买卖盘价格是否跳动。
2. 当前挂盘深度是否足够。
3. spread 是否突然拉大。
4. 最新成交是否在加速扫盘。

因此，只用 `quote.price`（近似 `lastDone`）做追价，会天然放大以下问题：

1. 买入改单追到了一个已经失真的价。
2. 卖出改单没有盯住真正的买盘承接价。
3. 当前价变化看起来不大，但盘口已经恶化。

结论：

- 若目标是“更快成交且更少 drift”，订单监控必须补上盘口侧输入。

### 5.3 真正的最短路径不是全量事件驱动，而是先把价格敏感链路从过时快照中解放出来

当前如果直接走“全系统事件驱动化重构”，会波及：

1. `mainProgram` 主循环结构。
2. `processMonitor` 推进时机。
3. 延迟验证样本节拍。
4. 自动寻标 / 周期换标的时间驱动逻辑。
5. 订单监控中的时间语义与报价语义拆分。

这条路线不是最短路径。

相反，最短路径应该是：

1. 保留现有主循环。
2. 保留 monitor 主链路按轮次推进。
3. 仅把订单监控与执行前取价这两条最敏感路径，升级为“更实时、更多盘口语义”的消费方式。

---

## 6. 不采用的方案

## 6.1 不采用“纯参数调优方案”

即不采用只调整以下参数的方案：

1. 主循环间隔 `TRADING.INTERVAL_MS`
2. `orderMonitorPriceUpdateInterval`
3. quote retry 间隔
4. timeout 参数

原因：

1. 这只能缓解，不改变结构性延迟。
2. 仍然保留“主循环快照 -> monitor 全跑完 -> orderMonitor 才开始”的顺序。
3. 这是典型补丁式修复，不符合本次要求。

## 6.2 不采用“全量事件驱动重构”

即不采用直接把全系统拆成：

1. `MarketDrivenScheduler`
2. `TimeDrivenScheduler`
3. `OrderDrivenScheduler`

并把 monitor、orderMonitor、delayedSignalVerifier、postTradeRefresher 全部改造成 push 驱动。

原因：

1. 范围显著超出最短路径。
2. 会波及大量非目标业务语义。
3. 本次目标是提高成交实时性，不是系统架构重写。

## 6.3 不采用“在旧逻辑外再旁挂一套快速改单逻辑”

即不采用：

1. 保留现有 `processWithLatestQuotes(quotesMap)` 逻辑不动。
2. 再新开一条旁路只给部分订单做快速追价。

原因：

1. 会形成双轨真相。
2. 后续无法保证两套改单逻辑行为一致。
3. 会把问题从“延迟”变成“状态竞争与重复改单”。

---

## 7. 最终方案（唯一推荐方案）

## 7.1 总体设计决策

本次唯一推荐方案是：

**保留现有主循环、异步处理器与业务门禁骨架，只重构价格敏感执行链路。**

具体由四个动作组成：

1. 行情输入面从 `Quote` 扩展到 `Quote + Depth + Trade`。
2. `orderMonitor` 不再只吃主循环尾部传入的 `quotesMap`，而是在执行时读取订单相关标的的最新 realtime 状态。
3. `orderMonitorWorker` 的主循环调度优先级前移。
4. 统一订单监控与执行前最新价覆写的取价口径。

该方案满足：

1. 不改业务规则。
2. 不重写主架构。
3. 明确降低结构性延迟。
4. 避免兼容式双轨。

---

## 8. 目标架构

## 8.1 行情输入层：扩展为 Quote + Depth + Trade，但不改 monitor 主调度模型

### 当前问题

当前 `MarketDataClient` 对外只暴露：

- `getQuotes(symbols)`

而且 `subscribeSymbols()` 内部只订阅 `SubType.Quote`。

这导致：

1. monitor 与 orderMonitor 上层都默认“实时行情 = lastDone”。
2. 系统完全缺少盘口与逐笔成交维度。

### 目标设计

`MarketDataClient` 维持现有 `getQuotes(...)` 接口不删除，但新增一组**仅用于价格敏感执行链路**的实时读取能力：

1. 仍保留 `Quote` 这一通用快照输出。
2. 新增最小化的 depth / trade 状态读取接口。
3. `subscribeSymbols()` 统一建立 `Quote + Depth + Trade` 三类订阅。

关键约束：

1. 不要求 monitor 主链路立即全面改成使用 depth/trade。
2. depth/trade 的首要消费方是 `orderMonitor` 与执行前取价决策。
3. 不允许在业务层到处散读 SDK 原始结构；必须在 `quoteClient` 内部先归一化为项目内部结构。

### 设计理由

这样做的收益最大、改动面最小：

1. 先把最关键的数据面补齐。
2. 不强迫所有调用方同步重写。
3. 为后续如需进一步事件驱动化保留正确数据基础。

---

## 8.2 订单监控层：从“主循环快照追价”改为“执行时读取最新 realtime 状态”

### 当前问题

当前 `OrderMonitor` 对外接口只有：

- `processWithLatestQuotes(quotesMap)`

其语义是：

1. 调用方提供一轮 `quotesMap`。
2. `orderMonitor` 在这份快照上判断超时、追价、改单。

问题在于：

1. 这份快照来自主循环。
2. 它天然晚于 SDK realtime 状态。
3. 它又被放在所有 monitor 任务后面调度。

### 目标设计

本次方案要求把 `OrderMonitor` 的“报价驱动部分”重构为：

1. `orderMonitorWorker` 在启动一次监控时，不再强依赖外部传入的旧 `quotesMap`。
2. 它应改为基于“当前 tracked orders 集合”收集需要的 symbol。
3. 然后从 `MarketDataClient` 的 realtime 能力读取这些 symbol 的最新状态。
4. 再由 `quoteFlow` 根据最新状态执行超时检查与追价决策。

注意：

1. 本次方案不是把 `OrderMonitor` 变成完全 push 驱动。
2. 也不是删除 worker。
3. 而是把 worker 的输入从“主循环旧快照”改为“执行时最新状态”。

### 设计理由

这样可以在不重写 `OrderMonitor` 整体模型的前提下，直接缩短：

`价格变化 -> worker 启动 -> 追价判断`

这一条链路中的滞后部分。

---

## 8.3 订单监控优先级：前移到 monitor 主处理之前

### 当前问题

当前 `mainProgram` 顺序是：

1. 先获取 `quotesMap`
2. 再并发跑所有 monitor
3. monitor 完成后才 schedule orderMonitorWorker

这会导致：

1. 已存在的挂单追价，优先级低于新一轮 monitor 业务推进。
2. 在快市中，最该抢时间的链路反而最晚开始。

### 目标设计

本次方案要求：

1. 主循环获取完本轮 `quotesMap` 并完成门禁判断后，
2. 先触发 `orderMonitorWorker`，
3. 再进入 monitor 级别的信号、指标、风控链路，
4. 最后保持 `postTradeRefresher` 的现有职责边界。

关键点：

1. `orderMonitorWorker` 不再依赖这份 `quotesMap` 作为唯一价格来源。
2. 但它的调度触发时机仍由主循环统一控制，确保不破坏整体运行结构。

### 设计理由

已有挂单是否快速成交，优先级应高于“是否生成新的交易信号”。

在不改变现有业务规则的前提下，把 `orderMonitor` 提前是最直接、收益最大的结构性优化。

---

## 8.4 统一目标价解析：从单一 `lastDone` 升级为“可成交参考价”

### 当前问题

当前 `quoteFlow.ts` 在追价逻辑里主要使用：

- `quote.price`

这在语义上等价于：

- 使用 `lastDone` 或近似当前价作为改单目标价

这对窝轮 / 牛熊证并不充分，因为：

1. 买入真正更相关的是卖盘侧报价。
2. 卖出真正更相关的是买盘侧报价。
3. `lastDone` 只能说明最近一笔成交，不代表当前可成交价。

### 目标设计

本次方案要求在 `orderMonitor` 内引入唯一的目标价解析器，例如可称为：

- `resolveTrackingTargetPrice(...)`

其规则固定如下：

1. 买单优先使用卖盘侧最佳可成交参考价。
2. 卖单优先使用买盘侧最佳可成交参考价。
3. 若 depth 缺失或无效，则退回 `quote.price`。
4. trade 数据只作为辅助信号，不直接替代盘口基准。
5. 不在该解析器内引入任何新的业务风控与降级策略。

### 设计理由

这一步是整套方案中降低 drift 的关键。

因为真正造成 drift 的，并不只是“慢”，而是“慢且盯错价”。

---

## 8.5 执行前取价口径统一：买卖执行器与订单监控必须共用同一套实时取价模型

### 当前问题

当前买卖执行器会在执行前重新获取最新价，这是正确的；但它们与 `orderMonitor` 的目标价口径并未明确统一。

若本次只改 `orderMonitor`，不改执行前取价口径，就会出现：

1. 盯单认为当前最优追价应基于盘口价。
2. 执行器提交新单却仍按另一套口径取价。

这会让系统同时存在两套“当前价真相”。

### 目标设计

本次方案要求：

1. 保留 `buyProcessor` / `sellProcessor` 执行前重新取价。
2. 但把它们统一接入与 `orderMonitor` 相同的实时目标价解析模型。
3. 统一后只保留一套“价格敏感执行价”的项目内部语义。

### 设计理由

只有这样，系统才能在：

1. 新单提交
2. 已有单追价
3. 卖单改价

这三个场景下保持一致的价格决策口径。

---

## 9. 文件修改范围

## 9.1 必改文件

### 1）行情输入层

- `src/services/quoteClient/index.ts`
- `src/types/services.ts`
- `src/types/quote.ts`

职责：

1. 扩展订阅面到 `Quote + Depth + Trade`。
2. 在 `quoteClient` 内建立项目内部的最小化实时行情聚合结构。
3. 向上暴露专用于价格敏感执行链路的最新状态读取能力。

### 2）订单监控层

- `src/core/trader/orderMonitor/index.ts`
- `src/core/trader/orderMonitor/quoteFlow.ts`
- `src/core/trader/orderMonitor/types.ts`
- `src/core/trader/types.ts`

职责：

1. 重构 `OrderMonitor` 的价格输入模型。
2. 引入统一目标价解析器。
3. 调整对外契约，使 worker 可在执行时读取最新 realtime 状态。

### 3）订单监控调度层

- `src/main/asyncProgram/orderMonitorWorker/index.ts`
- `src/main/asyncProgram/orderMonitorWorker/types.ts`
- `src/main/mainProgram/index.ts`

职责：

1. 前移 `orderMonitorWorker` 调度时机。
2. 从“接收旧 `quotesMap`”重构为“执行时拉最新订单相关状态”。
3. 保留单飞行与 latest overwrite 语义，不引入并发监控。

### 4）执行前取价统一层

- `src/main/asyncProgram/buyProcessor/index.ts`
- `src/main/asyncProgram/sellProcessor/index.ts`

职责：

1. 保留执行前最新价刷新。
2. 接入新的统一目标价解析口径。
3. 不改变买卖业务规则顺序。

## 9.2 明确不改的文件类别

以下文件本次最多只允许做编译适配，不允许承载业务变更：

1. `src/main/asyncProgram/monitorTaskProcessor/**`
2. `src/main/processMonitor/**`
3. `src/core/doomsdayProtection/**`
4. `src/main/lifecycle/**`
5. `src/core/risk/**`
6. `src/services/autoSymbolManager/**`

原因：

- 本次不是 monitor 规则重构，也不是风控重构。

---

## 10. 实施阶段（唯一实施顺序）

## 阶段一：补齐实时行情输入面

目标：

1. `quoteClient` 能稳定订阅并读取 `Quote + Depth + Trade`。
2. 项目内部形成统一最小实时行情结构。
3. 现有 `getQuotes()` 继续可用，避免无关调用方被迫重写。

完成标准：

1. 现有 monitor 主链路仍能运行。
2. 新增的 depth/trade 读取能力可以单独被测试调用。
3. 未订阅 symbol 的保护语义不被破坏。

## 阶段二：重构订单监控价格输入与目标价解析器

目标：

1. `quoteFlow` 不再把 `quote.price` 当作唯一目标价来源。
2. 买卖改单决策能基于盘口侧得到更接近可成交的参考价。
3. 盘口缺失时仍可退回 `quote.price`，但这是统一的显式退回，不是历史遗留隐式行为。

完成标准：

1. 买卖单跟价都走统一解析器。
2. 原有 timeout / cancel / replace 语义不变。
3. 跟价方向不被改变，只改变目标价输入质量。

## 阶段三：前移订单监控调度优先级，并改为执行时读取最新状态

目标：

1. `mainProgram` 在本轮行情与门禁准备完成后优先触发 `orderMonitorWorker`。
2. worker 在实际执行监控时读取最新 tracked order 相关 symbol 的实时状态。
3. 继续保持 latest overwrite + 单飞行语义。

完成标准：

1. `orderMonitorWorker` 不再以主循环 `quotesMap` 作为唯一真相。
2. 快速行情变化下，改单链路不必再等 monitor 业务全部完成。
3. 没有新增并发竞态。

## 阶段四：统一买卖执行器的执行前取价口径

目标：

1. `buyProcessor` 与 `sellProcessor` 的执行前取价和 `orderMonitor` 使用同一套解析模型。
2. 保留“执行时重新取价”的正确方向。
3. 不引入新的业务门禁，不改原有检查顺序。

完成标准：

1. 新单提交与已有单追价使用统一价格语义。
2. 系统内部不存在两套“实时执行价”解释。

---

## 11. 测试方案

## 11.1 必补单元 / 业务测试

### 行情层

应新增或扩展测试覆盖：

1. `quoteClient` 在订阅时会同时建立 `Quote + Depth + Trade` 订阅。
2. realtime depth / trade 读取的空值、缺失值、未 warm 场景。
3. 未订阅 symbol 调用时仍按当前严格语义报错。

### 订单监控层

重点覆盖 `tests/core/trader/orderMonitor.business.test.ts`：

1. 买单优先取卖盘侧价格。
2. 卖单优先取买盘侧价格。
3. depth 缺失时退回 `quote.price`。
4. 仅 trade 变化但 depth/quote 无效时，不允许生成错误追价目标价。
5. timeout / cancel / replace 的现有语义不被破坏。

### Worker 调度层

重点覆盖 `tests/main/asyncProgram/orderMonitorWorker/business.test.ts`：

1. latest overwrite 仍然成立。
2. 单飞行仍然成立。
3. worker 执行时读取的是最新 realtime 状态，而不是 schedule 当时的旧快照。
4. 主循环前移调度后，不会造成重复执行。

### 执行器层

重点覆盖：

- `tests/main/asyncProgram/buyProcessor/business.test.ts`
- `tests/main/asyncProgram/sellProcessor/business.test.ts`

至少验证：

1. 执行前实时取价仍然发生。
2. 新的目标价解析器接入后，买卖执行路径价格来源正确。
3. 原有业务拒绝条件、风控拒绝条件、刷新等待条件完全不变。

## 11.2 回归测试重点

必须回归以下整体验证：

1. `orderMonitor` 跟价逻辑回归。
2. 买卖执行业务测试全通过。
3. `mainProgram` 主循环业务测试无新增语义漂移。
4. 与 `postTradeRefresher`、`refreshGate` 相关的流程测试不回归。

---

## 12. 预期收益与风险边界

## 12.1 预期收益

本次方案落地后，预期能显著改善以下问题：

1. 已存在挂单的追价响应速度。
2. 订单监控对行情变化的感知时效。
3. 只看 `lastDone` 带来的目标价失真。
4. 快市中因 monitor 主链路后置调度带来的 drift。
5. 新单提交价与已有单追价价口径不统一的问题。

## 12.2 明确接受的边界

本次方案明确接受以下现实：

1. 这不是交易所级低延迟系统。
2. 不保证最佳成交价。
3. 不保证一定更高成交率；其目标是“更快反应 + 更少应用侧漂移”。
4. 不为追求速度而破坏现有一致性门禁。

## 12.3 明确不接受的结果

以下结果若出现，视为方案失败：

1. 为了更快追价而破坏风控口径。
2. 为了更快改单而绕过订单终态确认语义。
3. 为了更快执行而删除刷新门禁、生命周期门禁、席位一致性校验。
4. 同时存在两套价格敏感执行逻辑。
5. worker 改造后出现并发追价、重复改单或状态竞争。

---

## 13. 最终结论

本次问题的根因，不是 Longbridge SDK 不够实时，而是：

1. 当前系统虽然已经接入 SDK realtime，
2. 但只消费了 `Quote`，没有消费 `Depth/Trade`，
3. 并且把最敏感的订单监控链路放在了主循环尾部，
4. 又让它依赖主循环快照，而不是执行当下的最新 realtime 状态。

因此，**唯一正确的最短路径**不是全面事件驱动重构，也不是补丁式调参数，而是：

1. 扩展行情输入面到 `Quote + Depth + Trade`；
2. 让 `orderMonitor` 在执行时读取最新 realtime 状态；
3. 前移 `orderMonitorWorker` 调度优先级；
4. 统一 `orderMonitor` 与买卖执行器的目标价解析口径。

这条路线既能显著降低应用侧延迟与价格漂移，又不会破坏当前系统已经建立起来的交易业务不变量。
