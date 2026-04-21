# 性能问题全面审查清单

**审查日期：** 2026-04-20  
**审查范围：** 当前仓库运行态主循环、市场事件链路、指标计算链路、信号链路、I/O 与终端投影链路  
**审查方式：** 主线程代码核查 + teams 并行只读审查 + 结果合并去重  

---

## 0. 总结论

本次审查后的统一结论是：

1. 当前系统的最大性能瓶颈不在单个指标公式，而在**主循环全量扫描、事件路径广播式分发、快照深拷贝、单信号粒度重复 I/O、订单多阶段重复筛选**五类问题。
2. 当前运行态已经具备较多事件驱动组件，但外层仍保留了**1 秒固定节拍的全量 sweep**，导致“事件驱动 + 轮询驱动”双轨叠加，抵消了部分事件驱动收益。
3. 高频计算链路中，增量 runtime 已经是正确方向，但仍存在**整块 committed 状态克隆**、**整对象深拷贝**和**重复数组/Map 物化**。
4. 如果要取得明显性能提升，优先级应放在：
   - 去掉主循环中的非时间语义全量刷新
   - 去掉事件路径上的全量扫描与全量重建
   - 去掉高频路径上的深拷贝与重复筛选

---

## 1. 最高优先级问题（P0）

### 1.1 主循环每秒全量拉行情并全量处理全部 monitor

**位置：**
- `src/app/runApp.ts:251-277`
- `src/main/timeDriverProgram/index.ts:241-284`
- `src/main/processMonitor/index.ts:27-85`

**问题：**
当前系统在稳态下通过固定 interval 永久执行主循环。每轮都会：

1. 全量构造 `quoteSymbols`
2. 调用 `marketDataClient.getQuotes(...)`
3. 遍历全部 `monitorContexts` 执行 `processMonitor(...)`
4. 再次遍历全部 `monitorContexts` 执行 `indicatorCache.push(...)`

这意味着即使没有新的 K 线或 quote 业务事件，也会对所有 monitor 执行一轮完整处理。

**影响：**
- CPU 随 monitor 数量线性放大
- 每拍都有数组/Map/对象分配
- 与现有 `onQuoteUpdated` / `onCandlestickUpdated` 事件路径形成重复开销
- 明显违背“运行态 UI 主刷新应是事件驱动，定时器只更新纯时间字段”的项目要求

**建议方向：**
把价格展示、风险展示、监控指标展示、部分派生任务调度从 1 秒 sweep 中剥离，收敛到 quote / candlestick / seat / gate 等显式事件源；主循环只保留时间语义、生命周期门禁、末日保护、冷却和 heartbeat。

---

### 1.2 `indicatorCache` 每秒重复采样并深拷贝 monitor snapshot

**位置：**
- `src/main/timeDriverProgram/index.ts:276-284`
- `src/main/asyncProgram/indicatorCache/index.ts:54-64`
- `src/main/asyncProgram/indicatorCache/utils.ts:103-125`

**问题：**
主循环每秒对每个 monitor 的 `lastMonitorSnapshot` 做一次深拷贝后写入 `indicatorCache`。即使没有新的 K 线推进、没有新的指标变化，也会继续复制同一份业务快照，只是采样时间不同。

**影响：**
- 持续制造短生命周期对象
- 增加 GC 压力
- 实际上是由定时器驱动非时间业务状态的时间轴推进
- 延迟验证链路为此再做多次回溯查询，形成二次成本

**建议方向：**
把 `indicatorCache` 改为 candlestick / indicator commit 事件驱动写入；若必须保留时间语义查询，也应重新建模为更轻量的事件时间索引，而不是每秒复制整份快照。

---

### 1.3 `MonitorQuoteEventRuntime` 对 WAIT routes 做全量扫描

**位置：**
- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:630-650`

**问题：**
每条 quote 事件除了处理当前直达 route 外，还会遍历全部 `routeStates`，逐个检查 `wakeupSymbols.has(event.symbol)`。

**影响：**
- 事件分发复杂度接近 O(全部活跃 routes)
- WAIT routes 多时，quote 事件吞吐明显下降
- 事件尾延迟抖动明显

**建议方向：**
维护 `wakeupSymbol -> monitorRoutes` 的反向索引，让 quote 事件只命中相关 WAIT routes，而不是线性扫描整个 route 表。

---

### 1.4 `TradingRiskEventRuntime` 在高频 quote 上重复全量重建 routing index

**位置：**
- `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:105-112`
- `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:173-189`
- `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:221-242`
- `src/main/tradingRiskEventRuntime/routingIndex.ts:81-120`

**问题：**
每个 quote 事件至少会触发一次 `rebuildRoutingIndex()`；在 freshness 等待前后还会再次重建校验。

**影响：**
- 高频 quote 下形成 O(全量 monitor/seat) 的重复派生计算
- 频繁新建 `Map` 与索引对象
- CPU 和 GC 压力叠加

**建议方向：**
把 routing index 改成由 seat/symbol ownership 变化事件驱动失效与增量重建；quote 事件只做 route 命中与 version 校验。

---

### 1.5 指标增量 runtime 的 committed 深拷贝仍然很重

**位置：**
- `src/services/indicators/runtime/index.ts:127-139`
- `src/services/indicators/runtime/index.ts:396-447`
- `src/services/indicators/runtime/index.ts:541-548`
- `src/main/businessEventProgram/indicatorPipeline.ts:41-75`

**问题：**
虽然当前指标系统已经改为增量 runtime，但在以下热路径上仍存在较重的整体克隆：

1. shifted-candle 分支 `cloneCommittedState(...)`
2. active bar preview 分支 `cloneCommittedState(...)`
3. 然后再基于克隆结果构建 snapshot

**影响：**
- K 线高频更新时会持续创建较大对象图
- 指标族和周期越多，克隆成本越高
- 这笔成本发生在进入 `strategy.generateSignals(...)` 之前，是整条信号链的固定前置成本

**建议方向：**
把 preview/shift 的表示方式改成更细粒度的增量覆盖或双缓冲，而不是每次整块 committed 深拷贝。

---

### 1.6 买入信号按单信号粒度重复做实时账户/持仓拉取

**位置：**
- `src/main/asyncProgram/buyProcessor/index.ts:138-176`
- `src/core/signalProcessor/riskCheckPipeline.ts:137-314`

**问题：**
`BuyProcessor` 目前按单个信号调用 `applyRiskChecks([signal], ctx)`。而 `riskCheckPipeline` 会在每个买入信号内部，在轻检查通过后执行一整套实时账户/持仓拉取。

**影响：**
- 同一轮多个买入信号会重复调用 `trader.getAccountSnapshot()` / `trader.getStockPositions()`
- 放大 I/O 压力、对象创建与尾延迟
- 高频买入场景下收益损失明显

**建议方向：**
在同一批次或同一处理轮次中共享一次实时账户/持仓快照，避免 N 个信号重复拉同一份数据。

---

### 1.7 智能平仓三阶段存在重复筛选、重复排序与重复聚合

**位置：**
- `src/core/signalProcessor/utils.ts:123-200`
- `src/core/orderRecorder/orderStorage.ts:565-646`

**问题：**
智能平仓按 stage1 / stage2 / stage3 连续调用 `selectSellableOrders(...)`，而该函数内部又会重复进行：

- `filter`
- `sort`
- `calculateTotalQuantity`
- 构造 `Set`
- 构造数组副本

**影响：**
- 同一批订单在一次卖出决策里被多轮重复筛选
- 订单量大时 CPU 和 GC 压力都明显
- 高频卖出场景下这是非常实在的热路径

**建议方向：**
把三阶段规则收敛成单次扫描内完成候选分类与占用排除，减少重复排序和重复遍历。

---

## 2. 中优先级问题（P1）

### 2.1 `quoteClient.getQuotes()` 每次都物化数组和多个 `Map`

**位置：**
- `src/services/quoteClient/index.ts:495-538`

**问题：**
`getQuotes()` 当前流程中会：

1. `requestedSymbols = [...requestSymbols]`
2. `realtimeQuoteBySymbol = new Map()`
3. `result = new Map()`

**影响：**
- 每个主循环 tick 都会产生新的数组和多个 `Map`
- monitor 数量越大，GC 压力越明显
- 与外层主循环全量 sweep 叠加后，成为稳定热点

**建议方向：**
减少每轮物化结构数量，或者在更上层取消全量轮询模式。

---

### 2.2 `candlestickCache` 高频 push 时复制整段 candles 数组

**位置：**
- `src/services/quoteClient/candlestickCache.ts:164-188`
- `src/services/quoteClient/candlestickCache.ts:273-303`

**问题：**
K 线缓存更新时，`buildSnapshot()` 会复制 `candles` 数组；replace/append 路径也会构造新数组。

**影响：**
- 高频 push 下会持续制造短命数组
- K 线流越频繁，GC 压力越明显

**建议方向：**
改为更适合热路径的 ring buffer 或结构共享快照模型，避免每次复制整段 candles。

---

### 2.3 `indicatorCache.getAt()` 为延迟验证做多次线性扫描

**位置：**
- `src/main/asyncProgram/indicatorCache/utils.ts:46-86`
- `src/main/asyncProgram/delayedSignalVerifier/utils.ts:166-185`

**问题：**
延迟验证会在 T0 / T0+5s / T0+10s 进行多次 `getAt(...)` 查询；而 `findClosestEntry(...)` 本身仍是线性扫描 ring buffer。

**影响：**
- 形成“每秒持续采样 + 验证时多次线性回溯”的双重成本
- pendingSignals 多时成本更明显

**建议方向：**
降低采样量，或者为时间定位建立更轻量的索引结构；同时评估是否必须三次独立全扫。

---

### 2.4 `processMonitor` 把多类投影与派生任务绑在同一条 sweep 上

**位置：**
- `src/main/processMonitor/index.ts:27-85`
- `src/main/processMonitor/riskTasks.ts:62-97`
- `src/services/marketMonitor/index.ts:747-849`

**问题：**
`processMonitor(...)` 每轮都会串行执行：

1. `scheduleAutoSymbolTasks(...)`
2. `syncSeatState(...)`
3. `scheduleRiskTasks(...)`
4. `marketMonitor.monitorIndicatorChanges(...)`

**影响：**
- 少量变化也会导致全部 monitor 被完整评估
- autoSymbol / seat / risk / indicator 这些职责之间没有按事件源拆分
- 形成重复派生计算

**建议方向：**
把 quote 驱动的投影、candlestick 驱动的投影、seat/order 驱动的投影拆开，避免全部挂在单一 polling sweep 上。

---

### 2.5 `marketMonitor` 的变化检测与展示构建偏重

**位置：**
- `src/services/marketMonitor/index.ts:311-339`
- `src/services/marketMonitor/index.ts:347-479`
- `src/services/marketMonitor/index.ts:747-849`

**问题：**
`monitorIndicatorChanges(...)` 的处理模式大致是：

1. 遍历展示计划逐项比较当前值与缓存值
2. 一旦有变化，重新构建整套 `MonitorValues`
3. 拼完整指标字符串并打日志
4. 对象池释放旧值、重新申请并复制新值

**影响：**
- 高频行情时 CPU 与字符串格式化成本明显
- 日志输出进一步放大 I/O 阻塞

**建议方向：**
减少展示路径上的整套重建与全量字符串拼接，把日志输出粒度降下来。

---

### 2.6 高频日志格式化与双写可能反压事件消费

**位置：**
- `src/services/marketMonitor/index.ts:489-509`
- `src/services/marketMonitor/index.ts:677-679`
- `src/services/autoSymbolFinder/index.ts:89-104`
- `src/services/autoSymbolFinder/index.ts:122-129`
- `src/utils/logger/index.ts:333-402`
- `src/utils/logger/index.ts:520-603`

**问题：**
行情/指标/自动寻标等路径会频繁构造较长字符串并交给 logger；logger 又会执行：

- JSON 解析
- `JSON.stringify`
- `inspect`
- ANSI 处理
- 控制台/文件双写

**影响：**
- 高频日志会直接放大终端与文件 I/O 压力
- 反过来拖慢事件消费速度

**建议方向：**
把高频日志采样、合并，或下沉到 debug；只保留关键审计级日志。

---

### 2.7 策略信号生成路径里存在大量重复派生与字符串构造

**位置：**
- `src/core/strategy/index.ts:154-270`
- `src/core/strategy/utils.ts:123-163`
- `src/core/strategy/utils.ts:192-242`

**问题：**
`generateSignals(...)` 对四种 action 分别执行配置读取、条件组求值、指标可用性判断、日志串构造；命中时还会多次执行 `Object.keys -> map -> filter -> sort` 一类派生。

**影响：**
- 在高频 K 线 + 多 monitor 场景下，形成稳定的短命对象分配
- 日志文本越重，问题越明显

**建议方向：**
把同一 snapshot 的可复用派生数据复用起来，减少热路径字符串和 period 排序重复工作。

---

### 2.8 `runSignalPipeline()` 对每个信号重复执行一套 prepare 流程

**位置：**
- `src/main/businessEventProgram/signalPipeline.ts:68-182`

**问题：**
立即信号和延迟信号分别循环，每个 signal 都执行 `prepareSignal(...)`，内部重复做：

- action 合法性校验
- seat 解析
- symbol 匹配
- 日志路径判断

**影响：**
- 高频信号场景下会持续累积成本
- 虽然单次不重，但会成为稳定背景负担

**建议方向：**
在 action 级别预归类 seat 信息，减少重复解析和重复字符串构造。

---

### 2.9 卖出前仅为只读判断就复制买单数组

**位置：**
- `src/core/strategy/index.ts:176-187`
- `src/core/orderRecorder/orderStorage.ts:77-80`

**问题：**
卖出信号生成前会调用 `orderRecorder.getBuyOrdersForSymbol(...)` 判断是否存在买单，但该接口每次都会返回数组副本。

**影响：**
- 只为只读判断就复制整个数组
- 热路径上属于无意义分配

**建议方向：**
增加零复制的 `hasBuyOrders` / `getBuyOrderCount` 类专用查询。

---

### 2.10 延迟验证取消路径需要全量遍历 `pendingSignals`

**位置：**
- `src/main/asyncProgram/delayedSignalVerifier/index.ts:165-221`

**问题：**
`cancelAllForSymbol(...)` / `cancelAllForDirection(...)` 当前都需要全量扫描 `pendingSignals`。

**影响：**
- pendingSignals 堆积时，换标/清仓/切方向等清理路径成本会明显升高

**建议方向：**
为 symbol / direction 建立二级索引，降低取消路径复杂度。

---

### 2.11 `quoteClient.subscribeSymbols()` 的 metadata 初始化当前是串行的

**位置：**
- `src/services/quoteClient/index.ts:548-614`
- `src/services/quoteClient/index.ts:668-686`

**问题：**
新增标的接入时，当前执行顺序是：

1. `cacheStaticInfo(...)`
2. `ctx.quote(...)` 初始化 prevClose
3. `ctx.subscribe(...)`

其中 staticInfo 和 prevClose 初始化在逻辑上可并行，但当前是串行。

**影响：**
- 大批量接入 symbol 时会放大冷启动延迟

**建议方向：**
把 metadata 初始化改成有界并行，再统一订阅。

---

### 2.12 `resetRuntimeSubscriptionsAndCaches()` 对 candlestick 逐个串行退订

**位置：**
- `src/services/quoteClient/index.ts:844-899`

**问题：**
K 线退订当前是逐个 `await`，symbol/period 数量多时 stop/reset 尾延迟偏大。

**影响：**
- 停机与重置过程被线性拉长

**建议方向：**
在不破坏当前成功/失败一致性语义的前提下，改为有界并行退订。

---

## 3. 低优先级问题（P2）

### 3.1 `quoteSubscriptionRuntime` 的 seat 变化投影偏全量

**位置：**
- `src/main/quoteSubscriptionRuntime/index.ts:138-155`
- `src/main/quoteSubscriptionRuntime/index.ts:171-199`

**问题：**
seat 变化时会全量重扫 monitor × direction，再对 committed/desired 做全量 diff。

**影响：**
- 当前正确性较好，但 monitor churn 增大时扩展性一般

**建议方向：**
未来可改成增量 seat-bound retain 投影。

---

### 3.2 `AutoSearchWakeupRuntime` 在 gate-open 时存在一次性 fan-out

**位置：**
- `src/main/autoSearchWakeupRuntime/index.ts:194-239`

**问题：**
在 gate-open 时会遍历所有 monitor × direction 检查 EMPTY seat。

**影响：**
- 当前属于一次性成本，不是最核心热点
- 规模继续扩大时会带来明显 fan-out

**建议方向：**
未来可维护 EMPTY + autoSearchEnabled seat 索引。

---

### 3.3 `businessEventProgram` 在 burst 下可能连续重跑整条指标/信号流水线

**位置：**
- `src/main/businessEventProgram/index.ts:99-165`

**问题：**
当前已有 single-flight + latest-only collapse，是正确方向；但 burst 下同一 monitor 仍可能在 `while (routeState.dirty)` 中连续执行整条指标与信号链。

**影响：**
- 高频 burst 下仍会有累积成本

**建议方向：**
继续保持该设计方向，并在上游减少无效 snapshot 构建成本。

---

### 3.4 对象池释放时通过删除键清空对象，可能带来隐藏类退化

**位置：**
- `src/utils/objectPool/index.ts:14-19`

**问题：**
`resetRecordObject(...)` 当前通过 `Object.keys + Reflect.deleteProperty` 清空对象。

**影响：**
- 高周转时可能触发 hidden class 退化与额外开销

**建议方向：**
如果后续继续深挖，可评估固定字段复位或更窄专池。

---

### 3.5 `orderFilteringEngine` 与若干订单恢复路径存在多轮 `filter`

**位置：**
- `src/core/orderRecorder/orderFilteringEngine.ts:71-155`

**问题：**
部分订单过滤逻辑通过多轮 `filter` 和数组拼接完成。

**影响：**
- 主要影响恢复/刷新阶段，不是最高频在线热点

**建议方向：**
在订单量非常大时可再做专项优化。

---

### 3.6 异常路径中存在重型 `JSON.stringify(signal)`

**位置：**
- `src/main/businessEventProgram/signalPipeline.ts:96-107`

**问题：**
异常信号分支直接 `JSON.stringify(signal)`。

**影响：**
- 正常场景影响有限
- 异常流量升高时会放大 CPU 与日志体积

**建议方向：**
改成更轻量的异常摘要输出。

---

### 3.7 `cloneIndicatorSnapshot` 当前按完整对象复制，可能超出验证实际需要

**位置：**
- `src/main/asyncProgram/indicatorCache/utils.ts:103-125`

**问题：**
`cloneIndicatorSnapshot(...)` 当前对 `rsi/ema/psy/kdj/macd` 全量复制。

**影响：**
- 如果延迟验证只依赖部分指标，当前属于过度拷贝

**建议方向：**
未来可按 verificationIndicators 或 profile 做裁剪采样，但必须保证语义严格不变。

---

## 4. 关联问题与补充说明

### 4.1 终端“渲染”本质上是 logger 投影

当前仓库没有独立 screen/view/store 层；所谓终端显示主要由：

- `src/services/marketMonitor/index.ts`
- `src/services/accountDisplay/index.ts`
- `src/utils/logger/index.ts`

共同组成日志式投影。因此当前“终端性能问题”本质不是 TUI diff，而是：

1. 轮询驱动的全量投影评估
2. 高频字符串拼接
3. 高频日志 I/O

### 4.2 本次没有把启动链当成主热点

`startup gate`、`createPreGateRuntime` 等路径主要是启动期逻辑，不是稳态主瓶颈。本次不把它们列为主要性能问题。

### 4.3 当前架构并非方向错误，而是热路径还没收口

本次审查也确认了若干正确方向已经存在：

- `businessEventProgram` 的 per-monitor single-flight + latest-only collapse
- `monitorQuoteEventRuntime` 的 single-flight + latest-only collapse
- `autoSearchWakeupRuntime` 的 one-shot timer 语义
- 指标系统已经从全量重算走向增量 runtime

问题的关键不在于整体方向错误，而在于**主循环 sweep、全量索引重建、整块深拷贝、重复筛选**还没有进一步收口。

---

## 5. 最终优先级排序（建议改造顺序）

### 第一梯队：收益最大

1. 去掉主循环中的非时间语义全量 sweep
2. 去掉 `indicatorCache` 的每秒重复采样深拷贝
3. 去掉 `MonitorQuoteEventRuntime` 的全量 WAIT route 扫描
4. 去掉 `TradingRiskEventRuntime` 的每 quote 全量 routing index 重建
5. 去掉指标 runtime 中的 committed 深拷贝

### 第二梯队：高频计算强化

6. 合并买入信号的实时账户/持仓检查
7. 重写智能平仓三阶段重复筛选
8. 减少 `candlestickCache` / `getQuotes()` / `marketMonitor` 中的热路径对象分配
9. 降低高频日志投影粒度

### 第三梯队：次级优化

10. `delayedSignalVerifier` 取消索引化
11. `quoteClient` 接入/退订并行化
12. `quoteSubscriptionRuntime` 增量投影
13. 对象池记录对象复位策略优化

---

## 6. 一句话结论

当前系统最主要的性能问题可以概括为五句话：

1. **主循环做了太多本应由事件驱动完成的事情。**
2. **高频事件链上仍有全量扫描和全量重建。**
3. **增量指标链路里仍保留了不小的整块深拷贝成本。**
4. **信号链路中存在单信号粒度重复 I/O 与多阶段重复筛选。**
5. **终端投影本质上是高频日志系统，当前成本偏重。**
