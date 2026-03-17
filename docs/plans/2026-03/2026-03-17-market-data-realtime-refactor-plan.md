# 行情动态缓存下沉到 SDK realtime 状态的系统性重构方案

> 日期：2026-03-17  
> 范围：重构 `Quote` 行情读取链路、主循环临时快照模型、价格敏感执行路径与订单监控取价模型。  
> 目标：删除应用层重复维护的动态行情缓存，重构为“无本地动态 `Quote` 缓存 + `quote()` 仅用于 `prevClose` 初始化 + 当前价只从 SDK realtime 读取 + 买入无行情直接丢弃 + 其余需要行情的订单路径使用统一非阻塞 bounded retry”的市场数据模型，但不改变交易业务规则、生命周期规则、账户/持仓/订单等业务状态缓存语义。

## 1. 文档目的

本文档用于对以下需求进行一次完整、可执行、非补丁式的重构设计：

1. 重新分析当前程序是否真的采用“订阅推送 -> 本地缓存 -> 主循环读取缓存推进业务”的模型。
2. 判断是否可以删除应用层行情缓存，并在不引入新缓存的前提下正确使用 Longbridge SDK 的 `realtime*` 状态。
3. 判断这种方式是否合理，哪些缓存必须删除，哪些缓存绝对不能删除。
4. 判断“当前实现”和“直接读取 realtime 状态”在实时性上的真实差异。
5. 给出一套最短路径、单一真相、不可兼容双轨的具体重构方案。

本文档只讨论**动态市场数据读取模型**，不改变以下业务语义：

1. 交易时段与生命周期门禁。
2. 末日保护、周期换标、自动寻标、距离换标的业务规则。
3. 订单记录、浮亏缓存、风控冷却、延迟验证、席位状态等业务状态模型。
4. Longbridge SDK 订阅集合与交易通道能力边界。

本文档明确禁止以下错误方向：

1. 把“删除动态行情缓存”误解为“删除所有缓存”。
2. 把“直接读 realtime”误解为“所有链路都改成零散随时读取，失去同一轮处理的一致视图”。
3. 保留旧 `quoteCache` 的同时再新增一套 `realtimeQuote` 旁路，形成双轨真相。
4. 保留“当前不承担职责，但未来也许有用”的回调、接口或状态字段。
5. 在执行链路里继续使用上一轮主循环写入的旧行情快照，却把外层接口改名成 realtime。

---

## 2. 需求澄清

### 2.0 术语与范围定义

为避免实现者对相近概念做出不同理解，本方案中的下列术语采用固定含义：

1. **已订阅（subscribed）**：SDK 订阅请求已经成功建立，但不等于应用层已允许把该 symbol 作为 `getQuotes()` 的合法输入。
2. **已接入（admitted）**：当前批次 symbol 已完成静态信息、`prevClose` 初始化与订阅建立，正式进入本地可读域。
3. **合法输入域**：允许传入 `getQuotes()` 的 symbol 集合；其定义严格等同于“已接入”的 symbol 集合。
4. **warm / warmed realtime**：SDK realtime 状态已经形成可读的当前 `Quote` 快照；未 warm 时读取结果为 `null`。
5. **`null quote`**：仅表示“当前没有可用的 realtime `Quote` 快照”，不表示字段无效。
6. **字段无效 quote**：quote 对象存在，但某个订单路径所需字段（如 `price`、`lotSize`）缺失或无效；它与 `null quote` 是两类不同失败。
7. **普通买入（signal buy）**：由买入信号进入 buyProcessor 的买入执行路径；这一路径缺行情直接丢弃，不参与统一 quote retry。
8. **自动换标回补买入（auto-switch rebuy）**：属于自动换标状态机中的订单路径，虽然业务动作是“买入”，但不属于上面的“普通买入”；它受统一 quote retry 规则约束。
9. **quote retry**：统一的“行情未就绪”处理规则本身。
10. **retry intent**：一次性订单路径中的单个重试实例，由 coordinator 托管。
11. **retry state**：周期驱动路径中的运行态字段，例如 `attempts / nextRetryAt / exhausted`。
12. **reset event**：允许同一路径为同一业务实体重新开启新 retry 周期的业务事件；未发生 reset event 前，不允许无条件重建重试。

本次重构的精确定义不是“系统完全不再存在任何本地状态”，而是：

1. **应用层不再重复维护动态 `Quote` 行情快照缓存。**
2. **应用层不再保存动态 `Quote` 长期副本。**
3. **`quote()` 仅保留一个职责：在订阅时初始化 `prevClose` 元数据。**
4. **当前价格只从 SDK realtime 状态读取；若 symbol 尚未 warm，则普通读取返回 `null`，不再用 `quote()` 补当前价。**
5. **买入不参与 quote 重试；买入信号若在任一执行阶段发现行情无效，直接丢弃。**
6. **除买入外，其他需要行情才能提交/改单的订单路径统一进入“每秒一次、最多 30 次”的行情就绪重试。**
7. **该重试仅针对“行情缺失/行情字段未就绪”，不针对未订阅、SDK 报错、权限错误、门禁失败或其他业务失败。**
8. **该重试必须是非阻塞的，不能通过 `sleep` 或长时间 `await` 卡住主循环、处理器或 worker。**
9. **主循环仍可在单次 tick 内读取一份临时 `quotesMap` 快照，供本轮 monitor 处理保持一致视图。**
10. **K 线链路继续维持“订阅 + `realtimeCandlesticks` 读取”的现有模式；若不消费 K push 事件，则不保留无职责回调。**

这一定义非常重要。若把目标误解为“任何链路都不得生成临时快照”，会破坏单轮 monitor 处理的一致性。若把目标误解为“纯 `realtimeQuote` 必然可在订阅后立即读取”，则会直接破坏启动和重建链路。若把目标误解为“新订阅 symbol 没有 realtime 时必须再拉一次 `quote()` 补当前价”，则会把本次要删除的冗余设计重新引回来。若把目标误解为“所有读取遇到 `null` 都应自动重试”，又会把 monitor / 展示链路错误地变成阻塞流程。若把目标误解为“只改 `quoteClient.getQuotes` 的内部实现，其他链路不动”，又无法真正解决执行时价格陈旧问题。

---

## 3. 当前系统事实

### 3.1 当前 `Quote` 链路确实是“订阅推送 -> 应用层缓存 -> 主循环读取”

当前 [quoteClient](D:/code/Longbridge-Quantitative-Trading/src/services/quoteClient/index.ts) 的实现事实如下：

1. `QuoteContext.setOnQuote(...)` 接收 WebSocket `Quote` 推送。
2. 回调中调用 `handleQuotePush(event)`。
3. `handleQuotePush(event)` 将最新价格写入应用层 `quoteCache: Map<string, Quote>`。
4. `getQuotes()` 不调用 SDK realtime 接口，而是直接从 `quoteCache` 读取。

这说明当前 `Quote` 确实是“应用层缓存驱动”。

### 3.2 当前 `Candlestick` 链路已经是“订阅 + 直接读取 SDK realtime”

当前 [quoteClient](D:/code/Longbridge-Quantitative-Trading/src/services/quoteClient/index.ts) 明确写明：

1. `subscribeCandlesticks(symbol, period, tradeSessions)` 建立 K 线订阅。
2. `getRealtimeCandlesticks(symbol, period, count)` 直接调用 `ctx.realtimeCandlesticks(...)`。

当前 [indicatorPipeline](D:/code/Longbridge-Quantitative-Trading/src/main/processMonitor/indicatorPipeline.ts) 也是直接读取 `marketDataClient.getRealtimeCandlesticks(...)`。

因此，**K 线链路不属于本次需要推倒重来的对象**。当前冗余主要在 `Quote` 链路。

### 3.3 官方 Node.js SDK 文档已明确 `realtimeQuote` 不应被假设为“订阅后立即可读”

已确认事实如下：

1. 官方 Node.js SDK 文档中，`realtimeQuote` 的示例流程是：
   1. `subscribe(...)`
   2. 显式等待 `5s`
   3. 再调用 `realtimeQuote(...)`
2. 官方 Node.js SDK 文档中，`realtimeCandlesticks` 的示例流程同样是：
   1. `subscribeCandlesticks(...)`
   2. 显式等待 `5s`
   3. 再调用 `realtimeCandlesticks(...)`
3. 当前仓库安装的 `longbridge` SDK 类型定义中，`subscribe(symbols, subTypes)` 只有 2 个参数，不存在可在本仓库直接使用的“首次推送”参数。
4. 当前仓库安装的 `longbridge` SDK 类型定义中，`RealtimeQuote` 与 `PushQuote` 都不包含 `prevClose` 字段，只有 `SecurityQuote` 包含 `prevClose`。

因此，本次方案不能再基于任何“订阅后立即可读 realtime 状态”的假设继续设计。

### 3.4 当前主循环消费的是 `quotesMap` 临时快照

当前 [mainProgram](D:/code/Longbridge-Quantitative-Trading/src/main/mainProgram/index.ts) 每轮会：

1. 根据席位、持仓、待成交订单计算订阅集合。
2. 调用 `marketDataClient.subscribeSymbols(...) / unsubscribeSymbols(...)` 同步订阅。
3. 调用 `marketDataClient.getQuotes(nextSymbols)` 得到 `quotesMap`。
4. 把这份 `quotesMap` 传给：
   1. `processMonitor(...)`
   2. `orderMonitorWorker.schedule(quotesMap)`
   3. `postTradeRefresher.enqueue({ pending, quotesMap })`

这里的 `quotesMap` 在当前实现中是“从应用层 `quoteCache` 读出来的一轮批量快照”。

### 3.5 当前 `subscribeSymbols()` 之所以先调 `ctx.quote(...)`，并不只是为了 `prevClose`

当前 [quoteClient](D:/code/Longbridge-Quantitative-Trading/src/services/quoteClient/index.ts) 在 `subscribeSymbols()` 中先调用 `ctx.quote(newSymbols)`，然后把以下信息写入本地 `quoteCache`：

1. 当前价 `lastDone`
2. `prevClose`
3. 时间戳
4. `lotSize`
5. 静态信息

这说明当前实现里，`ctx.quote(newSymbols)` 还承担了“为新订阅 symbol 提供立即可用快照”的职责，而不仅是 `prevClose` 初始化。

本次重构会显式删除这一职责，只保留：

1. `prevClose` 初始化
2. 可能依赖 `SecurityQuote` 才能拿到的附属元数据初始化

### 3.6 当前 `MonitorContext` 又复制了一层行情副本

当前 [seatSync](D:/code/Longbridge-Quantitative-Trading/src/main/processMonitor/seatSync.ts) 会把 `quotesMap` 中的数据再写入：

1. `monitorContext.longQuote`
2. `monitorContext.shortQuote`
3. `monitorContext.monitorQuote`

这三者本质上是“上一轮主循环临时快照的镜像副本”。

### 3.7 当前价格敏感执行链路存在“上一轮快照陈旧”问题

当前 [buyProcessor](D:/code/Longbridge-Quantitative-Trading/src/main/asyncProgram/buyProcessor/index.ts) 明确使用：

1. `ctx.longQuote`
2. `ctx.shortQuote`
3. `ctx.monitorQuote`

来做：

1. 风险检查上下文中的当前价输入。
2. 执行前最终买入委托价与 `lotSize` 的读取。

但这些 `ctx.xxxQuote` 并不是执行当下实时读取，而是主循环上一轮同步写入的副本。因此：

1. 主循环频率若为 1 秒，则该价格可能天然落后接近 1 秒。
2. 异步任务排队后再执行时，陈旧程度可能更大。

### 3.8 当前订单监控同样依赖主循环下发的 `quotesMap`

当前 [orderMonitorWorker](D:/code/Longbridge-Quantitative-Trading/src/main/asyncProgram/orderMonitorWorker/index.ts) 的模型是：

1. 主循环调用 `schedule(quotesMap)`。
2. Worker 保存最新的 `quotesMap`。
3. 后续 `orderMonitor.processWithLatestQuotes(quotesMap)` 用这份数据做追价、改单、超时处理。

这同样说明订单追价链路读取的不是执行当下即时获取的行情，而是上一轮主循环汇总好的快照。

---

## 4. 第一性原理分析

### 4.1 业务真正需要的不是“回调事件对象”，而是“决策时刻的当前状态”

从第一性原理看，交易系统使用市场数据的方式只有两种：

1. **事件触发**
   1. 某个新市场数据到达。
   2. 系统知道“值得推进某个流程”。
2. **状态读取**
   1. 在真正判定、下单、改单、风控时。
   2. 系统读取“现在是什么状态”。

当前应用层 `quoteCache` 的本质并不是新的业务语义，只是把 SDK 已经接收到的推送再存一遍，供后续读取。

在本次目标架构下，判断某个 `Quote` 回调或接口是否应保留，只能问一个问题：

1. 它是否承担当前不可替代的业务职责。

若答案是否定的，则无论它是否“便于调试”“可以看错误”“未来可能用于事件驱动”，都不应保留。

### 4.2 当前 `quoteCache` 没有提供不可替代的业务价值

当前 `quoteCache` 不是：

1. 风控状态缓存。
2. 订单记录缓存。
3. 延迟验证样本缓存。
4. 跨日恢复缓存。

它只是：

1. SDK 已接收 `Quote` 推送后的二次镜像。
2. 用于构造 `Quote` 内部格式与补充静态字段。

因此，`quoteCache` 不是业务真相，只是应用层重复状态。

### 4.3 不能删除的是“业务状态缓存”，不是“所有缓存”

本次必须保留的状态包括：

1. 账户缓存 `cachedAccount`
2. 持仓缓存 `cachedPositions` 与 `positionCache`
3. 订单记录器中的买卖订单记录
4. 浮亏缓存
5. 冷却与风控状态
6. 延迟验证样本与指标快照
7. 席位状态与席位版本
8. `staticInfoCache`
9. `prevCloseCache`
10. 交易日缓存

原因很简单：这些状态不是 SDK realtime 能提供的；它们表达的是业务历史、业务归属、业务门禁或跨周期语义。

### 4.4 真正过度设计的是“动态行情快照被维护了三层”

当前 `Quote` 动态状态至少存在以下三层：

1. SDK 内部 realtime 状态。
2. 应用层 `quoteCache`。
3. 主循环 `quotesMap`。
4. `MonitorContext.longQuote/shortQuote/monitorQuote`。

其中：

1. 第 1 层是底层事实来源，必须保留。
2. 第 3 层作为单轮处理临时快照是合理的。
3. 第 2 层和第 4 层都属于可删除的重复镜像。

---

## 5. 实时性与延迟分析

### 5.1 “应用层 `quoteCache`”与“SDK realtime 状态”本身延迟差异很小

若只比较：

1. `setOnQuote` 回调把数据写入应用层 `quoteCache`
2. SDK 内部自己维护 realtime 状态

两者都来自同一个 WebSocket 推送源，差异通常只会是：

1. 一次额外对象构造
2. 一次额外 Map 写入
3. 一次额外 Map 读取

这部分延迟量级通常很小，不是主要矛盾。

### 5.2 当前更大的延迟来自“按主循环节拍消费”

当前更关键的延迟来源是：

1. 主循环按固定 tick 批量读取 `quotesMap`
2. `MonitorContext` 持有的是上一轮 tick 写入的 quote 副本
3. 异步执行器在稍后真正下单/改单时，继续读取这份副本

因此，当前链路中的主要延迟不是“`quoteCache` 比 SDK 慢”，而是：

1. **价格敏感路径没有在使用时刻读取最新状态**
2. **而是在某一轮主循环提前取了一份快照，后续继续沿用**

### 5.3 不同场景下的正确取价策略不同

必须区分两类场景：

1. **需要同轮一致视图的场景**
   1. `processMonitor` 中的一轮 monitor 处理
   2. 自动换标、席位同步、同一轮信号生成
   3. 这些场景允许使用单轮临时 `quotesMap`
2. **需要执行时最新价的场景**
   1. 买入委托价
   2. 卖出委托价
   3. 订单追价与改单
   4. 末日清仓实际下单前的最新价格
   5. 这些场景必须直接读取 realtime 状态

### 5.4 哪种方式延迟更低

结论只有一条：

1. **如果继续“主循环统一取快照，再在执行器里读快照”，当前实现延迟更高。**
2. **如果改成“执行当下直接读取 realtime 状态”，延迟更低。**
3. **如果只是把 `quoteCache` 的底层实现换成 `ctx.realtimeQuote()`，但外层仍每秒取一次并传下去，延迟不会有本质变化。**

因此，本次重构的核心收益不在于“删掉 `quoteCache` 这一层”本身，而在于：

1. 删除重复状态源。
2. 把价格敏感路径改成执行时读取 realtime。

---

## 6. 可行性与合理性结论

### 6.1 可行性结论

本次重构可行，理由如下：

1. Longbridge SDK 已提供 `realtimeQuote(...)`。
2. 当前系统已经具备订阅集合管理能力。
3. K 线链路已经使用了同类模式，说明系统架构可以容纳“订阅 + realtime 读取”。
4. 官方 SDK 文档已经证明 `realtimeQuote` 不保证订阅后立即可读，因此新订阅 symbol 必然存在 warm-up 空窗。
5. 当前业务链路中，大部分价格依赖逻辑在 `Quote | null` 下都已具备“跳过 / HOLD / 不触发”的退化路径。
6. `prevClose` 虽然不能从 realtime 获取，但可以在订阅阶段通过一次性 `quote()` 初始化，不必再承担当前价补齐职责。
7. 对于需要保留原有订单类型语义的订单路径，可以通过统一 bounded retry 等待 realtime warm-up，而不必回退到 `quote()` 补当前价或强制改订单类型。

### 6.2 合理性结论

本次重构合理，理由如下：

1. `Quote` 当前价的单一事实来源应收敛到 SDK realtime 状态。
2. 若业务要求保留现有订单类型语义，则在行情缺失时优先等待 realtime warm-up，比强制切换为 `MO` 或重新引入 `quote()` 当前价补齐更合理。
3. `prevClose` 属于附属元数据，不属于“当前价真相”，因此保留一次性 `quote()` 初始化是合理的。
4. 应用层重复镜像会增加状态不一致风险和维护成本。
5. 执行路径若继续依赖主循环快照，会天然放大价格陈旧问题。
6. 统一 bounded retry 必须只存在于订单路径，不能污染 monitor、展示和普通读取路径。
7. 本次重构不改变业务规则，只改变市场数据读取模型，边界清晰。

### 6.3 唯一推荐方案

唯一推荐方案不是以下任意一种：

1. 保留 `quoteCache`，同时另加 `getRealtimeQuotes()` 新接口并逐步切换。
2. 仅在 `quoteClient` 内把 `getQuotes()` 改成纯 realtime，继续假设订阅后立即可读。
3. 删除所有快照概念，让所有模块都各自零散调用 realtime 接口。

唯一正确方案只能是：

1. **删除应用层动态 `Quote` 缓存。**
2. **把 `quote()` 收缩为“订阅时一次性初始化 `prevClose` 元数据”的接口用途。**
3. **把 `getQuotes()` 重定义为纯 realtime 读取器：有 realtime 就返回 `Quote`，无 realtime 就返回 `null`。**
4. **新增统一的订单行情重试规则：买入除外；其余需要行情的订单路径在遇到 `null/无效 quote` 时，按“1 秒一次、最多 30 次”推进。**
5. **保留单轮主循环临时 `quotesMap` 快照，只用于 monitor 一致视图。**
6. **删除 `MonitorContext` 中的动态 quote 副本。**
7. **把买入改成“执行时缺行情直接丢弃”；把卖出、订单监控、末日保护、保护性清仓、距回收价清仓与自动换标改成：执行时读取 realtime，缺行情则按统一非阻塞规则推进重试，重试耗尽后放弃本次操作。**
8. **K 线维持现有 realtime 模型，但删除无职责的 push 回调。**

---

## 7. 目标架构

### 7.1 新的市场数据职责拆分

重构后 `MarketDataClient` 的职责应拆成三类：

### A. 订阅管理

职责：

1. 管理 `Quote` 订阅集合。
2. 管理 `Candlestick` 订阅集合。
3. 管理跨日退订与运行期重置。

### B. 元数据管理

职责：

1. 缓存 `staticInfo`
2. 缓存 `prevClose`
3. 缓存交易日信息

这些缓存不是动态市场快照，而是补充结构化行情所需的元数据。

### C. 当前 realtime 行情读取

职责：

1. `Quote` 当前价读取不再依赖本地动态缓存。
2. 对 `Quote` 的一次读取，只使用 `ctx.realtimeQuote(...)`。
3. 若某些已订阅 symbol 当前没有 warmed realtime 状态，则该 symbol 的读取结果直接为 `null`。
4. `Candlestick` 继续从 `ctx.realtimeCandlesticks(...)` 读取。

### D. 订单行情重试

职责：

1. 仅服务于订单路径，不服务于 monitor、展示或普通状态读取。
2. 买入不参与该重试。
3. 当其他订单路径需要 quote 且当前 realtime 结果为 `null` 或字段未满足该订单所需时，进入统一 bounded retry。
4. 重试参数固定为：
   1. 间隔 `1s`
   2. 最多 `30` 次
5. 每轮仅重读尚未就绪的 symbol 子集，避免重复请求已就绪标的。
6. 重试耗尽后直接放弃本次订单相关操作。
7. 重试必须是非阻塞的：
   1. 一次性订单路径使用 delayed re-enqueue
   2. 周期驱动路径复用既有 tick / worker 调度

这里的“字段未满足”必须按订单用途定义，而不是一律要求同一组字段：

1. 买入：要求 `price + lotSize`，但无行情直接丢弃，不重试
2. 卖出 / 清仓：要求 `price`
3. 订单追价：要求 `price`
4. 自动换标回补买入：要求 `price + lotSize`

本次方案不预留 `Depth` / `Trades` / `Brokers` 的扩展位。若未来真要引入，应在当时基于真实需求重新设计，而不是在本次文档中提前保留空位。

### 7.2 重构后的 `Quote` 单一真相

重构后 `Quote` 的单一事实来源定义为：

1. 应用层不再维护动态 `Quote` 长期副本。
2. 当前价格只来自 SDK realtime 状态。
3. `prevClose` 只来自订阅阶段的一次性 `quote()` 初始化。
4. `getQuotes()` 统一把 realtime 结果转换为内部 `Quote`；无 realtime 则返回 `null`。
5. 所有业务模块都只消费 `Quote | null` 结果，不再假设“新订阅 symbol 一定立即有当前价”。

### 7.3 临时 `quotesMap` 的合法地位

重构后仍允许存在 `quotesMap`，但语义必须改为：

1. **单轮处理临时快照**
2. **只在当前处理轮次内使用**
3. **不是长期缓存，不是动态真相**
4. **其中某些 symbol 允许为 `null`，表示 realtime 尚未 warm 或当前无有效行情**

因此：

1. `processMonitor` 可继续接收它。
2. 但异步执行器不应再持有并长期依赖它。

---

## 8. 模块级详细重构方案

### 8.1 `src/services/quoteClient/index.ts`

### 当前问题

当前模块同时承担：

1. 订阅管理
2. 元数据缓存
3. 应用层动态 `quoteCache`

其中第 3 项应删除。

### 目标改造

1. 删除 `quoteCache`
2. 删除 `handleQuotePush(event)` 中的动态缓存写入
3. 删除 `setOnQuote` 注册本身
4. 删除 `setOnCandlestick` 注册本身
5. `getQuotes()` 改为：
   1. 校验请求 symbols 是否已进入合法输入域（即已接入且仍处于订阅集合）
   2. 只调用 `ctx.realtimeQuote(symbols)` 读取当前 warmed realtime 状态
   3. 对有 realtime 的 symbol，用统一转换逻辑构造内部 `Quote`
   4. 对无 realtime 的 symbol，结果直接写 `null`
6. `subscribeSymbols()` 改为：
   1. 缓存静态信息
   2. 调用一次 `ctx.quote(newSymbols)`，只用于初始化 `prevCloseCache`
   3. 建立订阅
   4. 不再主动写入动态 quoteCache，也不再用 `quote()` 结果写入当前价
7. `unsubscribeSymbols()` 改为：
   1. 退订
   2. 清理订阅集合与元数据缓存
   3. 不再涉及动态 quoteCache
8. `resetRuntimeSubscriptionsAndCaches()` 改为：
   1. 退订 quote
   2. 退订 candlestick
   3. 清理 `staticInfoCache`
   4. 清理 `prevCloseCache`
   5. 清理交易日缓存

### 设计要求

1. `Quote` 构造逻辑必须统一，不允许在多个调用方重复拼装。
2. `getQuotes()` 对非法输入显式报错的语义必须保留；这里的非法输入包括未订阅、未完成接入、已退订和初始化失败的 symbol。
3. `prevClose` 只通过 `ctx.quote(...)` 结果建立，不从 push 或 `realtimeQuote` 推断。
4. `getQuotes()` 不能再假设订阅后立即存在 realtime 状态；缺失时必须直接返回 `null`。
5. 不再保留 `setOnQuote` 与 `setOnCandlestick` 作为“错误监控”或“未来扩展”钩子。
6. `subscribeSymbols()` 只有在 `prevCloseCache` 初始化成功后，才能把 symbol 视为本地“已接入”；否则不得进入正常读取路径。
7. `subscribeSymbols()` 在本次方案中采用批次原子语义：同一批 `newSymbols` 只有在静态信息、`prevClose` 初始化与订阅都成功后，才整体进入可读域；若任一环节失败，该批次不得出现“部分已接入、部分未接入但仍可被 `getQuotes()` 读取”的中间态。
8. `getQuotes()` 的合法输入域必须严格限定为“已经完成本地接入的 symbols”；未完成接入、已退订或初始化失败的 symbol 一律视为未订阅处理。

### 为什么 `setOnQuote` 必须直接删除

删除应用层 `quoteCache` 后，`setOnQuote` / `setOnCandlestick` 只剩下三种可能用途：

1. 继续维护本地动态状态。
2. 驱动当前真实业务流程。
3. 仅用于日志、错误监控或未来预留。

本次方案中：

1. 第 1 项已被明确删除。
2. 第 2 项当前不存在。
3. 第 3 项不构成保留理由。

因此，`setOnQuote` 与 `setOnCandlestick` 都不应“降级保留”，而应彻底删除。否则它们会把“推送回调仍是架构组成部分”这一错误信号继续留在系统里。

### 8.2 `src/types/services.ts`

### 目标改造

`MarketDataClient` 在本次方案中只保留一个公共 `Quote` 读取入口：

1. `getQuotes(symbols)`：
   1. 保留名称
   2. 语义改为“获取当前 realtime `Quote`：有 realtime 就返回 `Quote`，无 realtime 就返回 `null`”

执行路径即便只需要单个 symbol，也统一调用 `getQuotes([symbol])`。

补充契约：

1. `getQuotes()` 只接受“已完成接入”的 symbol 集合作为合法输入。
2. 对合法输入中的 symbol：有 warmed realtime 就返回 `Quote`，无 warmed realtime 就返回 `null`。
3. 对非法输入（未订阅、初始化失败、已退订、未完成接入）继续维持显式报错，不做隐式跳过。
4. `subscribeSymbols()` 的批次原子语义与 `getQuotes()` 的合法输入域必须保持一致，不允许出现接口层可表示但业务层非法的半接入状态。

原因：

1. `getQuote(symbol)` 只是 `getQuotes([symbol])` 的语法糖，没有新增业务语义。
2. 统一把“realtime 有值 / 无值返回 null”的契约封装在 `getQuotes()` 内，可以保证所有调用方都遵守同一条基础读取规则，再由订单路径显式决定是否进入统一重试。
3. 本次最短路径是统一所有读取都走同一条 realtime-only 路径，而不是再扩散第二套接口。

### 8.2A 统一订单行情重试规则

### 目标改造

新增一套统一的订单行情重试规则，职责只做一件事：

1. 接收一组 symbol
2. 接收“本次订单需要哪些 quote 字段才算就绪”的判定规则
3. 对未就绪 symbol 按固定参数重试 realtime 读取
4. 返回：
   1. 已就绪 quotes
   2. 仍未就绪的 unresolved symbols

### 适用范围

1. **不适用于普通买入（signal buy / buyProcessor）。**
2. 适用于：
   1. 卖出执行
   2. 订单监控追价/改单
   3. 末日保护清仓
   4. 保护性清仓
   5. 距回收价清仓
   6. 自动换标中的移仓卖出与回补买入

补充说明：

1. “买入不参与重试”只针对普通买入信号路径，不包含自动换标状态机中的回补买入。
2. 自动换标回补买入虽然业务动作是买入，但它属于状态机订单路径，其语义目标是完成已有 switch flow 的收口，因此纳入统一 quote retry。

### 固定规则

1. 重试间隔：`1s`
2. 最大重试次数：`30`
3. 上述 `1s * 30` 为真实时间（wall-clock）语义，不是“30 个 tick”语义；周期驱动路径也必须以 `nextRetryAt = now + 1000ms` 或等价方式表达，而不是按当前 tick 频率折算。
4. 仅在以下场景重试：
   1. `getQuotes()` 正常返回，但 quote 为 `null`
   2. quote 存在，但订单所需字段缺失或无效
5. 以下场景**不重试**：
   1. symbol 未订阅或未进入合法输入域
   2. SDK/网络/权限报错
   3. 生命周期门禁关闭
   4. 席位版本不匹配
   5. 任何其他业务失败

### 失败分类与处理动作表

| 失败类型 | 是否重试 | 处理方式 |
| --- | --- | --- |
| `null quote`（无可用 realtime 快照） | 是 | 按统一 quote retry 推进 |
| quote 存在但字段无效 | 是 | 按统一 quote retry 推进 |
| symbol 未订阅 / 未进入合法输入域 | 否 | 直接失败，暴露调用边界错误 |
| SDK / 网络 / 权限报错 | 否 | 直接失败，按原链路错误处理 |
| 生命周期门禁关闭 | 否 | 直接终止当前处理 |
| `seatVersion` 失配 / 席位归属失效 | 否 | 直接终止当前处理 |
| 其他业务校验失败 | 否 | 保持原有业务收口 |

### 设计要求

1. 重试器不能把 `getQuotes()` 改造成隐式阻塞接口。
2. 买入不得调用该重试逻辑。
3. 重试逻辑只能由订单路径显式调用。
4. 同一轮重试只轮询 unresolved symbols 子集。
5. 不允许在多个模块各自复制一套 `for + sleep(1000)` 逻辑。

### 非阻塞实现约束

统一重试规则必须按当前运行模型拆成两种载体，但两者共享同一套参数、同一套就绪判定与同一套耗尽语义：

1. **一次性订单路径**
   1. 适用：卖出执行、末日保护清仓、保护性清仓、距回收价清仓
   2. 载体：非阻塞的 retry coordinator / delayed re-enqueue
   3. 行为：首次发现 quote 未就绪时，注册 retry intent 并立即返回，绝不在当前处理器中 `sleep`
2. **已有周期驱动的订单路径**
   1. 适用：订单监控、自动换标状态机
   2. 载体：沿用现有每 tick / 每轮 worker 调度
   3. 行为：在运行态中记录 `attempts / nextRetryAt / exhausted`，由下一轮周期继续推进，绝不新增阻塞等待

### 恢复执行前的统一复核约束

所有 quote retry 都只能解决“行情未就绪”问题，不能把第一次失败前的业务校验结果直接沿用到恢复执行时刻。

1. 一次性订单路径在 quote 就绪后恢复执行前，必须重新校验当下业务边界，而不是假设首次注册 retry intent 时的判断仍然成立。
2. 恢复执行前至少必须重新校验：
   1. 生命周期门禁 / `getCanProcessTask`
   2. 若原链路要求刷新后再执行，则必须重新经过 `refreshGate`
   3. 当前交易时间窗口是否仍允许该动作（尤其是末日保护窗口）
   4. 当前席位归属、`seatVersion` 与 `validateSignalSeat(...)`
3. 任一复核失败时，必须直接终止当前 retry intent，不能继续使用旧任务、旧席位或旧时间窗口提交订单。
4. 恢复执行后仍必须使用恢复当下重新读取到的 realtime quote 作为唯一价格输入，不允许回退到首次失败时的旧 quote 或旧快照。

### 幂等与去重约束

1. 一次性订单路径的 retry coordinator 必须维护 active retry intent registry，防止同一业务动作被重复注册。
2. 同一业务键在同一时刻只允许存在一个活跃 retry intent；重复触发时应复用或忽略，而不是并行创建多个等待中的 intent。
3. retry intent 的业务键必须能表达真实业务唯一性，至少应包含：
   1. 路径类型
   2. `monitorSymbol` / `symbol`
   3. 方向或动作类型
   4. `seatVersion`
   5. 必要时再补充窗口键、订单标识或状态机流程标识
4. 周期驱动路径虽然不一定使用集中式 registry，但也必须通过运行态字段表达同等的去重语义，不能在每轮 tick 中反复创建新的等待状态。
5. 成功提交、明确耗尽、窗口失效、席位失效或流程终止后，必须及时清理或终结对应 retry 状态，避免旧 intent 残留。

### retry business key 与 reset 事件表

| 路径 | 建议 business key | 允许重建的新周期 / reset 事件 |
| --- | --- | --- |
| 末日保护清仓 | `DOOMSDAY_CLEARANCE + symbol + action + windowKey` | 新收盘窗口或新交易日 |
| 保护性清仓 | `PROTECTIVE_LIQUIDATION + monitorSymbol + symbol + action + seatVersion + triggerInstanceKey` | 新 `seatVersion`、新的风险触发实例 |
| 距回收价清仓 | `LIQUIDATION_DISTANCE + monitorSymbol + symbol + action + seatVersion + triggerInstanceKey` | 新 `seatVersion`、新的风险触发实例 |
| 订单监控 | `ORDER_MONITOR + orderId + action + orderStatusVersion` | 订单状态推进、tracked order 重新进入需要 quote 的新阶段 |
| 自动换标 | `AUTO_SWITCH + monitorSymbol + direction + seatVersion + switchFlowId + stage` | 新 switch flow 或当前 flow 进入新动作阶段 |

补充要求：

1. `windowKey`、`triggerInstanceKey`、`orderStatusVersion`、`switchFlowId` 不要求在本阶段先固定为某个现成字段名，但必须在实现前各自收敛为唯一、可测试、可清理的业务键。
2. 未发生 reset 事件前，不允许因为同一路径被下一轮 tick 或主循环再次触发，就无条件重建新的 retry intent。
3. 验证与测试必须覆盖“同一 business key 同时最多一个 active retry intent”。

### 重试载荷约束

1. retry intent 不得持有对象池中的 `Signal` 引用。
2. 一次性订单路径只能保存不可变的业务快照，并在真正恢复执行时重新构造 signal 或重新触发对应任务。
3. 对象池 signal 必须在当前处理器返回前释放，不能因为等待 quote 而长期占用。

### 耗尽后的业务收口语义

1. `30` 次耗尽只表示“当前这次 quote retry 已终结”，不等于所有后续业务触发都永久失效；但是否允许再次创建新 retry intent，必须按路径显式定义，不能默认下一轮立即无条件重建。
2. 末日保护清仓的耗尽范围应限定在“当前 symbol + 当前收盘窗口”；同一窗口内不得因为主循环重复触发而无限重建同一 intent。
3. 保护性清仓与距回收价清仓的耗尽范围应至少限定到当前 `seatVersion` 与当前风险触发实例；不得因为同一旧席位的重复任务而形成忙等式重建。
4. 订单监控的耗尽范围应绑定 tracked order 的当前状态；只有订单状态推进后，才允许重新开始新的 quote retry 周期。
5. 自动换标的耗尽范围应绑定当前 switch flow；耗尽后按现有失败语义收口，而不是在同一流程内无限等待。

### 8.3 `src/main/mainProgram/index.ts`

### 当前问题

当前 `mainProgram` 有两个问题：

1. `quotesMap` 不仅用于 monitor，还被继续传递到执行链路。
2. 末日保护发生在订阅集合同步之前，会让依赖 realtime 行情的订单路径先于订阅状态收敛。

### 目标改造

1. 先计算 `desiredSymbols`
2. 先执行 `subscribeSymbols(added)` / `unsubscribeSymbols(removableSymbols)`
3. 先更新 `lastState.allTradingSymbols`
4. 再执行所有依赖市场数据的动作：
   1. `doomsdayProtection.cancelPendingBuyOrders(...)`
   2. `doomsdayProtection.executeClearance(...)`
   3. `const quotesMap = await marketDataClient.getQuotes(nextSymbols)`
5. 保留 `quotesMap` 作为本轮 `processMonitor` 的输入
6. 删除 `quotesMap` 继续作为下列模块的长期输入：
   1. `orderMonitorWorker.schedule(quotesMap)`
   2. 任何需要执行时最新价的异步处理器

### 改造后的边界

`mainProgram` 中的 `quotesMap` 只用于：

1. `processMonitor`
2. 某些同步展示逻辑
3. 本轮立即完成的 seat/monitor 推导逻辑

不再用于：

1. 买卖执行器的最终委托价
2. 订单监控追价
3. 长时间排队后才消费的异步任务

同时必须保证：

1. 任何会在本轮触发订单提交或改单的流程，都只能发生在订阅集合已经同步之后。

### 8.4 `src/types/state.ts` 与 `MonitorContext`

### 当前问题

当前 `MonitorContext` 含有：

1. `longQuote`
2. `shortQuote`
3. `monitorQuote`

这三者是动态市场数据副本，不应长期存放在上下文中。

### 目标改造

从 `MonitorContext` 中删除：

1. `longQuote`
2. `shortQuote`
3. `monitorQuote`

保留：

1. 业务状态
2. 结构性依赖
3. 名称缓存
4. 指标画像
5. 风控、订单记录器、策略、席位状态等

### 原因

`MonitorContext` 应承载业务依赖与业务状态，不应长期承载动态市场镜像。

### 8.5 `src/app/createMonitorContext.ts`

### 目标改造

1. 不再从 `runtimeSnapshot` 中写入 `longQuote/shortQuote/monitorQuote`
2. 仅初始化：
   1. 席位状态
   2. 席位版本
   3. 名称缓存
   4. 指标画像
   5. 业务依赖

### 8.6 `src/main/processMonitor/seatSync.ts`

### 目标改造

1. `resolveMonitorContextRuntimeSnapshot(...)` 仍可保留临时 `longQuote/shortQuote/monitorQuote` 作为本轮运行时派生结果
2. 但这些 quote 不再写入 `monitorContext`
3. `SeatSyncResult` 中仍可返回本轮派生的 `longQuote/shortQuote`，供本轮后续流程使用
4. `SEAT_REFRESH` 调度若需要 quote，可继续把“本轮临时 quote”放入任务 data 中，但不得再写入长期上下文

### 原因

同一轮 monitor 处理仍需要一份一致视图；这不等于需要长期保存动态行情副本。

### 8.7 `src/main/processMonitor/index.ts`

### 目标改造

1. 保留从 `quotesMap` 中读取 `monitorQuote`
2. 保留 monitor 级别“本轮一致视图”逻辑
3. 继续把本轮 `monitorQuote` 传入：
   1. `syncSeatState(...)`
   2. `runIndicatorPipeline(...)`
   3. `runSignalPipeline(...)`

### 说明

这里不需要改成“所有步骤都重新 realtime 读取”，因为本轮 monitor 处理更需要一致性而不是最低延迟。

### 8.8 `src/main/asyncProgram/buyProcessor/index.ts`

### 当前问题

当前买入执行器从 `ctx.longQuote / ctx.shortQuote / ctx.monitorQuote` 读取价格，属于陈旧快照。

### 目标改造

1. 删除对 `ctx.longQuote / ctx.shortQuote / ctx.monitorQuote` 的依赖
2. 执行任务时：
   1. 根据当前席位解析 `longSymbol / shortSymbol`
   2. 直接读取 `[monitorSymbol, longSymbol, shortSymbol]` 的 realtime quote
   3. 只有在买入所需 quote 字段满足条件时才继续执行；否则直接丢弃
3. 用这份执行时 quote 构建 `RiskCheckContext`
4. 最终写入 `signal.price` 与 `signal.lotSize` 时，使用执行当下读到的 realtime quote

### 设计要求

1. 买入执行器必须显式依赖 `marketDataClient`
2. 风险检查、执行价、`lotSize` 都使用同一次读取结果，避免同一次执行内部出现多次读取导致的不一致
3. `RiskCheckContext` 类型与下游 `applyRiskChecks(...)` 的消费边界必须同步改造为消费这次执行时读取的 quote，不允许保留旧 `MonitorContext` quote 注入链路。
4. 买入执行前的 quote 就绪判定必须按真实消费字段定义，而不是只按最终下单字段定义：
   1. 下单数量与委托价至少要求目标交易标的具备有效 `price + lotSize`
   2. 若风险检查仍消费 `monitorQuote`（例如牛熊证风险链路），则 `monitorQuote.price` 也属于买入执行前的必要输入；缺失时直接丢弃，不进入重试
5. 买入不参与统一 quote 重试
6. 若任一必要输入 `quote === null`、`price` 无效或 `lotSize` 无效，则按当前“跳过执行并记录原因”的语义直接丢弃
7. `runSignalPipeline` 对买入的“行情未就绪即不入队”语义保持不变；buyProcessor 只负责处理执行时再次缺行情的边界

### 8.9 卖出执行路径

虽然本轮只确认了买入处理器的实现方式，但卖出执行价同样属于价格敏感路径，因此必须一起纳入最终方案。

### 目标改造

1. 卖出执行前同样读取执行时 realtime quote
2. 若 quote 未就绪，则注册一次性订单重试 intent 并立即返回，不阻塞 sellProcessor
3. 智能平仓、可卖判断、最终委托价构造，统一使用重试成功后恢复执行时读到的 quote
4. 不再依赖任何 `MonitorContext` 中的动态 quote 副本

### 原因

若只改买入不改卖出，会留下双重口径：

1. 买入用执行时 realtime
2. 卖出仍用主循环快照

这不是允许的最终状态。

### 8.10 `src/main/asyncProgram/orderMonitorWorker/index.ts`

### 当前问题

当前 worker 的输入是 `schedule(quotesMap)`，这意味着订单监控追价依赖主循环快照。

### 目标改造

1. `schedule()` 不再接收 `quotesMap`
2. worker 只负责调度“该跑一次订单监控”
3. 真正执行时，由订单监控内部根据当前 tracked orders 的 symbols 自行读取当前 realtime quotes
4. 若部分 tracked symbols 缺少 quote，则不阻塞 worker，而是在 tracked order 运行态中记录统一的 quote retry 状态

### 新模型

1. `mainProgram` 触发 `orderMonitorWorker.schedule()`
2. worker 调 `monitorAndManageOrders()`
3. `Trader` / `orderMonitor` 内部读取当前需要的 quotes，并在下一轮 worker 调度时继续推进未完成的 quote 重试

### 旧状态退场要求

1. `schedule(quotesMap)` 必须收口为无参调度或等价的“仅触发执行”契约，不能保留旧 quotesMap 入参的兼容壳。
2. worker 内部的 `latestQuotes` 与对外暴露的 `clearLatestQuotes()` 必须一起退场或被新的运行态语义替代，不允许留下无真实职责的过渡接口。
3. `monitorAndManageOrders(quotesMap)`、`Trader` 对应签名以及生命周期域对旧 worker 行情状态的清理调用，必须在同一阶段同步收口，避免出现“主调用已删参数、底层仍依赖旧状态”的半断裂接口。

### 原因

订单监控要的是“现在最新价”，而不是“主循环那一轮价”。

### 8.11 `src/core/trader/orderMonitor/quoteFlow.ts`

### 目标改造

1. `processWithLatestQuotes(quotesMap)` 改为内部自行拉取所需 quotes
2. 流程变为：
   1. 收集 `runtime.trackedOrders` 涉及的 `symbol`
   2. 先批量调用 `marketDataClient.getQuotes(symbols)`
   3. 对 quote 缺失或字段无效的 tracked orders 更新 `attempts / nextRetryAt / exhausted`
   4. 用本轮 ready quotes 做追价、改单和超时判断
   5. 对尚未到下一次重试时间的 orders，本轮直接跳过
   6. 对 30 次耗尽后仍 unresolved 的 orders，停止 quote 重试并记录原因

### 设计要求

1. 同一轮订单监控内只批量取一次，避免每个订单单独读取
2. 超时逻辑与追价逻辑仍保持同一次处理轮的一致视图
3. 不能因为改成内部读取，就在每个订单上重复请求
4. 不允许在 order monitor 内写同步 `sleep` 循环；它必须复用现有 worker 周期调度推进重试

### 8.12 `src/core/doomsdayProtection/index.ts`

### 当前问题

当前清仓流程虽然已经是“使用时批量读取”，但仍有两个必须收口的问题：

1. 其执行时机当前早于订阅集合同步。
2. 若某个待清仓 symbol 缺少 realtime quote，不能继续沿用“直接失败”或“改写订单类型”的旧思路。

### 目标改造

1. `executeClearance(...)` 仍然在模块内部批量读取行情
2. 但其调用时机必须移动到订阅同步之后
3. 对缺失 quote 的待清仓 symbols 注册一次性订单重试 intent，并立即结束当前主循环内的清仓尝试
4. 仅在 30 次重试后仍无法获取有效 quote 时，才放弃该 symbol 本轮清仓

### 说明

这满足以下约束：

1. 不重新引入 `quote()` 当前价兜底
2. 不强制改写原有订单类型语义
3. 把“等待行情 warm-up”的责任明确限制在订单路径

### 8.12A `src/core/riskController/unrealizedLossMonitor.ts`

### 目标改造

1. 保护性清仓不再因为首次读取到 `null quote` 就立即结束
2. 在真正生成并提交清仓信号前，若 quote 未就绪则注册一次性订单重试 intent 并立即返回
3. 仅在重试成功后恢复执行时，才继续使用 `price` / `lotSize` 构造 liquidation signal
4. 若 30 次重试后仍未拿到有效 quote，则放弃本次保护性清仓

### 说明

保护性清仓仍然保留现有订单类型配置语义，只改变“行情未就绪时的等待方式”，不改变业务判断条件。

### 8.12B `src/main/asyncProgram/monitorTaskProcessor/handlers/liquidationDistance.ts`

### 目标改造

1. 距回收价清仓不再直接使用任务入队时携带的 `quote`
2. 任务执行时先确认席位与 symbol 有效，再即时读取 realtime quote
3. 若 quote 未就绪，则注册一次性订单重试 intent 并立即返回，不阻塞 monitorTaskProcessor
4. 仅在重试成功后恢复执行时，才构造清仓 signal 的 `price` / `lotSize`
5. 若 30 次重试后仍无法获取有效 quote，则放弃本次距回收价清仓

### 说明

这样可以在不改变任务调度语义的前提下，消除“任务入队时 quote 缺失导致一次性错过”的问题。

### 8.12C `src/services/autoSymbolManager/switchStateMachine.ts`

### 当前问题

当前自动换标状态机虽然天然是非阻塞的 tick 推进模型，但仍有两个必须修正的问题：

1. 移仓卖出与回补买入仍然绕过统一 quote 重试规则。
2. `SELL_OUT` 与 `REBUY` 复用了同一套 `isQuoteReadyForOrder` 判定，导致卖出也被错误要求必须具备 `lotSize`。

### 目标改造

1. 自动换标继续复用现有 `AUTO_SYMBOL_SWITCH_DISTANCE` 心跳推进，不新增阻塞等待
2. 在 `SwitchState` 中新增统一 quote retry 运行态：
   1. `attempts`
   2. `nextRetryAt`
   3. `exhausted`
3. `SELL_OUT` 的 quote 就绪条件改为：
   1. 仅要求有效 `price`
4. `REBUY` / `WAIT_QUOTE` 的 quote 就绪条件改为：
   1. 要求有效 `price`
   2. 要求有效 `lotSize`
5. 每次状态机推进时，只有在到达 `nextRetryAt` 后才再次检查 quote
6. 30 次耗尽后：
   1. 距离换标卖出失败则清空流程并按现有失败语义收口
   2. 距离换标回补失败则按现有失败语义收口
   3. 不允许无限等待 quote
7. `SwitchState` 中的 quote retry 运行态必须与动作阶段严格对齐：
   1. 必须显式定义这些字段是 SELL_OUT 与 REBUY 共用，还是按动作拆分；不能保持模糊状态
   2. 阶段切换时必须定义 reset 时机，避免卖出阶段的 retry 状态污染回补阶段
   3. 旧 `awaitingQuote` 与新 retry 字段必须二选一，不能同时保留形成双真相

### 说明

自动换标不需要新增 retry worker；它已经由现有 monitor task 心跳持续推进，因此最短路径是在状态机内部共享同一套重试参数与耗尽规则，而不是再叠加第二套调度器。

### 8.13 `src/main/asyncProgram/postTradeRefresher/index.ts`

### 结论

`postTradeRefresher` 中 `quotesMap` 的使用不属于最核心的下单 / 改单实时取价路径，但它也不是纯展示链路；它同时承担成交后浮亏数据刷新与账户持仓展示。

本次推荐方案：

1. 第一阶段保留其接收单轮 `quotesMap` 的方式
2. 继续使用本轮 `quotesMap` 完成成交后浮亏数据刷新与展示
3. 在文档语义上明确它属于“成交后风险刷新 + 展示链路”，而不是“最终委托价读取链路”
4. 只要其底层 `getQuotes()` 已经变为 realtime-only 读取，就不会继续依赖应用层动态 `quoteCache`

原因：

1. 这不是本次重构的主要收益点
2. 不应在本次方案中把所有引用 `quotesMap` 的链路都强行改成即时读取
3. 但必须明确它仍承担风险缓存刷新职责，避免被误归类为纯展示残留

### 8.14 本次复核后已明确删除的冗余设计

以下设计在首次成稿时仍带有“保留余地”色彩，本次已明确删除：

1. 保留 `setOnQuote` 作为错误监控钩子。
2. 保留 `setOnQuote` 作为未来事件驱动扩展钩子。
3. 保留 `setOnCandlestick` 作为错误监控或未来扩展钩子。
4. 新增 `getQuote(symbol)` 单标的语法糖接口。
5. 在本次方案中预留 `Depth` / `Trades` / `Brokers` 扩展位。

原因一致：它们都不是当前需求下的最小必要能力。

---

## 9. 必须明确保留的设计

以下设计必须保留，不能因为“删缓存”而误删。

### 9.1 单轮 `quotesMap`

必须保留，原因：

1. monitor 处理需要一致视图
2. 同一轮策略、风控、席位同步应共享同一份输入

### 9.2 `staticInfoCache`

必须保留，原因：

1. `lotSize`
2. 名称
3. `callPrice`
4. `warrantType`
5. 其他静态字段

这些不属于动态行情快照，但构造内部 `Quote` 和风控逻辑都需要。

### 9.3 `prevCloseCache`

必须保留，原因：

1. `RealtimeQuote` 与 `PushQuote` 都不提供 `prevClose`
2. 当前系统日志和展示依赖 `Quote.prevClose`
3. `prevCloseCache` 是“保留一次性 `quote()` 初始化”的唯一合理用途

### 9.4 指标快照和延迟验证缓存

必须保留，原因：

1. 它们不是市场动态缓存，而是策略语义的一部分
2. 删除会破坏延迟验证和指标复用语义

---

## 10. 必须明确删除的设计

以下设计必须直接删除，不允许保留兼容层。

### 10.1 `quoteCache`

删除原因：

1. 与 SDK realtime 状态语义重叠
2. 不是业务真相
3. 增加状态源数量

### 10.2 `MonitorContext.longQuote / shortQuote / monitorQuote`

删除原因：

1. 属于动态市场数据副本
2. 容易被异步执行器误用为“当前最新价”

### 10.3 “执行器依赖上一轮主循环行情”的默认模式

删除原因：

1. 对执行路径来说，这是错误的时序口径
2. 会放大价格陈旧问题

### 10.4 无职责的 `Quote` / `Candlestick` push 回调注册

删除原因：

1. 在本次目标架构下它们不再承担状态更新职责。
2. 当前业务也不消费这两类 push 事件驱动流程。
3. 继续保留只会形成“将来可能有用”的预留式设计。

---

## 11. 分阶段实施方案

本次重构必须分阶段落地，但最终状态只能有一套语义，不允许长期双轨。

### Phase 1：收敛 `Quote` 单一事实来源并先修主循环订阅时序

目标：

1. `MarketDataClient.getQuotes()` 改为 realtime-only 读取器
2. 删除 `quoteCache`
3. 删除 `setOnQuote` 与 `setOnCandlestick`
4. 保留订阅时一次性 `prevClose` 初始化
5. 保留现有 `getQuotes()` 调用面
6. 先把主循环中“订阅同步先于 doomsday 等依赖行情动作”的时序调整到位，消除阶段内断裂

改造项：

1. `src/services/quoteClient/index.ts`
2. `src/types/services.ts`
3. `src/main/mainProgram/index.ts`
4. 对应测试与 mock

阶段完成标准：

1. 全仓库不再存在应用层动态 `quoteCache`
2. `getQuotes()` 不再假设 realtime 已 warm，缺失时直接返回 `null`
3. `quote()` 不再承担当前价补齐职责，只保留 `prevClose` 初始化职责
4. 主循环内所有依赖实时行情的流程都发生在订阅同步之后，避免在 Phase 1 期间出现 `getQuotes()` 已收紧但调用时序仍旧错误的中间态
5. 启动、重建、首轮主循环和新订阅 symbol 在出现 `null quote` 时仍可安全推进

### Phase 2：建立统一订单行情重试器与公共契约

目标：

1. 新增统一的非阻塞订单行情重试规则
2. 明确重试只覆盖“quote 缺失/字段无效”这一类失败
3. 明确买入不参与该重试
4. 收敛 retry coordinator、business key、恢复复核与公共类型边界

改造项：

1. `src/types/services.ts`
2. 订单执行相关公共类型与依赖注入点
3. 一次性订单路径的 retry coordinator / delayed re-enqueue 设计
4. 对应业务键、reset 事件与验证断言

阶段完成标准：

1. 全仓库只存在一套统一的订单行情重试规则定义与公共契约
2. `getQuotes()` 本身仍保持非阻塞读取，不内置 sleep/retry
3. 一次性订单路径与周期驱动路径都已有统一的重试参数、恢复复核与幂等去重语义
4. 不存在任何处理器通过 `sleep` 或长时间 `await` 卡住队列
5. 本阶段的“统一”仅指规则与基础设施统一，不要求订单监控与自动换标已在本阶段全部完成接入

### Phase 3：价格敏感执行路径改为执行时重读 realtime 行情

目标：

1. 买入执行器不再依赖 `MonitorContext` quote 副本
2. 卖出执行器不再依赖 `MonitorContext` quote 副本
3. 买卖执行都在执行时重读 realtime 行情
4. 风险清仓类订单在执行前同样统一走订单行情重试

改造项：

1. `src/main/asyncProgram/buyProcessor/index.ts`
2. `src/main/asyncProgram/sellProcessor/index.ts`
3. `RiskCheckContext` 组装点
4. 将 `marketDataClient` 显式注入相关执行器依赖与类型
5. `src/core/doomsdayProtection/index.ts`
6. `src/core/riskController/unrealizedLossMonitor.ts`
7. `src/main/asyncProgram/monitorTaskProcessor/handlers/liquidationDistance.ts`

阶段完成标准：

1. 买卖执行都不再依赖主循环快照或 `MonitorContext` 副本
2. 执行价与 `lotSize` 都来源于执行时读取
3. 买入在执行时缺行情则直接丢弃，不进入重试
4. 卖出与风险清仓在缺行情时进入非阻塞重试，重试耗尽后才放弃本次操作
5. 不存在任何一次性订单路径绕开统一规则而直接同步等待 quote

### Phase 4：订单监控改为内部读取 realtime 行情

目标：

1. worker 不再接收 `quotesMap`
2. orderMonitor 内部按 tracked symbols 批量读取 realtime 行情

改造项：

1. `src/main/asyncProgram/orderMonitorWorker/index.ts`
2. `src/main/asyncProgram/orderMonitorWorker/types.ts`
3. `src/app/runtime/createAsyncRuntime.ts`
4. `src/types/services.ts`
5. `src/core/trader/index.ts`
6. `src/core/trader/types.ts`
7. `src/core/trader/orderMonitor/*`

阶段完成标准：

1. 订单追价不再依赖主循环快照
2. 同一轮订单监控只发生一次批量 quote 读取
3. quote 缺失时只记录 retry 状态，等待下一轮 worker 再推进
4. 相关依赖与类型签名全部收口完成，不留半断裂接口

### Phase 4A：自动换标接入统一重试规则

目标：

1. 自动换标的移仓卖出与回补买入接入统一 quote retry 规则
2. 自动换标保持现有 tick 推进，不新增阻塞等待
3. 卖出与买入的 quote 就绪条件按动作分离

改造项：

1. `src/services/autoSymbolManager/switchStateMachine.ts`
2. `src/services/autoSymbolManager/types.ts`
3. 自动换标相关测试

阶段完成标准：

1. 自动换标不存在无限 WAIT_QUOTE
2. `SELL_OUT` 不再错误依赖 `lotSize`
3. 自动换标在 30 次耗尽后按既定失败语义收口

### Phase 5：删除 `MonitorContext` 动态 quote 副本并清理重建链路

目标：

1. 删除 `longQuote/shortQuote/monitorQuote`
2. monitor 处理只使用单轮 `quotesMap` 与本轮函数返回值
3. 重建链路不再依赖 `MonitorContext` 中的动态行情字段

改造项：

1. `src/types/state.ts`
2. `src/app/createMonitorContext.ts`
3. `src/main/processMonitor/seatSync.ts`
4. `src/main/lifecycle/rebuildTradingDayState.ts`
5. `src/main/asyncProgram/monitorTaskProcessor/types.ts`
6. `src/main/processMonitor/riskTasks.ts`
7. 其他直接引用这些字段的模块

阶段完成标准：

1. `MonitorContext` 不再承载动态行情副本
2. `MonitorTaskContext` 与相关 task payload 不再默认长期持有执行依据性质的入队时 quote 快照
3. monitor 同轮处理仍可正常推进
4. 开盘重建链路在删除上述字段后仍可完整重建订单记录、牛熊证风险和浮亏缓存

---

## 12. 验证方案

为避免阶段实施时把最终验收条目误当成前置门禁，本文档中的验证分两层：

1. **阶段门禁（phase gate）**：只要求验证当前阶段引入或收口的能力。
2. **最终门禁（final gate）**：要求在全部 Phase 完成后统一验证全链路行为。

除非条目明确写明“阶段门禁”，否则 `12.2` 与 `12.4` 默认按最终门禁理解。

### 12.1 行为一致性验证

需要验证以下行为在重构后保持不变：

1. 主循环仍可正常订阅/退订 symbols
2. 启动、开盘重建和新订阅 symbol 在 realtime 未 warm 时可返回 `null`，且不会出现未捕获异常、错误进入非法接入状态或破坏后续主循环推进
3. monitor 在行情可用时仍可正常生成信号；行情缺失时按现有跳过/不触发语义退化
4. K 线指标链路不受影响
5. 风控、延迟验证、席位同步、末日保护的业务判定口径不因 quote 读取模型变化而改变
6. 普通买入在 quote 缺失时仍保持现有“直接跳过/不入队”语义
7. 其余需要行情的订单路径在 quote 缺失时统一执行 1 秒一次、最多 30 次的非阻塞重试

### 12.2 实时性验证

需要重点验证以下场景：

1. 主循环刚处理完后，市场价格变化，再执行买入任务：
   1. 下单价应取执行时最新价，而不是上一轮快照价
2. 订单在排队期间市场价格变化：
   1. 追价与改单应基于订单监控运行当下最新价
3. 某个 symbol 刚完成订阅，realtime 尚未 warm：
   1. `getQuotes()` 直接返回 `null`
   2. 买入路径直接丢弃
   3. 其余需要行情的订单路径进入统一重试，每秒一次、最多 30 次
   4. 30 次后仍无 quote 时，才放弃该次卖出、追价或清仓动作
   5. monitor、重建、展示链路不会因 `null` 崩溃，也不会进入阻塞重试
4. 处理器与 worker 在 quote 缺失期间：
   1. 不会因为等待 quote 而阻塞后续任务
   2. 仅通过重入调度、下一轮 worker 或 delayed re-enqueue 推进
5. 一次性订单路径在 retry 恢复执行时：
   1. 必须重新校验生命周期门禁、刷新门禁、席位版本与时间窗口
   2. 末日保护在窗口失效后不得继续提交旧 retry intent
   3. 席位版本变化后不得继续提交旧席位对应的卖出或清仓动作
6. 同一业务动作重复触发 quote 缺失时：
   1. 不会重复创建多个并行 retry intent
   2. 成功提交、耗尽、席位失效或窗口失效后，旧 retry 状态会被及时清理
   3. 同一 business key 在同一时间最多只能存在一个 active retry intent

### 12.3 状态源唯一性验证

需要验证：

1. 仓库中不存在应用层动态 `quoteCache`
2. `MonitorContext` 不再持有动态 quote 副本
3. 不存在“旧快照接口 + 新 realtime 接口”长期双轨并存
4. 不存在保留但不再承担职责的 `Quote` / `Candlestick` 回调注册

### 12.4 回归测试重点

必须覆盖（默认按最终门禁理解；若只做阶段验收，应只抽取本阶段直接相关条目）：

1. `Quote` 读取与订阅校验
2. 新订阅 symbol 在 realtime 未 warm 时返回 `null`
3. `prevClose` 与静态字段初始化
4. monitor 链路单轮一致视图
5. 普通买入执行在缺失 quote 时直接丢弃，不进入重试
6. 卖出执行在缺失 quote 时进入非阻塞重试，成功后继续下单
7. 订单追价在缺失 quote 时由下一轮 worker 继续推进，30 次耗尽后跳过
8. 末日保护与保护性清仓在缺失 quote 时进入非阻塞重试，30 次耗尽后放弃本轮动作
9. 距回收价清仓在缺失 quote 时进入非阻塞重试，30 次耗尽后放弃本轮动作
10. 自动换标移仓卖出与回补买入在缺失 quote 时按统一规则推进，30 次耗尽后收口
11. 跨日重置后订阅与读取恢复
12. `subscribeSymbols()` 批次失败时不会留下半接入 symbol，`getQuotes()` 的合法输入域与接入状态保持一致
13. 主循环时序满足“先完成订阅同步，再执行 doomsday / 清仓 / 其他依赖实时行情的订单动作”
14. quote retry 的 `1s * 30` 采用 wall-clock 语义，与 worker tick 频率解耦
15. 一次性订单路径的 retry intent 不持有对象池 `Signal` 引用，处理器返回前对象池资源已释放
16. `OrderMonitorWorker` 旧 `latestQuotes` / `clearLatestQuotes()` 状态已退场，或其替代语义已在功能、时序与清理责任上等价收口
17. `SwitchState` 不存在 `awaitingQuote` 与新 retry 字段并存的双真相

---

## 13. 风险与边界

### 13.1 不允许把 monitor 处理也改成“每个步骤都单独 realtime 读取”

原因：

1. 这会破坏单轮一致视图
2. 同一轮内不同步骤可能看到不同价，导致策略语义漂移

### 13.2 不允许只改 `quoteClient` 而不改执行路径

原因：

1. 这样只能删除一层重复缓存
2. 不能解决真正的价格陈旧问题

### 13.2A 不允许把统一重试下沉进 `getQuotes()`

原因：

1. `getQuotes()` 是基础读取接口，必须保持“即时读取、无值即 `null`”的语义。
2. 若把 sleep/retry 藏进 `getQuotes()`，会把 monitor、展示、重建链路也错误地变成阻塞流程。
3. 本次业务要求的是“仅订单路径在 quote 缺失时重试”，不是“所有行情读取自动等待”。

### 13.2B 不允许在处理器内部同步等待 quote

原因：

1. buy/sell processor、monitorTaskProcessor、orderMonitorWorker 都是串行或单飞模型。
2. 若在其中任一路径内联 `await sleep(1000)` 持续 30 次，会直接拖住同处理器下的其他任务。
3. 本次业务明确要求 quote 重试不能阻塞其他任务，因此只能使用 delayed re-enqueue 或既有周期驱动推进。

### 13.2C 不允许把旧业务校验结果直接复用于 retry 恢复执行

原因：

1. quote retry 只能解决“行情未就绪”，不能保证首次失败时的时间窗口、席位归属、刷新状态在恢复时仍然成立。
2. 末日保护、保护性清仓、距回收价清仓都具有明显时序与席位约束，恢复执行前若不重检，会产生越窗执行或旧席位误执行风险。
3. 因此恢复执行前必须重新经过门禁、`refreshGate`、席位版本和时间窗口校验。

### 13.2D 不允许缺少 retry intent 的幂等与去重语义

原因：

1. 主循环、风险任务和周期状态机都可能重复触发同一业务动作。
2. 若没有 active retry registry 或等价的运行态去重，会导致同一 symbol / 同一路径并行挂起多个等待中的 retry intent。
3. 这会带来重复下单、重复日志和无限重建等待状态的风险。

### 13.3 不允许保留旧字段仅标记为 deprecated

原因：

1. 这会让执行链路继续有机会误用旧快照
2. 本次方案要求最终语义单一，不保留兼容双轨

### 13.4 不允许保留“当前无职责，仅用于日志或未来扩展”的 `Quote` 回调

原因：

1. 它不是当前业务所需能力。
2. 它会误导后续实现者，以为回调仍是正式架构的一部分。
3. 它会为后续实现继续保留错误入口，削弱本次“单一真相”目标。

### 13.5 不允许重新引入“缺失 realtime 时再用 `quote()` 补当前价”

原因：

1. 这会把本次明确删除的冗余设计重新引回系统。
2. 它会把“当前价真相”重新分裂成 realtime 与 snapshot 双来源。
3. 当前业务已经明确：当前价只来自 realtime；订单路径若缺行情，只允许统一重试，不允许退回 `quote()` 补当前价。

### 13.6 不允许为了处理缺行情而强制改写订单类型

原因：

1. 订单类型属于交易业务规则，不应因为市场数据 warm-up 方式改变而被架构层篡改。
2. 当前更合理的收口方式是统一行情重试，而不是把 `ELO/LO` 强行改成 `MO`。
3. 若未来确需调整订单类型，应单独作为业务规则变更，不属于本次市场数据重构范围。

### 13.7 不允许让买入信号因 quote 重试而延后执行

原因：

1. 买入信号本身具有时点敏感性，延后恢复执行会偏离原始触发条件。
2. 当前系统已经在 signal pipeline 对买入使用“行情未就绪即不入队”的语义。
3. 因此买入路径的正确收口是直接丢弃，而不是等待 quote warm-up 后再补做。

---

## 14. 最终结论

本次重构结论如下：

1. 当前系统对 `Quote` 的实现，确实是“订阅推送 -> 应用层本地缓存 -> 主循环读取快照 -> 部分异步路径继续读旧快照”。
2. 当前系统对 `Candlestick` 的实现并非如此，K 线已经是“订阅 + 直接读取 SDK realtime”。
3. 官方 Node.js SDK 文档已经证明：`realtimeQuote` 不能被假设为“订阅后立即可读”。
4. 当前安装的 SDK 类型定义还进一步证明：`RealtimeQuote` 与 `PushQuote` 不包含 `prevClose`，因此若系统仍需要涨跌幅展示，就必须保留一次性 `quote()` 初始化 `prevClose`。
5. 在业务已经明确要求“当前价只来自 realtime，`quote()` 不再补当前价”的前提下，再用 `quote()` 补当前价不再合理，只会形成冗余设计。
6. 真正过度设计的是应用层重复维护动态 `Quote` 状态，以及保留无职责 push 回调，而不是所有缓存。
7. 若从实时性看，决定胜负的关键不是“是否删除 `quoteCache`”，而是“执行路径是否在使用时刻重新读取 realtime 行情”。
8. 因此，本次唯一正确方案是：
   1. 删除应用层动态 `quoteCache`
   2. 保留 `quote()` 仅作订阅时的一次性 `prevClose` 初始化
   3. 把 `getQuotes()` 重定义为 realtime-only 读取器：有 realtime 就返回 `Quote`，无 realtime 就返回 `null`
   4. 保留主循环单轮临时 `quotesMap`
   5. 删除 `MonitorContext` 动态 quote 副本
   6. 统一 quote retry 只负责解决“行情未就绪”，恢复执行前必须重新校验门禁、`refreshGate`、席位版本与时间窗口
   7. 一次性订单路径必须具备 retry intent 的幂等与去重语义，不能让同一业务动作重复注册多个等待中的重试
   8. 普通买入保持“无行情直接丢弃”的语义，不进入 quote 重试
   9. 其余需要行情的订单路径共享统一的 quote retry 规则：`1s * 30`，耗尽后放弃
   10. 一次性订单路径通过 delayed re-enqueue 非阻塞重试；订单监控与自动换标通过现有周期驱动推进同一套 retry 状态
   11. 主循环先同步订阅集合，再执行任何依赖市场数据的订单动作
   12. 自动换标的卖出与回补买入分别按动作使用不同的 quote 就绪条件，且禁止无限等待 quote
   13. 删除不再承担职责的 `setOnQuote` 与 `setOnCandlestick` 回调注册
   14. K 线链路保持现有模式

这是满足“最短路径、单一真相、非补丁式重构”的唯一推荐实施方案。
