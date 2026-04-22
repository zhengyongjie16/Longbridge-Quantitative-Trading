# 终端显示事件驱动重构方案

## 1. 已确认需求

本次重构以用户新确认的两条要求为准：

1. **交易标的显示不再要求双边一起输出。**
   - 哪个交易标的收到 quote push，就只输出哪个交易标的。
   - 不再保持当前 `monitorPriceChanges(...)` 的“双边联动输出”语义。
2. **彻底删除本地变更检查逻辑。**
   - 前提不是“无条件相信任意 raw SDK push 恒等于完整新状态”。
   - 本仓库真正消费的是 `quoteClient` 发布的标准化事件：`onQuoteUpdated(...)` / `onCandlestickUpdated(...)`。
   - 因此显示层不再做任何本地“是否变化”“是否超过阈值”的判断，收到标准化事件后直接格式化并输出。

这两条要求会直接改变原方案中的两个判断：

1. 不再需要按 `monitorSymbol` 聚合后双边一起打印交易标的。
2. 不再需要 `marketMonitor` 当前那套 `hasChanged(...) + monitorValues/longPrice/shortPrice` 缓存比较机制。

## 2. 现状复核

### 2.1 当前显示 owner

当前终端显示主要由以下链路驱动：

1. `src/app/runApp.ts`
   - 每秒调用一次 `timeDriverProgram(...)`
2. `src/main/timeDriverProgram/index.ts`
   - 每 tick 读取 `getQuotes(lastState.allTradingSymbols)`
   - 遍历全部 `monitorContexts`
   - 调用 `processMonitor(...)`
3. `src/main/processMonitor/index.ts`
   - 调 `scheduleRiskTasks(...)`
   - 调 `marketMonitor.monitorIndicatorChanges(...)`
4. `src/main/processMonitor/riskTasks.ts`
   - 调 `marketMonitor.monitorPriceChanges(...)`

所以当前显示 owner 仍然是**时间循环**，不是推送回调。

### 2.2 当前显示模块真实职责

`src/services/marketMonitor/index.ts` 当前不是纯展示模块，而是“本地变化检测 + 展示输出”的混合模块：

1. `monitorPriceChanges(...)`
   - 比较 `monitorState.longPrice / shortPrice`
   - 任一方向变化则双边一起输出
2. `monitorIndicatorChanges(...)`
   - 比较 `monitorState.monitorValues`
   - 只有命中本地变化条件才输出

对应的本地检测依赖包括：

- `src/services/marketMonitor/utils.ts`
  - `hasChanged(...)`
- `src/services/marketMonitor/index.ts`
  - `resolveDisplayThreshold(...)`
  - `buildMonitorValuesFromDisplayPlan(...)`
  - `getCachedDisplayValue(...)`
- `src/types/state.ts`
  - `MonitorState.longPrice`
  - `MonitorState.shortPrice`
  - `MonitorState.monitorValues`

这些逻辑和用户刚确认的要求是冲突的，必须删掉，不能保留。

### 2.3 当前事件链路基础

#### 监控标的 `K` 线事件

- `src/services/quoteClient/index.ts`
  - `setOnCandlestick(...)` 处理 SDK push
  - `onCandlestickUpdated(...)` 发布标准化事件
- `src/main/businessEventProgram/index.ts`
  - 已经是普通 `K` 线业务 owner
  - 已有 `single-flight + latest-only collapse`
  - 已在 route 内执行：
    - `runIndicatorPipeline(...)`
    - `indicatorCache.push(...)`
    - `runSignalPipeline(...)`

所以监控标的显示的**权威数据来源**在 `businessEventProgram` route 内，但终端输出本身不应直接反向塞进这条核心业务链路。

#### 交易标的 quote 事件

- `src/services/quoteClient/index.ts`
  - `setOnQuote(...)` 处理 SDK push
  - `onQuoteUpdated(...)` 发布标准化事件
- `symbolRegistry.resolveSeatBySymbol(...)`
  - 已能把交易标的反查到所属 `monitorSymbol + direction`
  - 但最终显示方案的 route 复核应复用 `tradingRiskEventRuntime` 已有的路由 helper，而不是停留在这一步

所以交易标的显示具备由标准化 quote 事件驱动的基础，但最终 route 身份判断不能只停留在一次反查。

## 3. 可行性与合理性结论

## 3.1 可行

这次重构仍然完全可行。

原因不是“现有轮询稍微改一下”，而是：

1. `K` 线业务 owner 已经存在：
   - `businessEventProgram`
2. quote 事件源已经存在：
   - `onQuoteUpdated(...)`
3. 显示所需附加数据已经存在：
   - `riskChecker`
   - `orderRecorder`
   - `symbolRegistry`
   - `getQuotes(...)` 读取 SDK realtime 状态

因此不需要兜底，不需要兼容双轨，也不需要新建第二份 quote 缓存。

## 3.2 合理

这次方案比上一版更合理，但经过再次复核后，必须加上五个边界约束，否则会把显示副作用重新污染核心业务路径，或者误删仍然存在的真实 owner：

1. **不能把 async `getQuotes(...)` 和终端输出直接塞进 `businessEventProgram` 核心链路。**
   - 显示是投影，不是业务 owner。
   - 如果在 `businessEventProgram` 里直接 `await getQuotes(...) -> render(...)`，显示失败或等待就会反向阻塞 `indicatorCache.push(...)`、席位同步和信号生成，语义上是错误的。
2. **事件驱动不等于无门禁地消费所有 raw push。**
   - 当前显示 owner 虽然是时间循环，但它天然复用了 `lastState.isTradingEnabled` 与 `lastState.canTrade === true` 的运行时门禁。
   - 这次迁移不能把显示语义意外放大成“非连续交易时段、重建期、门禁关闭时也直接输出”。
   - 同时，显示输入边界应当是 `quoteClient` 的标准化 admitted event，而不是把整个方案建立在 raw SDK push 细节之上。
3. **startup / open rebuild 的初始真相也必须进入显示链路。**
   - 当前启动链路会先订阅并 seed 监控标的 K 线缓存，显示真相不只有未来的增量 `onCandlestickUpdated(...)` 事件，还包括启动与开盘重建后已经存在于缓存里的首帧真相。
   - 如果方案只等待“下一根新 K 线 push 才显示”，就会把已知回归原样带进新方案。
4. **删除轮询显示路径，不等于可以直接删除 `processMonitor` 的时间语义维护 owner。**
   - 当前代码里，`processMonitor -> syncSeatState(...) -> syncSignalSeatState(...)` 仍然承担 `ACTIVE -> 非 ACTIVE` 时的延迟验证、买卖任务、监控任务与牛熊证缓存清理。
   - 同时 `syncSeatState(...)` 仍然是 `monitorContext.longSymbolName / shortSymbolName / monitorSymbolName` 的当前 owner；如果本轮不把名称维护迁到新的 seat-event owner，就不能把这条职责和 `quotesMap` 一起删掉。
5. **交易标的显示 runtime 可以独立，但路由真相不能再平行造一份。**
   - 当前 `tradingRiskEventRuntime` 已经有 `tradingSymbol -> monitorSymbol + direction + seatVersion` 的权威路由索引与复核逻辑。
   - 显示 runtime 可以不等待 freshness baseline，但必须直接复用或轻量抽取这套路由规则，不能只靠 `resolveSeatBySymbol(...)` 临时手搓第二套判断。

在补上这些约束后，这次方案才与用户真实需求一致：

1. 显示触发条件直接等于标准化 admitted event 与 startup/rebuild bootstrap，而不是“事件到达后本地再判定一次是否有变化”。
2. 交易标的显示粒度直接等于“单标的单事件”，不再被旧的 monitor 聚合语义绑住。
3. 监控标的显示的 handoff 边界回到“snapshot / indicatorCache 已提交”，而不是等待 `runSignalPipeline(...)` 成功。
4. 显示层职责收缩为纯投影，不再偷偷承担状态比较缓存 owner。
5. 删除显示轮询路径时，不会误删当前仍然存在的席位退场清理与名称维护 owner。

## 4. 第一性原理后的正确设计

### 4.1 监控标的显示

监控标的显示的权威来源 owner：

- `src/main/businessEventProgram/index.ts`

监控标的显示的终端输出 owner：

- 新增独立 `monitorDisplayRuntime`

正确触发点分成两类：

1. **增量事件触发**
   1. 收到 `onCandlestickUpdated(...)`
   2. 进入 `businessEventProgram` 单 monitor route
   3. `runIndicatorPipeline(...)` 成功得到 `monitorSnapshot`
   4. 先完成这次已提交边界：
      - `indicatorCache.push(...)`
      - `syncSignalSeatState(...)`
   5. 立刻把这次**已提交的** `monitorSnapshot` 交给 `monitorDisplayRuntime`
   6. 再继续执行 `runSignalPipeline(...)`
2. **startup / open rebuild bootstrap 触发**
   1. 启动或开盘重建先完成 K 线订阅与缓存 seed
   2. 对每个已有有效 candlestick snapshot 的 `monitorSymbol` 主动执行一次与增量路径同口径的 bootstrap render request
   3. 这次 bootstrap 不依赖等待下一根新 K 线 push，目标是恢复首帧监控标的显示真相

`monitorDisplayRuntime` 在复用当前 runtime gate 后读取当前 monitor quote，并输出一次监控标的显示。

这里不再做任何本地变化判断。

但这里也**不能**做两件事：

1. 不能在 raw `onCandlestickUpdated(...)` callback 最外层直接输出。
2. 不能在 `businessEventProgram` 内直接 `await getQuotes(...) -> render(...)`。

否则 display 失败、等待或并发顺序问题会反向污染普通 K 线业务链路。

### 4.2 交易标的显示

交易标的显示的正确 owner：

- 新增独立 quote 显示 runtime
- 交易标的路由真相直接复用或轻量抽取 `tradingRiskEventRuntime` 现有 helper

正确触发点：

1. 收到 `onQuoteUpdated(...)`
2. 先复用当前 runtime gate：
   - `lastState.isTradingEnabled === true`
   - `lastState.canTrade === true`
3. 基于当前 `symbolRegistry` 权威快照重建路由索引，并用共享 route helper 解析 `event.symbol`
4. 如果当前未命中某个 ACTIVE route：
   - 忽略
5. 如果命中：
   - 捕获该 route 的 `monitorSymbol + direction + seatVersion`
   - 如需补 monitor quote，则读取 `getQuotes([monitorSymbol])`
   - 在真正输出前用同一套共享 helper 再次校验 route 仍然是当前有效 route
   - 然后输出该单个交易标的的显示

这里也不再做任何本地变化判断。

这里的“事件驱动”指的是消费 `quoteClient` 已标准化的 `QuoteUpdatedEvent`，而不是把 raw SDK push 细节当成业务契约；为了避免 async 读 quote 后打印出旧席位，必须做 route 级身份复核。

### 4.3 不再保持旧语义

本次明确废弃以下旧语义：

1. 任一方向变化时双边一起输出
2. 本地价格阈值检测
3. 本地指标阈值检测
4. 首次出现有效值才输出的特殊处理
5. 通过 `monitorValues` 保存上一次显示值再比较

这些都属于旧的轮询时代补偿逻辑，本次必须删掉。

## 5. 目标结构

### 5.1 把 `marketMonitor` 从“监控器”改成“纯渲染器”

当前 `marketMonitor` 这个名字和实现已经不符合目标。

本次重构后，它应当收缩为纯格式化/输出模块，例如保留或改造成：

1. `renderTradingQuote(...)`
   - 输入单个交易标的 quote 和显示附加信息
   - 直接输出一行
2. `renderMonitorIndicators(...)`
   - 输入 `monitorSnapshot + monitorQuote + indicatorProfile`
   - 直接输出一行

它不再负责：

1. 判断是否变化
2. 记忆上一次显示值
3. 维护价格缓存
4. 决定双边是否一起输出

### 5.2 监控标的 `K` 线显示链路

重构后的执行顺序应为：

1. `runIndicatorPipeline(...)`
2. `indicatorCache.push(...)`
3. `syncSignalSeatState(...)`
4. `monitorDisplayRuntime.requestRender({ monitorSymbol, monitorSnapshot })`
5. `runSignalPipeline(...)`

说明：

1. `businessEventProgram` 只负责把**已提交的** `monitorSnapshot` 交给显示 runtime，不直接回读 quote。
2. 这里的“已提交”边界以 `monitorSnapshot` 已写入 `indicatorCache` 且席位同步完成为准；不能再把显示耦合到 `runSignalPipeline(...)` 是否成功。
3. monitor quote 的读取与终端输出由 `monitorDisplayRuntime` 自己承担，因为 `getQuotes(...)` 是 async 边界。
4. `monitorDisplayRuntime` 对同一 `monitorSymbol` 使用 `single-flight + latest-only collapse`，避免显示副作用并发乱序。
5. `requestRender(...)` 必须是 best-effort side effect，显示失败只能记日志，不能回滚或中断核心业务链路。
6. startup / open rebuild 还需要复用同一 runtime 主动补发 bootstrap request，确保已有 candlestick cache 能重建首帧显示。
7. 这里不需要任何 `monitorValues` 缓存。

### 5.3 交易标的 quote 显示链路

新增 runtime，例如：

- `src/main/tradingQuoteDisplayRuntime/index.ts`
- `src/main/tradingQuoteDisplayRuntime/types.ts`

同样，这个 runtime 也必须纳入统一 lifecycle owner：

- 在 `createPostGateRuntime` / `runApp` 中创建
- 在 `createLifecycleRuntime -> createSignalRuntimeDomain` 中统一 stop/start
- `midnightClear` 停止并排空在途 route
- `openRebuild` 仅在 route 真相恢复后再启动，避免重建期继续消费旧 seat 身份

职责只做一件事：

1. 监听 `onQuoteUpdated(...)`
2. 复用或轻量抽取 `tradingRiskEventRuntime` 已有的 trading-symbol route helper 解析归属
3. 复用 runtime gate，非交易时段/重建期/门禁关闭时不输出
4. 如果命中 ACTIVE seat：
   - 以 `monitorSymbol + direction + seatVersion` 建 route
   - route 内构造该单标的显示附加信息
   - 输出前再次按同一套 route 规则复核 seat 身份仍然有效
   - 然后输出该单标的行情

这里不再需要按 monitor 聚合 long + short。

即：

- long push 只输出 long
- short push 只输出 short

### 5.4 显示 gate 与失败隔离

这次重构必须显式保留以下运行约束：

1. 显示复用 `lastState.isTradingEnabled === true` 与 `lastState.canTrade === true`。
2. 显示不复用 `openProtectionActive`，因为当前开盘保护只禁止普通信号生成，不禁止展示。
3. 显示不等待 `postTradeConsistencyRuntime` baseline，因为当前展示链路也没有这层等待语义。
4. 任一 display runtime 的 quote 读取失败、格式化失败、logger 输出失败，都只能局部记日志并跳过本次输出，不能影响：
   - `indicatorCache.push(...)`
   - `syncSignalSeatState(...)`
   - `runSignalPipeline(...)`
   - 时间语义下的自动换标 tick

## 6. 需要删除的旧逻辑

### 6.1 删除本地变化检测

必须删除：

1. `src/services/marketMonitor/utils.ts`
   - `hasChanged(...)`
2. `src/services/marketMonitor/index.ts`
   - `resolveDisplayThreshold(...)`
   - `getCachedDisplayValue(...)`
   - 所有基于 `lastValue/currentValue` 的比较流程
   - `monitorPriceChanges(...)` 里的双边联动判定
   - `monitorIndicatorChanges(...)` 里的本地阈值判断

### 6.2 删除显示缓存状态

由于显示不再依赖本地比较，以下状态字段应视为死代码并删除：

1. `src/types/state.ts`
   - `MonitorState.longPrice`
   - `MonitorState.shortPrice`
   - `MonitorState.monitorValues`
2. `src/types/data.ts`
   - `MonitorValues`
3. `src/utils/helpers/index.ts`
   - `initMonitorState(...)` 对应初始化字段
4. `src/main/lifecycle/cacheDomains/globalStateDomain.ts`
   - 对应清理逻辑
5. `src/constants/index.ts`
   - `MONITOR.PRICE_CHANGE_THRESHOLD`
   - `MONITOR.INDICATOR_CHANGE_THRESHOLD`
   - `MONITOR.CHANGE_PERCENT_THRESHOLD`

### 6.3 删除时间循环显示路径，但不误删时间语义维护 owner

必须删除：

1. `src/main/timeDriverProgram/index.ts`
   - 为显示而做的 quote sweep
   - 为显示而调用 `processMonitor(...)` 的那部分显示职责
2. `src/main/processMonitor/index.ts`
   - 指标显示调用
3. `src/main/processMonitor/riskTasks.ts`
   - 整个文件删除
4. `src/main/processMonitor/types.ts`
   - 与 `marketMonitor`、`quotesMap`、显示相关的类型边界

但这次方案**不能**直接把 `processMonitor` / `timeDriverProgram` 宣布为死代码。原因是当前时间语义链路里仍然至少有三个非显示职责：

1. `scheduleAutoSymbolTasks(...)` 的自动换标 tick 调度
2. `syncSignalSeatState(...)` 在 `ACTIVE -> 非 ACTIVE` 时的队列与风险缓存清理
3. `syncSeatState(...)` 对 `monitorContext.longSymbolName / shortSymbolName / monitorSymbolName` 的名称维护

因此本次最短正确路径是：

1. 先删除显示路径
2. 保留最小时间语义 owner，继续承担自动换标 tick、席位退场清理与名称维护
3. 或者在本次重构里显式把名称维护迁到新的 seat-event owner，再同步从 `processMonitor/timeDriver` 删除这条职责
4. 如果未来还想彻底删除 `processMonitor/timeDriver` 这部分维护逻辑，必须先在独立方案里明确把剩余职责迁移完成，再删除旧入口

## 7. 详细方案

### 7.1 监控标的显示改造

#### 依赖边界调整

`src/main/businessEventProgram/types.ts`

不要把依赖补充成 `marketDataClient.getQuotes + render`。

正确做法是只补一个显示 runtime 端口，例如：

1. `monitorDisplayRuntime.requestRender(...)`

不再注入：

1. `marketDataClient.getQuotes`
2. 旧的“检测后再显示”接口

#### 执行逻辑

`src/main/businessEventProgram/index.ts`

在 `runIndicatorPipeline(...)` 成功并完成本次核心业务提交后：

1. 调 `monitorDisplayRuntime.requestRender({ monitorSymbol, monitorSnapshot })`

要求：

1. 不做本地比较
2. 不看 `monitorState.monitorValues`
3. 不因为“显示值没变”而跳过
4. 不能在 `businessEventProgram` 内直接 `await getQuotes(...)`
5. 不能让显示异常阻断 `indicatorCache.push(...)` 或 `runSignalPipeline(...)`

#### `monitorDisplayRuntime` 的最小依赖

建议只依赖：

1. `lastState`
2. `monitorContexts`
3. `marketDataClient.getQuotes`
4. 纯渲染接口

另外，这个 runtime 必须被纳入统一 lifecycle owner，而不是作为游离 runtime 单独存活：

1. `createPostGateRuntime` / `runApp` 负责创建与注入
2. `createLifecycleRuntime -> createSignalRuntimeDomain` 负责把它纳入 `midnightClear / openRebuild`
3. `midnightClear` 需要 `stopAndDrain()`，避免跨日残留显示任务继续输出
4. `openRebuild` 需要先恢复 runtime，再在订阅与 snapshot seed 完成后补发 bootstrap render request

route 逻辑：

1. `requestRender(...)` 只接收已提交的 `monitorSnapshot`
2. 以 `monitorSymbol` 作为 route key
3. 对同一路由使用 `single-flight + latest-only collapse`
4. route 执行时先检查 runtime gate
5. 再 `getQuotes([monitorSymbol])` 读取当前 monitor quote
6. 然后调用纯渲染函数输出
7. 任一失败只记日志，不反向抛回 `businessEventProgram`
8. 对 startup / open rebuild，允许单独提供 `bootstrapFromCurrentTruth(...)` 或等价入口，按当前 candlestick cache 主动补发首帧显示

### 7.2 交易标的显示改造

#### 新 runtime 的最小依赖

建议只依赖：

1. `marketDataClient.onQuoteUpdated`
2. `marketDataClient.getQuotes`
3. `lastState`
4. `monitorContexts`
5. `symbolRegistry`
6. 共享 trading-symbol route helper
7. 纯渲染接口

`getQuotes(...)` 只用于补充显示附加信息需要的当前 monitor 价格或其他关联 quote，不用于本地轮询。

#### 路由逻辑

对每条 `QuoteUpdatedEvent`：

1. 先检查 runtime gate；若门禁关闭，忽略
2. 基于共享 helper 重建当前 trading-symbol 路由索引
3. 用共享 helper 解析 `event.symbol` 对应 route；若未命中，忽略
4. 若 route 当前不是 ACTIVE 可消费状态，忽略
5. 捕获当前 `monitorSymbol + direction + seatVersion`
6. 以该 route 身份进入 `single-flight + latest-only collapse`
7. 若本次输出需要 monitor 当前价格，则读取 `getQuotes([monitorSymbol])`
8. 真正输出前再次用共享 helper 校验当前 route 仍然有效，要求：
   - `routeKey` 一致
   - `seatVersion` 一致
   - seat 仍为 `ACTIVE`
9. 校验通过后按该条最新事件输出对应单标的

这里优先直接复用 `buildTradingRiskRoutingIndex(...)`、`resolveTradingRiskRoute(...)`、`isTradingRiskRouteCurrent(...)`；如果命名边界确实不合适，只允许做一次轻量抽取，不允许再发明第二套路由规则。

#### 显示附加信息组装

交易标的显示仍需保留当前显示内容中的附加项：

1. 距回收价
2. 持仓市值
3. 持仓盈亏
4. 订单数量

这些继续复用现有口径：

1. `riskChecker.getWarrantDistanceInfo(...)`
2. `riskChecker.getUnrealizedLossMetrics(...)`
3. `orderRecorder.getBuyOrdersForSymbol(...)`

但组装逻辑应抽成公共 helper，例如：

- `src/services/marketMonitor/priceDisplayInfo.ts`

该 helper 只负责根据当前 event、monitor 当前 quote 与现有业务缓存构造 `PriceDisplayInfo`，不做任何变化检测，也不创建新的 quote 真相缓存。

### 7.3 显示模块重命名或收缩

当前 `MarketMonitor` 这个接口名已经带有错误语义。

建议本次直接收缩为纯渲染接口，例如：

- `MarketDisplayRenderer`

最少提供两个方法：

1. `renderTradingQuote(...)`
2. `renderMonitorIndicators(...)`

如果不想大规模改名，也至少要把旧方法语义改成“收到输入就立即输出”，不能继续保留“monitor + detect changes”的含义。

## 8. 文件级改动清单

### 8.1 生产代码

1. `src/main/businessEventProgram/index.ts`
2. `src/main/businessEventProgram/types.ts`
3. `src/main/monitorDisplayRuntime/index.ts` 新增
4. `src/main/monitorDisplayRuntime/types.ts` 新增
5. `src/main/tradingQuoteDisplayRuntime/index.ts` 新增
6. `src/main/tradingQuoteDisplayRuntime/types.ts` 新增
7. `src/main/timeDriverProgram/index.ts`
8. `src/main/timeDriverProgram/types.ts`
9. `src/main/processMonitor/index.ts`
10. `src/main/processMonitor/types.ts`
11. `src/main/processMonitor/riskTasks.ts` 删除
12. `src/services/marketMonitor/index.ts`
13. `src/services/marketMonitor/types.ts`
14. `src/services/marketMonitor/utils.ts`
15. `src/services/marketMonitor/priceDisplayInfo.ts` 新增
16. `src/app/runtime/createPostGateRuntime.ts`
17. `src/app/runApp.ts`
18. `src/app/types.ts`
19. `src/app/shutdown/createCleanup.ts`
20. `src/app/lifecycle/createLifecycleRuntime.ts`
21. `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
22. `src/constants/index.ts`
23. `src/types/state.ts`
24. `src/types/data.ts`
25. `src/utils/helpers/index.ts`
26. `src/main/lifecycle/cacheDomains/globalStateDomain.ts`
27. `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
28. `src/main/lifecycle/rebuildTradingDayState.ts`

### 8.2 测试

1. `tests/services/marketMonitor/business.test.ts`
   - 改成验证纯渲染行为
   - 删除所有“阈值检测 / unchanged / cache sync”断言
2. `tests/main/monitorDisplayRuntime/*.test.ts` 新增
   - 验证 monitor route collapse、gate 复用、显示失败隔离
3. `tests/main/tradingQuoteDisplayRuntime/*.test.ts` 新增
   - 验证 route 身份复核、单标的输出与 seat 失效跳过
   - 验证使用与 `tradingRiskEventRuntime` 一致的 route 规则
4. `tests/main/businessEventProgram/business.test.ts`
   - 改成验证 `K` 线事件到达后在 `indicatorCache.push(...) + syncSignalSeatState(...)` 之后立即请求 monitor display runtime，不直接回读 quote
   - 新增验证 startup 不再遗漏已有 candlestick cache 的 bootstrap request
5. `tests/main/processMonitor/index.business.test.ts`
   - 改成验证 `processMonitor` 不再承担显示职责，但仍保留最小时间语义职责
6. `tests/main/processMonitor/riskTasks.business.test.ts`
   - 删除或改为验证该文件已移除
7. `tests/main/timeDriverProgram/business.test.ts`
   - 改成验证 timeDriver 不再持有显示 owner，但仍驱动剩余的 monitor 维护 tick
8. `tests/main/processMonitor/seatSync.business.test.ts`
   - 增强验证 `ACTIVE -> 非 ACTIVE` 时的队列与风险缓存清理在本次重构后仍存在
   - 若本次迁移名称维护 owner，再补名称更新归属测试
9. `tests/app/createLifecycleRuntime.wiring.test.ts`
   - 新增验证 monitorDisplayRuntime / tradingQuoteDisplayRuntime 已纳入 signalRuntime domain 的 stop/start 顺序
10. `tests/app/runApp.test.ts`

- 更新 runtime wiring、startup bootstrap 与 cleanup 顺序

11. `tests/architecture/importBoundary.test.ts`

- 若类型/服务边界重命名或路径变化，同步更新

11. 所有直接构造 `MonitorState` 的 helper / double

- 例如 `tests/helpers/testDoubles.ts`、`tests/app/utils.ts`

12. 所有直接 stub `marketMonitor` 的 wiring / integration tests

- 例如 `tests/app/createLifecycleRuntime.wiring.test.ts`
- `tests/integration/full-business-simulation.integration.test.ts`
- `tests/integration/main-program-strict.integration.test.ts`
- `tests/integration/main-loop-latency.integration.test.ts`
- `tests/integration/multi-monitor-concurrency.integration.test.ts`

## 9. 验收标准

### 9.1 代码结构

满足以下条件才算完成：

1. `src/` 中不再存在显示用的本地变化检测逻辑
2. `hasChanged(...)` 不再被显示链路引用
3. `MonitorState.longPrice / shortPrice / monitorValues` 已删除
4. `timeDriverProgram` 不再持有显示 owner，但当前仍需保留的时间语义维护 owner 没有被误删
5. `MonitorValues` 类型与 `MONITOR.*CHANGE_THRESHOLD` 常量已删除
6. `businessEventProgram` 不直接依赖 `marketDataClient.getQuotes`
7. 监控标的显示的权威来源只在 `businessEventProgram`，终端输出由独立 display runtime 承担
8. `monitorDisplayRuntime` 与 `tradingQuoteDisplayRuntime` 都已纳入 `createLifecycleRuntime -> createSignalRuntimeDomain` 的统一 owner
9. startup / open rebuild 都有基于当前 candlestick cache 的 monitor display bootstrap 入口
10. 交易标的显示 owner 只在新的 quote 显示 runtime
11. 交易标的显示 route 真相复用现有 `tradingRiskEventRuntime` 路由规则或其轻量抽取结果

### 9.2 运行行为

满足以下行为：

1. 每次监控标的 `K` 线 route 在 `indicatorCache.push(...)` 与席位同步完成后，都会向 `monitorDisplayRuntime` 发起一次显示请求；不等待 `runSignalPipeline(...)` 成功
2. startup / open rebuild 完成订阅与 snapshot seed 后，已有有效 candlestick cache 的 monitor 都会收到一次 bootstrap 显示请求
3. 每次交易标的 quote push 命中当前 ACTIVE seat 后，只输出该单个交易标的
4. 不再存在“双边一起输出”的交易标的显示语义
5. 不再因为本地比较结果而跳过显示
6. runtime gate 关闭时，display runtime 不输出
7. 显示失败不会阻断 `indicatorCache.push(...)`、席位同步或信号生成
8. `ACTIVE -> 非 ACTIVE` 时的延迟验证/任务队列/风险缓存清理仍然按当前语义发生

### 9.3 禁止项

以下任一出现都算未完成：

1. 保留旧的时间循环显示路径
2. 保留本地变化阈值检查
3. 保留 `monitorValues` / `longPrice` / `shortPrice` 作为显示缓存
4. 为了兼容而同时保留旧显示 owner 和新显示 owner
5. 为显示再造第二份 quote 真相缓存
6. 在 `businessEventProgram` 内直接 `await getQuotes(...) -> render(...)`
7. 把 monitor display handoff 继续定义成“`runSignalPipeline(...)` 成功之后”
8. 让 display 异常反向中断 `indicatorCache.push(...)` 或 `runSignalPipeline(...)`
9. trading quote 显示在 async 读取 monitor quote 后不做 `seatVersion` 复核就直接输出
10. display runtime 绕过 `lastState.isTradingEnabled / canTrade` 直接消费 raw push
11. 通过 `symbolRegistry.resolveSeatBySymbol(...)` 单点判断直接手搓第二套 trading-symbol 路由真相
12. 新增 display runtime 却不把它们纳入 lifecycle signalRuntime 域统一 stop/start
13. 删除显示路径时把 `ACTIVE -> 非 ACTIVE` 的席位退场清理或名称维护 owner 一并删掉
14. 接受“启动后直到下一根新 K 线 push 才显示”却不在文档中显式改需求

## 10. 一句话结论

按你刚确认的要求，这次重构的最短正确路径是：

1. **监控标的显示的数据来源仍由 `businessEventProgram` 提供，但真正输出交给独立 `monitorDisplayRuntime`，且 handoff 边界必须前移到 `indicatorCache.push(...) + syncSignalSeatState(...)` 之后，避免再次耦合 `runSignalPipeline(...)` 成败**
2. **startup / open rebuild 必须基于当前 candlestick cache 主动补发 monitor display bootstrap，不能等下一根新 K 线 push 才恢复首帧显示**
3. **交易标的显示改为标准化 quote 事件到达后按单标的直接输出，并复用现有 trading-risk 路由真相在 async 补 monitor quote 后复核同一 `seatVersion` 仍然有效**
4. **monitorDisplayRuntime 与 tradingQuoteDisplayRuntime 都必须纳入 lifecycle signalRuntime 域统一 stop/start，不能绕过跨日清理与开盘重建语义**
5. **彻底删除 `marketMonitor` 当前的本地变更检查逻辑、显示缓存状态、`MonitorValues` 类型与相关阈值常量**
6. **彻底删除 `timeDriverProgram/processMonitor` 内的轮询显示 owner，但不能误删当前仍负责自动换标 tick、席位退场清理与名称维护的最小时间语义 owner**

不保留双边输出语义，不保留本地变化判断，不保留兼容双轨。
