# 交易标的浮亏检查 WS 直驱化重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将交易标的浮亏检查从主循环中彻底移出，改为由 Longbridge quote WebSocket push 直接驱动执行交易标的的浮亏检查；主循环不再承担任何交易标的浮亏检查触发职责。

**Architecture:** 保留现有主循环、指标流水线、信号生成、买卖处理器、订单监控与成交后一致性刷新；新增独立的 `TradingRiskEventRuntime` 订阅标准化 quote 更新事件，并在事件回调中基于 `symbolRegistry` 权威席位快照直接执行交易标的浮亏检查。`quoteClient` 只向 runtime 发布 admitted 且带有效 trading price 的 quote 事件；浮亏检查命中后继续复用现有 `trader.executeSignals(...) -> orderMonitor -> postTradeConsistencyRuntime` 成交闭环；新 runtime 必须纳入 lifecycle 的 signal runtime owner 顺序，与 `postTradeConsistencyRuntime` 一起在午夜清理、开盘重建、startupRebuildPending 恢复路径中统一停启。

**Tech Stack:** TypeScript, Bun test, Longbridge QuoteContext(WebSocket), 现有 `MarketDataClient` / `symbolRegistry` / `trader` / `postTradeConsistencyRuntime` / `orderRecorder` / `riskChecker` / `unrealizedLossMonitor` / lifecycle / app runtime 装配体系。

---

## 0. 方案范围与硬约束

### 本次必须完成的范围

1. `UNREALIZED_LOSS_CHECK` 从 `processMonitor -> scheduleRiskTasks -> monitorTaskQueue` 触发链路彻底迁出，改为 **交易标的 quote push 到达后直接执行浮亏检查**。
2. 主循环 `processMonitor` 不再承担任何交易标的浮亏检查触发职责。
3. 新增独立 `TradingRiskEventRuntime`，只处理 **交易标的浮亏事件**，不接管监控标的价格展示，不接管指标流水线。
4. 新架构为后续“监控标的展示/监控标的事件化重构”预留清晰扩展边界，但本次不提前实现该部分。

### 本次明确不改的范围

1. `marketMonitor.monitorPriceChanges(...)` 保持主循环侧调用，后续在更大范围重构中统一迁移。
2. `LIQUIDATION_DISTANCE_CHECK` 保持现状，继续由 `processMonitor -> scheduleRiskTasks -> monitorTaskQueue` 基于 **monitor price 变化** 触发；自动寻标门禁与现有业务口径不变。
3. `runIndicatorPipeline(...)`、`runSignalPipeline(...)`、监控标的 K 线采样与延迟验证时间轴保持现状。
4. `buyProcessor`、`sellProcessor`、`orderMonitorWorker`、`postTradeConsistencyRuntime` 的业务口径不变。
5. 订单成交后的刷新、保护性清仓事件完成判定、daily loss episode 推进、liquidation cooldown 推进保持现有闭环。
6. 不把整套 monitor processing 改成事件驱动；本次只重构“交易标的浮亏执行层”。

### fail-fast 约束

1. 不保留 `processMonitor` 侧旧风险触发入口作为兼容、回退或兜底。
2. 不允许“push 触发 + 主循环触发”双轨并存。
3. 不允许 `TradingRiskEventRuntime` 使用 `monitorContext` 或 `MonitorState` 作为事件归属真相源；席位真相源必须来自 `symbolRegistry` / `resolveMonitorContextSeatSnapshot(...)`。
4. 不允许在 baseline 未完成、生命周期门禁关闭、主循环交易时段门禁关闭，或末日保护收盘前 5 分钟清仓窗口已接管时继续执行交易标的浮亏检查。
5. 不允许为了兼容旧 handler 而继续保留 `UNREALIZED_LOSS_CHECK` monitor task 的生产触发路径。
6. 不允许把浮亏检查继续包装成“quote event -> monitorTaskQueue -> old handlers”；本次要求是 **quote event 到达后直接完成浮亏判断**。
7. 不允许为未来展示重构提前引入 monitorSymbol 事件路由逻辑；本次运行时只消费交易标的 quote 事件。
8. **明确禁止同一个 tradingSymbol 同时归属多个 monitor。** 若运行时重建路由时发现同 symbol 多 monitor 归属，视为非法状态并 fail-fast，禁止继续执行浮亏检查。
9. `TradingRiskEventRuntime` 不允许维护独立 price state；最终浮亏判断必须以当前 route 持有的 latest event payload 中的 trading quote 为准，`waitForFresh()` 只用于等待订单记录 / 持仓 / R1N1 等状态追平，不用于替换事件价格。
10. `LIQUIDATION_DISTANCE_CHECK` 不允许偷偷并入本次 runtime；它仍属于 monitor price 驱动链路。
11. quote push 事件接口必须遵守 admission 规则：未订阅 symbol 不发布、退订后不发布、reset 后按当前保留订阅状态生效。
12. 只有携带有效 trading price 的 quote push 才允许进入 `TradingRiskEventRuntime`；价格缺失或无效时只能丢弃，禁止补拉、补算或回退到其他价格源。

---

## 1. 设计总览

### 目标链路

```text
Longbridge realtime quote push
  -> quoteClient 标准化 quote-updated 事件（只发布 admitted 且带有效 trading price 的 symbol）
  -> TradingRiskEventRuntime
     -> 先做 runtime gate / baseline / lifecycle 检查
     -> 基于 symbolRegistry 权威 seat 快照重建 tradingSymbol 唯一路由
     -> 按 route single-flight 语义执行：
        1. freshness 前 seat 校验
        2. waitForFresh
        3. freshness 后再校验 gate + seat
        4. 读取当前 route 的 latest event quote
        5. 浮亏检查
     -> 若命中则直接构造 signal 并调用 trader.executeSignals(...)
  -> orderMonitor settlement
  -> postTradeConsistencyRuntime.recordSettlementRefreshNeed(...)
  -> postTradeConsistencyRuntime 刷新账户/持仓/R1N1
```

### 运行边界

#### 主循环保留职责

1. 交易日/交易时段判断与 lifecycle tick。
2. 行情订阅集合维护：`subscribeSymbols(...)` / `unsubscribeSymbols(...)`。
3. 监控标的 K 线缓存读取、指标快照推进、`indicatorCache` 时间轴维护。
4. 信号生成、延迟验证入队、买卖任务处理器调度。
5. `marketMonitor.monitorPriceChanges(...)` 与监控标的展示（本次暂不迁移）。

#### 主循环移除职责

1. `UNREALIZED_LOSS_CHECK` 的创建、入队、重试。
2. 因交易标的价格变化而触发的浮亏检查。

#### TradingRiskEventRuntime 职责

1. 订阅标准化 `quote-updated` 事件。
2. 仅处理 **交易标的** quote 事件，不处理 monitorSymbol 展示语义。
3. 每个事件到达前，基于 `symbolRegistry` 权威快照重建 `tradingSymbol -> { monitorSymbol, direction }` 唯一路由。
4. 命中路由后，直接完成交易标的浮亏检查，而不是先入 monitor task queue。
5. 对通过门禁、席位一致性、freshness 校验且持有有效 latest event quote 的命中事件，直接调用单方向 `unrealizedLossMonitor.monitorDirectionalUnrealizedLoss(...)`。
6. 不负责成交后刷新；该部分继续交给 `orderMonitor + postTradeConsistencyRuntime`。
7. 不维护 price state；只消费 quote push event payload。

#### lifecycle owner 约束

`TradingRiskEventRuntime` 必须进入 lifecycle `signalRuntimeDomain` 的 owner 顺序，与以下对象同域管理：

- `postTradeConsistencyRuntime`
- `buyProcessor`
- `sellProcessor`
- `monitorTaskProcessor`
- `orderMonitorWorker`

即：

- 午夜清理时：先 `postTradeConsistencyRuntime.abortWaiting()`，再 `tradingRiskEventRuntime.stopAndDrain()`，再排空其他处理器，最后 `postTradeConsistencyRuntime.stopAndDrain()`
- 开盘重建时：先 `postTradeConsistencyRuntime.resetAbort()`、`start()`、`completeRebuildBaseline()`，再 `tradingRiskEventRuntime.start()`，然后再恢复其他处理器

---

## 2. 关键架构决策

### 2.1 为什么这次必须改“执行层”而不是只改“触发层”

用户目标已经明确为：

- 所有行情事实来自 WS push
- 浮亏检查在 push 到达后直接执行
- 主循环不再参与交易标的浮亏检查

因此，如果仅把旧链路改成：

```text
quote push -> RiskEventRuntime -> monitorTaskQueue -> old handler
```

那仍然属于“事件触发任务”，不是“事件直接执行浮亏检查”，不符合本次目标。

本次方案因此明确要求：

- 交易标的浮亏检查的 **业务判断** 必须下沉到 `TradingRiskEventRuntime`
- 旧 `MonitorTaskProcessor` 中 `UNREALIZED_LOSS_CHECK` handler 的核心逻辑要被拆出复用或迁移
- 生产环境中不再使用 monitor task 执行浮亏检查

### 2.2 为什么仍保留 `trader.executeSignals(...)` 与 `postTradeConsistencyRuntime`

本次目标是把风险检查从主循环迁出，而不是重写整套交易、结算、一致性体系。

现有系统在下列方面已经具备稳定语义：

1. `trader.executeSignals(...)` 在 signal 已携带有效 `seatVersion` 时，会执行席位版本校验；因此新 runtime 在构造保护性清仓 signal 时，必须写入当前 route 的 `seatVersion`，执行层校验才会生效。
2. `orderMonitor` 统一消费订单终态事件并做唯一副作用结算。
3. `postTradeConsistencyRuntime` 统一执行账户/持仓刷新、保护性清仓事件完成判定、daily loss / cooldown 推进、R1/N1 刷新。

因此本次只替换：

- 风险检查的 **触发源**
- 风险检查的 **执行位置**

而不改：

- 风险命中后的下单/成交/刷新闭环

### 2.3 为什么运行时只处理交易标的事件，不处理 monitorSymbol 事件

你已经明确：

- 本次只做 1 / 2 / 4
- `marketMonitor.monitorPriceChanges(...)` 与后续监控标的相关展示，会在更大的重构里统一处理

因此本次运行时必须只处理交易标的 push，避免提前引入 monitorSymbol 事件职责，造成边界污染。

### 2.4 为什么路由真相源必须是 `symbolRegistry`

当前权威 seat 数据来源是：

- `symbolRegistry`
- `resolveMonitorContextSeatSnapshot(...)` (`src/utils/utils.ts:32`)

若直接使用 `monitorContext` 内部派生字段做路由，会在切席场景下出现：

1. seat 已切换
2. 新 quote 先到
3. `monitorContext` 还没经由主循环下一拍同步
4. 事件仍按旧 symbol 路由

这会让事件驱动方案残留对主循环 tick 的隐式依赖，违背本次目标。

### 2.5 为什么必须禁止同 symbol 多 monitor 归属

当前执行层 `trader.executeSignals(...)` 最终通过 `symbolRegistry.resolveSeatBySymbol(signal.symbol)` 反查 `monitorConfig` 与 `seatVersion`。该解析是**单一归属语义**，不是多 monitor fan-out 语义。

因此本次必须把“同一个 tradingSymbol 同时归属多个 monitor”定义为非法状态，而不是继续允许并在运行时 fan-out。否则：

- monitorConfig 归属会歧义
- dailyLoss / cooldown / protective episode 归属会歧义
- seatVersion 校验会落到错误的 monitor

### 2.6 为什么要在 runtime 内补 single-flight 并发收敛，而不是直接裸执行

旧 monitor task 链路虽然是主循环触发，但至少具备：

- `scheduleLatest(...)` 的 latest-only 去重
- retry registry 的单类重试收敛

本次删掉 monitor task 后，必须在 runtime 内补回新的并发语义，否则 burst quote 下会出现：

- 同一 route 多次并发进入 `waitForFresh()`
- freshness 恢复后同时提交多个清仓 signal
- 重复 `clearBuyOrders(...)`
- 重复刷新浮亏数据

**新并发模型：**

- route key = `${monitorSymbol}:${direction}`
- 每个 route key 在同一时刻最多只有一个 in-flight 执行
- 若执行期间又收到新的 quote push：
  - 不新开第二个执行
  - 只把该 route 标记为 `dirty`
  - 保存该 route 最新一次事件所需的 latest payload
- 当前执行结束后：
  - 若 `dirty === true`，立即用 latest payload 再执行一次
  - 仅重放一次，形成 latest-only collapse

这套语义必须写进 runtime 设计与测试，不可留给实现时自由发挥。

### 2.7 为什么 `LIQUIDATION_DISTANCE_CHECK` 必须留在本次范围外

旧 `checkWarrantDistanceLiquidation(...)` 的事实源是 `monitorPrice`，而不是 tradingSymbol 自身价格变化；同时该链路还受“自动寻标关闭才运行静态距回收价清仓”这一业务门禁约束。

因此本次若把它一起并入 trading quote push runtime，会把：

- monitor price 事实源
- 自动寻标门禁
- 静态标的距回收价清仓语义

一起改写掉。

本次方案必须明确：

- `LIQUIDATION_DISTANCE_CHECK` 保持现有 monitor price 驱动链路
- `TradingRiskEventRuntime` 只承接 `UNREALIZED_LOSS_CHECK`
- 若未来要事件化距回收价检查，必须以 monitorSymbol 事实源为起点单独立项

### 2.8 为什么 runtime gate 不能只看 `lastState.isTradingEnabled`

当前主循环真正放行业务，不只依赖 lifecycle 门禁，还依赖：

- `lastState.canTrade === true` 对应的连续交易时段门禁
- 严格模式下的交易日/交易时段判断
- 末日保护收盘前 5 分钟清仓窗口的接管语义

因此本次方案必须明确：

- `TradingRiskEventRuntime` 不得只看 `lastState.isTradingEnabled`
- 本次最小 gate 明确复用已维护的门禁事实：`lastState.isTradingEnabled === true && lastState.canTrade === true`
- 由于该门禁事实由主循环每 tick 更新，连续交易时段边界、跨日切换与 open rebuild 边界最多允许存在 **1 个主循环 tick** 的可见延后；这是本次方案接受的时序取舍，不额外为 runtime 引入独立交易时段计算逻辑
- 若启用末日保护且当前处于收盘前 5 分钟自动清仓窗口，runtime 必须完全静止，由 doomsday path 独占卖出控制权

### 2.9 为什么最终浮亏判断必须以事件自带 quote 为主

这次重构的核心目标不是“把旧 handler 挪个位置”，而是把交易标的浮亏检查改成由 WS quote push 直接驱动。

因此本次方案必须保持：

- event quote 不是辅助信息，而是本次风险事实本身
- `waitForFresh()` 的职责只是等待订单记录 / 持仓 / R1N1 等状态追平，避免用旧状态判断新事件
- `waitForFresh()` 之后仍使用当前 route 收敛后的 latest event quote 做最终浮亏判断
- 若 latest event quote 缺失或价格无效，本轮直接跳过，不额外回退到拉取 execution quote

### 2.10 为什么 quote 事件必须先满足“有效价格”才能进入执行层

本次方案虽然改成“WS push 直驱”，但这不等于“任何 push 都进入风险执行”。真正进入 `TradingRiskEventRuntime` 的事件必须已经满足：

- symbol 已 admitted
- 事件可解析出有效 trading price

因此本次方案必须写死：

- `quoteClient` 负责把原始 SDK push 标准化为 `QuoteUpdatedEvent`
- 只有当 push 内能解析出有效 trading price 时，才发布 `QuoteUpdatedEvent`
- runtime 在执行前仍要对当前 route 的 latest event quote 做一次价格有效性再校验
- 若价格缺失或无效：直接跳过；禁止补拉 `getQuotes(...)`、禁止读取 `MonitorState`、禁止本地缓存补价

### 2.11 为什么不能继续复用旧的双方向浮亏接口

当前 `unrealizedLossMonitor.monitorUnrealizedLoss(...)` 是双方向上下文接口，一次会同时消费 `longQuote` 与 `shortQuote`。

但本次 runtime 的执行单位已经变成：

- 单个 route
- 单个方向
- 单个 latest event quote

因此本次必须直接更新浮亏监控接口，而不是继续复用旧双方向接口。正确方向是：

- `unrealizedLossMonitor` 暴露单方向接口，例如 `monitorDirectionalUnrealizedLoss(...)`
- 接口入参只允许包含当前命中 direction 的 symbol / quote / isLong / monitorSymbol
- 不允许在 runtime 内构造“另一侧 quote = 旧缓存 / 旧状态 / SDK 拉取结果”的双方向上下文

这样才能保证：

- 单次事件只检查单次事件命中的那个方向
- 事件价格仍然是唯一价格真相源
- 不会因为双方向接口语义过宽而把另一侧旧价偷偷带回执行链

### 2.12 为什么 startupRebuildPending 路径不能写成“不进入主循环”

当前系统在 `startupRebuildPending === true` 时，**仍会进入主循环**，但因为 `lastState.isTradingEnabled === false`，主循环只驱动 lifecycle tick，不放行业务执行。

因此本次方案必须明确：

- `startupRebuildPending` 下 **主循环继续运行**
- 但 `TradingRiskEventRuntime` 保持静止
- 后续由 lifecycle open rebuild 路径负责启动 `postTradeConsistencyRuntime`、完成 baseline、启动 `TradingRiskEventRuntime`

---

## 3. 目标数据流与状态机

### 3.1 交易标的事件路由模型

对于每个 monitor，需要维护两条潜在交易标的路由：

- `longSymbol -> { monitorSymbol, direction: 'LONG' }`
- `shortSymbol -> { monitorSymbol, direction: 'SHORT' }`

约束：

1. 只有 seat 处于 ACTIVE 且 symbol 非空时，才建立交易标的路由。
2. 同一 tradingSymbol 不允许映射到多个 monitor；发现即 fail-fast。
3. 事件路由只负责找出“该 tradingSymbol 当前归属哪个 monitor/direction”，不在路由层做风险判断。

### 3.2 单个 quote push 的执行序列

```text
收到 quote-updated(symbol=S)
  -> 判断 runtime 是否 started
  -> 判断 lastState.isTradingEnabled === true
  -> 判断 lastState.canTrade === true
  -> 若启用末日保护且当前处于收盘前 5 分钟清仓窗口：返回
  -> 判断 baselineReady === true
  -> 重建 tradingSymbol 唯一路由索引
  -> 查找 S 对应 route
  -> 若无 route：返回
  -> 进入 route key single-flight
       a. freshness 前 seat 校验
       b. waitForFresh()
       c. freshness 后再次校验 gate + seat
       d. 读取当前 route 收敛后的 latest event quote
       e. 若 event quote 缺失或价格无效：跳过
       f. 执行浮亏检查
       g. 结束；若 dirty 则以 latest payload 再跑一轮
```

### 3.3 baselineReady 语义

本次不新增新的 baseline 状态字段，直接绑定现有语义：

- `postTradeConsistencyRuntime.getStatus().started === true`
- 且 `currentVersion === staleVersion`

只有同时满足这两个条件，才允许 `TradingRiskEventRuntime` 执行浮亏检查。

### 3.4 与 postTradeConsistencyRuntime 的关系

风险事件运行时不负责成交后刷新，只依赖它提供三个语义：

1. `waitForFresh()`：避免在成交后一致性未恢复时，用过期的订单记录 / positionCache / R1N1 数据去判断当前事件价格对应的浮亏。
2. `getStatus()`：用于 baseline 门禁判断。
3. `abortWaiting()` / `resetAbort()`：由 lifecycle 在午夜清理 / 开盘重建期间统一控制 freshness waiter 的中断与恢复。

因此风险事件运行时必须遵守：

- **先等 fresh，再做最终 gate/seat 校验，再读取 latest event quote，再执行浮亏检查**
- `stopAndDrain()` 期间必须等待 route in-flight 执行收敛；若中途 `waitForFresh()` 被 abort，则本轮安全退出

---

## 4. 文件结构与职责分配

### 新增文件

- `src/main/tradingRiskEventRuntime/index.ts`
  - 创建并管理交易标的风险事件运行时
  - 负责订阅 quote 更新事件、start/stopAndDrain、事件门禁、每事件路由重建与 route single-flight 调度

- `src/main/tradingRiskEventRuntime/types.ts`
  - 交易标的风险事件运行时类型、route key、single-flight 状态、事件处理依赖

- `src/main/tradingRiskEventRuntime/tradingSymbolRoutingIndex.ts`
  - 基于 `symbolRegistry` 权威快照构建 `tradingSymbol -> { monitorSymbol, direction }` 唯一路由索引
  - 若发现一 symbol 多 monitor 归属，直接抛错 fail-fast

- `src/main/tradingRiskEventRuntime/routeValidation.ts`
  - route 命中后的 gate/seat/freshness 双校验工具

- `src/main/tradingRiskEventRuntime/unrealizedLossExecutor.ts`
  - 交易标的 quote 触发后的浮亏检查执行器

- `src/main/tradingRiskEventRuntime/buildRiskExecutionContext.ts`
  - 组装单个 route 执行所需上下文：monitorContext、seatSnapshot、latest event quote 等

### 修改文件

- `src/types/services.ts`
  - 为 `MarketDataClient` 增加标准化 quote 事件订阅接口 `onQuoteUpdated(...)`
  - 增加 `QuoteUpdatedEvent` 类型

- `src/types/risk.ts`
  - 将 `UnrealizedLossMonitor` 更新为单方向风险执行接口
  - 删除旧双方向 `UnrealizedLossMonitorContext`，改为单方向上下文类型

- `src/services/quoteClient/types.ts`
  - 为 `QuoteContextLike` 增加 `setOnQuote(...)` 的最小契约
  - 增加 quote push 事件的最小结构类型

- `src/services/quoteClient/index.ts`
  - 接入 SDK `setOnQuote(...)`
  - 发布标准化 `QuoteUpdatedEvent`
  - 增加 admission 规则：仅对 admitted 且带有效 trading price 的 symbol 发布事件

- `src/core/riskController/unrealizedLossMonitor.ts`
  - 将浮亏监控器实现改为单方向接口
  - 移除旧双方向入口，避免 runtime 误用宽接口语义

- `src/app/types.ts`
  - 扩展 post-gate runtime / cleanup context，纳入 `TradingRiskEventRuntime`
  - 为 lifecycle signal runtime owner 扩展依赖边界

- `src/app/runtime/createPostGateRuntime.ts`
  - 创建 `TradingRiskEventRuntime` 并挂入 post-gate runtime

- `src/app/runApp.ts`
  - 在初次基线完成后启动 `TradingRiskEventRuntime`
  - `startupRebuildPending` 时保持静止，但主循环继续运行等待 lifecycle 恢复

- `src/app/createCleanup.ts`
  - 退出时停止 `TradingRiskEventRuntime`
  - 停止顺序必须早于 `postTradeConsistencyRuntime.stopAndDrain()`

- `src/app/createLifecycleRuntime.ts`
  - 将 `TradingRiskEventRuntime` 纳入 `createSignalRuntimeDomain(...)` 依赖装配

- `src/main/lifecycle/cacheDomains/types.ts`
  - 为 signal runtime domain 增加 `TradingRiskEventRuntime` owner 契约

- `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
  - 午夜清理：增加 `tradingRiskEventRuntime.stopAndDrain()`
  - 开盘重建：在 `postTradeConsistencyRuntime.completeRebuildBaseline()` 后增加 `tradingRiskEventRuntime.start()`

- `src/main/processMonitor/index.ts`
  - 调整 `scheduleRiskTasks(...)`，仅保留展示与 `LIQUIDATION_DISTANCE_CHECK` 调度职责

- `src/main/processMonitor/riskTasks.ts`
  - 删除 `UNREALIZED_LOSS_CHECK` 调度职责，保留展示与 `LIQUIDATION_DISTANCE_CHECK` 调度

- `src/main/asyncProgram/monitorTaskProcessor/index.ts`
  - 删除 `UNREALIZED_LOSS_CHECK` 处理器装配

- `src/main/asyncProgram/monitorTaskProcessor/types.ts`
  - 删除 `UNREALIZED_LOSS_CHECK` task data 与类型映射

- `src/main/processMonitor/types.ts`
  - 按需收窄 `RiskTasksParams` 注释与语义，移除 `UNREALIZED_LOSS_CHECK` 相关描述

- `tests/helpers/testDoubles.ts`
  - 补 `MarketDataClient.onQuoteUpdated(...)` 测试替身

- `tests/app/utils.ts`
  - 补 post-gate runtime / cleanup / quote 事件替身能力

- `tests/app/createLifecycleRuntime.wiring.test.ts`
  - 覆盖 signalRuntimeDomain 对 `TradingRiskEventRuntime` 的装配顺序

### 原则上复用、少改或不改的文件

- `src/core/riskController/index.ts`
- `src/core/trader/orderExecutor/index.ts`
- `src/app/runtime/createPostTradeConsistencyRuntime.ts`
- `src/core/trader/orderMonitor/*`

---

## 5. 旧链路拆解与新链路映射

### 5.1 旧浮亏检查链路

```text
mainProgram
  -> processMonitor
  -> scheduleRiskTasks
  -> monitorTaskQueue.scheduleLatest(UNREALIZED_LOSS_CHECK)
  -> monitorTaskProcessor
  -> handlers/unrealizedLoss.ts
  -> context.unrealizedLossMonitor.monitorUnrealizedLoss(...)
```

### 5.2 新浮亏检查链路

```text
quote WS push(tradingSymbol)
  -> quoteClient.onQuoteUpdated
  -> TradingRiskEventRuntime(single-flight by route)
  -> route match + gate/seat/freshness validation
  -> unrealizedLossExecutor.execute(...)
  -> unrealizedLossMonitor.monitorDirectionalUnrealizedLoss(...)
```

### 5.3 距回收价检查链路保持现状

```text
mainProgram
  -> processMonitor
  -> scheduleRiskTasks
  -> monitorTaskQueue.scheduleLatest(LIQUIDATION_DISTANCE_CHECK)
  -> monitorTaskProcessor
  -> handlers/liquidationDistance.ts
  -> createLiquidationTask / executeReadyLiquidationTasks
```

本次不改这条链路。

### 5.4 monitorTaskProcessor 收缩后的职责

重构后 monitor task 仅保留：

- `AUTO_SYMBOL_TICK`
- `AUTO_SYMBOL_SWITCH_DISTANCE`
- `SEAT_REFRESH`
- `LIQUIDATION_DISTANCE_CHECK`

不再承担：

- `UNREALIZED_LOSS_CHECK`

---

## 6. 实现任务拆分

### Task 1: 为 MarketDataClient 增加 quote push 标准化事件接口与 admission 规则

**Files:**

- Modify: `src/types/services.ts`
- Modify: `src/services/quoteClient/types.ts`
- Modify: `src/services/quoteClient/index.ts`
- Modify: `tests/helpers/testDoubles.ts`
- Modify: `tests/app/utils.ts`
- Test: `tests/services/quoteClient/business.test.ts`

- [ ] **Step 1: 写失败测试，定义 quote-updated 事件契约与 admission 规则**

测试必须覆盖：

1. 已订阅 symbol push -> 发布事件
2. 未订阅 symbol push -> 不发布事件
3. 退订后 push -> 不再发布事件
4. `resetRuntimeSubscriptionsAndCaches()` 后 -> 按当前保留订阅状态决定是否发布
5. push 不携带有效 trading price -> 不发布事件

- [ ] **Step 2: 跑测试确认当前失败**

Run: `bun test tests/services/quoteClient/business.test.ts`

Expected: FAIL。

- [ ] **Step 3: 在 `src/types/services.ts` 增加标准化事件类型与订阅接口**

- [ ] **Step 4: 在 `src/services/quoteClient/types.ts` 补 `setOnQuote(...)` 最小契约**

- [ ] **Step 5: 先修公共测试替身**

在 `tests/helpers/testDoubles.ts` 与 `tests/app/utils.ts` 中补 `onQuoteUpdated: () => () => {}`。

- [ ] **Step 6: 在 `src/services/quoteClient/index.ts` 接入 quote push 事件发布**

实现要求：

1. 使用 SDK `setOnQuote(...)` 接口接收 push。
2. 仅对 `subscribedSymbols` 内 admitted 且带有效 trading price 的 symbol 发布事件。
3. 退订后不再发布。
4. `resetRuntimeSubscriptionsAndCaches()` 后，事件 admission 与当前缓存/订阅状态保持一致。
5. 事件只发布事实，不注入 risk / monitor 业务语义。
6. 若原始 push 无法解析出有效 trading price，则直接丢弃，不生成 `QuoteUpdatedEvent`。

- [ ] **Step 7: 跑相关测试确认通过**

- [ ] **Step 8: 提交一次原子 commit**

---

### Task 2: 建立 TradingRiskEventRuntime 骨架，补齐 start/stopAndDrain 与 baseline 门禁

**Files:**

- Create: `src/main/tradingRiskEventRuntime/types.ts`
- Create: `src/main/tradingRiskEventRuntime/index.ts`
- Test: `tests/main/tradingRiskEventRuntime/index.test.ts`

- [ ] **Step 1: 写失败测试，定义 start/stopAndDrain 与门禁语义**

必须覆盖：

1. `start()` 订阅 quote 事件
2. `stopAndDrain()` 取消订阅并等待 in-flight 结束
3. `lastState.isTradingEnabled === false` 时忽略事件
4. `lastState.canTrade !== true` 时忽略事件
5. 启用末日保护且处于收盘前 5 分钟清仓窗口时忽略事件
6. baseline 未完成时忽略事件
7. `startupRebuildPending` 路径中主循环继续，但 runtime 保持静止

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 定义运行时公开契约**

推荐定义为：

```ts
export interface TradingRiskEventRuntime {
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
}
```

不定义单独 `stop()`，避免与 lifecycle owner 的排空语义分裂。

- [ ] **Step 4: 定义 baselineReady 判定**

直接绑定：

```ts
const status = postTradeConsistencyRuntime.getStatus();
const baselineReady = status.started && status.currentVersion === status.staleVersion;
```

同时 gate 必须至少满足：

```ts
const runtimeGateOpen =
  lastState.isTradingEnabled === true &&
  lastState.canTrade === true &&
  !(
    tradingConfig.global.doomsdayProtection &&
    isBeforeClose5Minutes(now, lastState.isHalfDay ?? false)
  );
```

- [ ] **Step 5: 实现最小运行时骨架**

- [ ] **Step 6: 跑测试确认通过**

- [ ] **Step 7: 提交一次原子 commit**

---

### Task 3: 建立交易标的唯一路由索引，并将同 symbol 多 monitor 归属视为非法状态

**Files:**

- Create: `src/main/tradingRiskEventRuntime/tradingSymbolRoutingIndex.ts`
- Modify: `src/main/tradingRiskEventRuntime/types.ts`
- Test: `tests/main/tradingRiskEventRuntime/tradingSymbolRoutingIndex.test.ts`

- [ ] **Step 1: 写失败测试，定义 routing invariant**

测试必须覆盖：

1. ACTIVE long/short seat 建立唯一路由
2. 非 ACTIVE / 空 symbol 不建立路由
3. seat 切换后重建索引立即生效
4. 若同 symbol 同时归属多个 monitor -> 直接抛错 fail-fast

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现索引模块**

输入必须是：

- monitorSymbol 列表
- `resolveMonitorContextSeatSnapshot(monitorSymbol, symbolRegistry)`

输出：

```ts
tradingSymbol -> { monitorSymbol: string; direction: 'LONG' | 'SHORT' }
```

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交一次原子 commit**

---

### Task 4: 抽出 routeValidation，上下文中禁止引入独立 price state

**Files:**

- Create: `src/main/tradingRiskEventRuntime/routeValidation.ts`
- Create: `src/main/tradingRiskEventRuntime/buildRiskExecutionContext.ts`
- Test: `tests/main/tradingRiskEventRuntime/routeValidation.test.ts`

- [ ] **Step 1: 写失败测试，锁定 freshness 前后双校验与 gate 再校验语义**

必须覆盖：

1. freshness 前有效、freshness 后仍有效 -> 通过
2. freshness 前有效、freshness 后 seat 失效 -> 跳过
3. freshness 前通过、freshness 后 gate 关闭 -> 跳过
4. `waitForFresh()` 被 abort -> 本轮安全退出
5. 启用末日保护且处于收盘前 5 分钟清仓窗口 -> 跳过

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 上下文组装中明确 price 真相源**

上下文只允许包含：

- route 对应 `monitorContext`
- 当前 seat snapshot
- 当前事件 quote

不得读取：

- `MonitorState.longPrice/shortPrice`
- runtime 自己维护的 price cache

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交一次原子 commit**

---

### Task 5: 在 runtime 内补 route single-flight / latest-only collapse 并发语义

**Files:**

- Modify: `src/main/tradingRiskEventRuntime/index.ts`
- Modify: `src/main/tradingRiskEventRuntime/types.ts`
- Test: `tests/main/tradingRiskEventRuntime/index.test.ts`

- [ ] **Step 1: 写失败测试，锁定并发收敛语义**

必须覆盖：

1. 同一 route burst push 只允许一个 in-flight
2. in-flight 期间新 push 到达 -> 只标记 dirty
3. 当前执行结束后，若 dirty -> 用 latest payload 只补跑一次
4. 不同 route 可独立并发

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 在 runtime 中实现 route key single-flight**

route key = `${monitorSymbol}:${direction}`

状态至少包括：

- `running`
- `dirty`
- `latestPayload`

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交一次原子 commit**

---

### Task 6: 直接执行浮亏检查，不再经由 monitorTaskQueue

**Files:**

- Create: `src/main/tradingRiskEventRuntime/unrealizedLossExecutor.ts`
- Modify: `src/main/tradingRiskEventRuntime/index.ts`
- Modify: `src/types/risk.ts`
- Modify: `src/core/riskController/unrealizedLossMonitor.ts`
- Test: `tests/main/tradingRiskEventRuntime/unrealizedLossExecutor.test.ts`

- [ ] **Step 1: 写失败测试，锁定 tradingSymbol push -> 直接浮亏检查**

必须覆盖：

1. latest event quote 直接作为最终浮亏判定价
2. `waitForFresh()` 只负责等待订单记录 / 持仓 / R1N1 状态追平，不替换事件价格
3. latest event quote 缺失或价格无效时直接跳过，不额外拉取 execution quote
4. 单次 route 执行只检查当前命中 direction，不构造另一侧 quote 上下文
5. runtime 构造的保护性清仓 signal 必须携带当前 route 的 `seatVersion`
6. 若最终 gate/seat 校验通过后、提交执行前发生极窄窗口的席位版本变化，signal 仍会在执行层因版本不匹配被丢弃

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 直接更新 `unrealizedLossMonitor` 接口为单方向执行器，并保持“latest event quote 判定”语义**

实现要求：

1. runtime 只调用单方向接口，例如 `monitorDirectionalUnrealizedLoss(...)`
2. 单方向接口只接收当前命中 direction 的 symbol / quote / isLong / monitorSymbol
3. 禁止为了复用旧接口而拼装另一侧 quote
4. 禁止从 `MonitorState`、展示态或其他缓存补另一侧价格
5. 构造保护性清仓 signal 时，必须写入当前命中 route 的 `seatVersion`
6. `seatVersion` 透传属于 signal 执行不变量的一部分，不是兼容桥接或兜底逻辑；禁止依赖执行层自动推断或补齐

- [ ] **Step 4: 接入 runtime**

- [ ] **Step 5: 跑测试确认通过**

- [ ] **Step 6: 提交一次原子 commit**

---

### Task 7: 距回收价检查保持现状，不纳入本次 TradingRiskEventRuntime

**说明：**

- `LIQUIDATION_DISTANCE_CHECK` 继续保留在 `processMonitor -> scheduleRiskTasks -> monitorTaskQueue` 现有链路
- 本次不创建 `liquidationDistanceExecutor`
- 本次不改其自动寻标门禁、monitor price 事实源与执行语义

---

### Task 8: 从主循环与 monitorTaskProcessor 中彻底移除旧风险链路

**Files:**

- Modify: `src/main/processMonitor/index.ts`
- Modify: `src/main/processMonitor/riskTasks.ts`
- Modify: `src/main/processMonitor/types.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/types.ts`
- Modify: `tests/main/processMonitor/riskTasks.business.test.ts`
- Modify: `tests/main/processMonitor/index.business.test.ts`
- Modify: `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`

- [ ] **Step 1: 写失败测试，确认主循环不再调度 `UNREALIZED_LOSS_CHECK`**

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 调整 `processMonitor` 中的 `scheduleRiskTasks(...)` 调用，只保留展示与 `LIQUIDATION_DISTANCE_CHECK`**

- [ ] **Step 4: 删除 monitorTaskProcessor 中的 `UNREALIZED_LOSS_CHECK` handler 装配**

- [ ] **Step 5: 删除 monitor task 类型中的 `UNREALIZED_LOSS_CHECK`**

- [ ] **Step 6: 清理旧 riskTasks 模块中的浮亏调度残留**

- [ ] **Step 7: 跑相关测试确认通过**

- [ ] **Step 8: 提交一次原子 commit**

---

### Task 9: 将 TradingRiskEventRuntime 接入 lifecycle owner 与 app 装配层

**Files:**

- Modify: `src/app/types.ts`
- Modify: `src/app/runtime/createPostGateRuntime.ts`
- Modify: `src/app/runApp.ts`
- Modify: `src/app/createCleanup.ts`
- Modify: `src/app/createLifecycleRuntime.ts`
- Modify: `src/main/lifecycle/cacheDomains/types.ts`
- Modify: `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
- Test: `tests/app/runApp.test.ts`
- Test: `tests/app/createCleanup.business.test.ts`
- Test: `tests/app/createLifecycleRuntime.wiring.test.ts`

- [ ] **Step 1: 写失败测试，锁定初次启动与 lifecycle open rebuild 的同构顺序**

正常路径必须是：

1. `rebuildTradingDayState`
2. `postTradeConsistencyRuntime.start`
3. `postTradeConsistencyRuntime.completeRebuildBaseline`
4. `tradingRiskEventRuntime.start`
5. 其他处理器启动

open rebuild 也必须遵守同样顺序。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 在 post-gate runtime 中创建并挂入 `TradingRiskEventRuntime`**

- [ ] **Step 4: 在 `createSignalRuntimeDomain(...)` 中纳入该 owner**

午夜清理顺序：

1. `postTradeConsistencyRuntime.abortWaiting()`
2. `tradingRiskEventRuntime.stopAndDrain()`
3. 其他处理器 stopAndDrain
4. `postTradeConsistencyRuntime.stopAndDrain()`

开盘重建顺序：

1. `postTradeConsistencyRuntime.resetAbort()`
2. `postTradeConsistencyRuntime.start()`
3. `postTradeConsistencyRuntime.completeRebuildBaseline()`
4. `tradingRiskEventRuntime.start()`
5. 其他处理器 restart/start

- [ ] **Step 5: 修正 `startupRebuildPending` 语义测试**

应断言：

- 主循环仍运行以驱动 lifecycle tick
- `TradingRiskEventRuntime` 初始不启动
- 后续由 lifecycle open rebuild 启动它

- [ ] **Step 6: 在 cleanup 中停止该 runtime**

要求：

1. cleanup 顺序必须与 signal runtime owner 顺序一致：
   - `postTradeConsistencyRuntime.abortWaiting()`
   - `tradingRiskEventRuntime.stopAndDrain()`
   - `buyProcessor.stopAndDrain()`
   - `sellProcessor.stopAndDrain()`
   - `monitorTaskProcessor.stopAndDrain()`
   - `orderMonitorWorker.stopAndDrain()`
   - `postTradeConsistencyRuntime.stopAndDrain()`
   - `marketDataClient.resetRuntimeSubscriptionsAndCaches()`
2. `TradingRiskEventRuntime.stopAndDrain()` 必须早于其他处理器与 `postTradeConsistencyRuntime.stopAndDrain()`，避免 cleanup 期间继续消费 quote push
3. 补 cleanup 测试，断言 `abortWaiting` 之后先停止 `TradingRiskEventRuntime`，其后才允许排空其他处理器

- [ ] **Step 7: 跑装配测试确认通过**

- [ ] **Step 8: 提交一次原子 commit**

---

### Task 10: 补齐 seat 切换、生命周期门禁、startupRebuildPending 与非法归属回归

**Files:**

- Modify: `tests/main/tradingRiskEventRuntime/index.test.ts`
- Modify: `tests/app/runApp.test.ts`

- [ ] **Step 1: 写失败测试，覆盖关键尖锐场景**

必须覆盖：

1. `oldSymbol` 在切席后 push -> 不再触发旧 route 风险检查
2. `newSymbol` 在切席后 push -> 无需等待下一次主循环 tick，立即触发新 route 风险检查
3. `lastState.isTradingEnabled === false` 时，push 到达也完全静止
4. `startupRebuildPending` 期间 runtime 静止，但 lifecycle open rebuild 后启动
5. 一 symbol 多 monitor 归属 -> fail-fast

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 在 runtime 中坚持“每个事件前重建 trading 路由”**

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交一次原子 commit**

---

### Task 11: 全链路回归测试与静态检查

**Files:**

- Test: `tests/services/quoteClient/business.test.ts`
- Test: `tests/main/tradingRiskEventRuntime/*.test.ts`
- Test: `tests/main/processMonitor/index.business.test.ts`
- Test: `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`
- Test: `tests/app/runApp.test.ts`
- Test: `tests/app/createCleanup.business.test.ts`
- Test: `tests/app/createLifecycleRuntime.wiring.test.ts`

- [ ] **Step 1: 跑 trading risk runtime 测试集**

- [ ] **Step 2: 跑关键回归测试**

- [ ] **Step 3: 跑完整静态检查**

- [ ] **Step 4: grep 验证旧入口已消失**

Run:

```bash
grep -R "scheduleRiskTasks" src tests
grep -R "UNREALIZED_LOSS_CHECK" src tests
grep -R "LIQUIDATION_DISTANCE_CHECK" src tests
```

Expected:

1. `processMonitor` 不再调度 `UNREALIZED_LOSS_CHECK`
2. 生产代码中不再存在 `UNREALIZED_LOSS_CHECK` 的 monitor task 生产触发路径
3. `LIQUIDATION_DISTANCE_CHECK` 仍只保留在既有 monitor price 链路
4. 若测试中仍保留旧字样，只能用于“已删除/不再触发”的断言，不得存在生产链路

- [ ] **Step 5: 提交最终集成 commit**

---

## 7. 关键执行顺序与业务细节说明

### 7.1 单 route 的执行顺序

固定顺序：

1. route 命中
2. freshness 前 seat 校验
3. `postTradeConsistencyRuntime.waitForFresh()`
4. freshness 后再校验 `gate + seat`
5. 读取当前 route 收敛后的 latest event quote
6. latest event quote 有效时执行浮亏检查

### 7.2 为什么不在 quote push 层做重试

旧 `UNREALIZED_LOSS_CHECK` handler 存在 retry，是因为旧架构下风险执行和行情事实解耦，任务入队后还要等待执行窗口与状态追平。

本次新方案里：

- 事件本身已经携带 trading quote，可作为触发事实
- 最终判定价就是当前 route 收敛后的 latest event quote
- 若关键数据缺失，则本次直接跳过
- 等下一次相关 trading quote push 再重新触发

这不是兜底，而是新的事实源驱动模型。

### 7.3 为什么 runtime 不允许维护独立 price state

当前 `MonitorState` 属于展示与主循环流水线的状态；若本次再让 `TradingRiskEventRuntime` 维护一份自己的价格状态，就会产生状态分裂。

因此本次明确：

- runtime 不持有 longPrice / shortPrice / monitorPrice 状态
- 只读取事件 payload，不额外维护或拉取另一份判定价格
- 展示状态仍由主循环维护

### 7.4 startupRebuildPending 的正确语义

当前系统在 `startupRebuildPending` 下仍会进入主循环，但业务门禁关闭，只等待 lifecycle 恢复。

因此本次必须保持：

- 主循环继续运行
- `TradingRiskEventRuntime` 初始静止
- lifecycle open rebuild 成功后再启动它

---

## 8. 验收标准

完成后必须同时满足：

1. `processMonitor` 不再调用任何交易标的浮亏调度入口。
2. `UNREALIZED_LOSS_CHECK` 不再作为 monitor task 生产触发。
3. 交易标的浮亏检查仅由 **tradingSymbol quote push** 直接驱动执行。
4. `LIQUIDATION_DISTANCE_CHECK` 保持现有 monitor price 驱动链路，不被错误并入本次 runtime。
5. `quoteClient` 仅发布 admitted symbol 的标准化 quote 事件，不知道 risk / monitor 业务。
6. `QuoteUpdatedEvent` 只会在 push 可解析出有效 trading price 时发布；无效价格事件不会进入 runtime。
7. `TradingRiskEventRuntime` 基于 `symbolRegistry` 权威快照路由，而不是 `monitorContext` 或 `MonitorState` 派生状态。
8. 同一个 tradingSymbol 不允许归属多个 monitor；发现即 fail-fast。
9. runtime gate 明确复用 `lastState.isTradingEnabled === true && lastState.canTrade === true`；允许相对主循环在交易时段边界最多延后 1 个主循环 tick 收口，并在末日保护收盘前 5 分钟清仓窗口内完全静止。
10. baseline 未完成时，运行时不会执行任何交易标的浮亏检查。
11. 浮亏判断以当前 route 收敛后的 latest event quote 为准；`waitForFresh()` 只负责等待状态追平，不替换事件价格。
12. 保护性清仓 signal 已携带当前 route 的 `seatVersion`；runtime 自身校验与执行层版本校验共同保证旧席位 signal 不会在切席后继续提交。
13. `unrealizedLossMonitor` 已更新为单方向接口；runtime 不再复用旧双方向浮亏接口，也不会构造另一侧 quote 上下文。
14. `TradingRiskEventRuntime` 已纳入 lifecycle signal runtime owner 顺序，午夜清理、开盘重建、startupRebuildPending 恢复路径均正确停启。
15. cleanup 按 owner 顺序停止 `TradingRiskEventRuntime`，退出期间不再继续接收并执行风险事件。
16. runtime 内已实现 route single-flight / latest-only collapse，不会因 burst quote 引入重复风险执行。
17. 无双轨、无兜底、无兼容桥接残留。
18. `bun run type-check`、`bun run lint`、`bun run test` 全通过。

---

## 9. 执行建议

这次最容易犯错的点有十个：

1. 只把风险“触发层”事件化，仍保留 queue + old handlers。
2. 用 `monitorContext` / `MonitorState` 做路由或价格真相源。
3. runtime gate 只看 `lastState.isTradingEnabled`，漏掉连续交易时段或末日保护接管窗口。
4. `TradingRiskEventRuntime` 未纳入 lifecycle owner，导致日切/重建断链。
5. 把本应保留在 monitor price 链路上的 `LIQUIDATION_DISTANCE_CHECK` 错误并入 tradingSymbol runtime。
6. 在 `waitForFresh()` 之后错误地丢掉 current route 的 latest event quote，改用另一套拉取价格覆盖事件事实。
7. 未补 single-flight，并在 burst quote 下出现重复清仓。
8. `startupRebuildPending` 被错误理解成“不进入主循环”。
9. 未把“一 symbol 多 monitor”定义为非法状态并 fail-fast。
10. quote 事件接口未定义 admission 与有效价格规则，导致无效价格事件也进入风险运行时。

因此必须坚持执行顺序：

1. 先加 quote 事件接口并补 admission 测试。
2. 再建带 `stopAndDrain` 与 baseline 门禁的 runtime 骨架。
3. 再建唯一路由索引，并写死同 symbol 多 monitor 非法。
4. 再做 freshness-aware route validation 与无 price state 约束。
5. 再补 route single-flight 并发收敛。
6. 再接浮亏执行器。
7. 再删除主循环与 monitorTaskProcessor 的旧浮亏链路。
8. 最后才把 runtime 接入 lifecycle owner 与 app 装配层，并跑全链路回归。
