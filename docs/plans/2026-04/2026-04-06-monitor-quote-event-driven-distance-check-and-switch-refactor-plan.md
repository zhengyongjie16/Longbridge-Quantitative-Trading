# 监控标的 WS 直驱化重构二次复核方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将“静态标的距回收价检查”和“距离换标检查”从 `mainProgram -> processMonitor` 的主循环轮询触发链路中彻底迁出，改为由监控标的 quote WebSocket push 直接驱动；主循环不再承担这两条链路的业务检查职责，只保留现有缓存读取与展示职责。

**Architecture:** 保留现有主循环、K 线缓存、指标流水线、信号生成、买卖处理器、订单监控调度、由 `orderMonitor -> postTradeConsistencyRuntime` 独立拥有的成交后一致性闭环，以及 `SEAT_REFRESH` 激活屏障；新增独立的 `MonitorQuoteEventRuntime` 监听 `MarketDataClient.onQuoteUpdated(...)`，以监控标的 quote 作为这两条链路的唯一业务启动入口，并额外持有“静态距回收价清仓 retry”所需的 trading symbol quote 唤醒注册；事件回调中直接执行“静态标的距回收价检查”和“距离换标入口判定”。距离换标不再依赖主循环每秒心跳推进，而改为由显式事件源驱动状态机继续前进：监控标的 quote 只负责初始触发，订单权威进展事件、成交后一致性 freshness 事件、新旧交易标的 quote 事件和一次性 quote retry timer 共同负责后续阶段推进。`AUTO_SYMBOL_SWITCH_DISTANCE` 与 `LIQUIDATION_DISTANCE_CHECK` 两类 monitor task 生产链路被彻底移除，不允许保留双轨或回退路径。

**Tech Stack:** TypeScript, Bun, Longbridge QuoteContext(WebSocket), 现有 `MarketDataClient` / `symbolRegistry` / `autoSymbolManager` / `trader` / `orderRecorder` / `riskChecker` / `postTradeConsistencyRuntime` / lifecycle / app runtime 装配体系。

---

## 0. 本次二次复核的结论

第二轮全链路复核后，结论如下：

1. **方向正确且可行。**  
   这两条链路的真实触发因子都是“监控标的价格变化”，从第一性原理上属于 monitor quote 事件，不属于主循环轮询职责。

2. **不能只搬入口。**  
   如果只是把“首次阈值判定”从主循环搬到 quote push 回调，但仍让距离换标状态机依赖“主循环下一秒再调一次”，那么事件驱动链路并未闭环；反过来，如果取消主循环调度却不补齐其他唤醒源，`CANCEL_PENDING` / `SELL_OUT` / `WAIT_QUOTE` / `REBUY` 等阶段会卡住。

3. **当前实现存在一个必须修正的语义耦合。**  
   现在两条业务链路复用了 `MONITOR.PRICE_CHANGE_THRESHOLD = 0.001` 的展示去抖阈值。这个阈值属于日志/展示口径，不属于风控/换标口径。若事件驱动方案继续沿用该阈值，仍可能在边界价位遗漏业务触发。  
   本次方案必须把“业务触发”与“展示去抖”彻底解耦。

4. **`AUTO_SYMBOL_SWITCH_DISTANCE` 和 `LIQUIDATION_DISTANCE_CHECK` 不能继续保留为 monitor task 兜底。**  
   这不是兼容问题，而是单一真相源问题。只要保留旧入口，就会重新回到“双轨触发”的不确定状态。

5. **本次方案只覆盖你点名的两条链路。**  
   迁移完成后，主循环不再承担这两条业务检查职责；但现有 `AUTO_SYMBOL_TICK`、指标流水线、信号生成等其他职责不在本次方案内。  
   因此本方案不会错误宣称“主循环全局只剩展示”，只会保证“这两条链路不再由主循环轮询触发”。

---

## 1. 范围与硬约束

### 1.1 本次必须完成的范围

1. 静态标的距回收价检查必须从 `processMonitor -> scheduleRiskTasks -> monitorTaskQueue` 链路彻底迁出。
2. 距离换标检查必须从 `processMonitor -> scheduleAutoSymbolTasks -> monitorTaskQueue` 链路彻底迁出。
3. 监控标的 quote push 到达后，必须直接进入对应业务检查，不再等待主循环下一秒调度。
4. 距离换标状态机必须补齐非 monitor quote 阶段的显式唤醒源，不能再依赖主循环心跳推进。
5. `AUTO_SYMBOL_SWITCH_DISTANCE` 与 `LIQUIDATION_DISTANCE_CHECK` 两类 monitor task 的生产触发路径必须删除。

### 1.2 本次明确不改的范围

1. `AUTO_SYMBOL_TICK` 现有的自动寻标与周期换标触发链路保持现状。
2. `SEAT_REFRESH` 继续保留在 `MonitorTaskProcessor` 中，作为席位激活屏障。
3. `marketMonitor.monitorPriceChanges(...)` 仍由主循环展示层调用，本次不迁移展示逻辑。
4. `runIndicatorPipeline(...)`、`runSignalPipeline(...)`、延迟验证与买卖处理器口径保持不变。
5. 订单成交后的 `orderMonitor -> postTradeConsistencyRuntime` 闭环保持不变，只补充必要事件端口，不改业务语义。

### 1.3 禁止事项

1. 不允许“主循环触发 + quote push 触发”双轨并存。
2. 不允许继续把这两条链路包装成“quote event -> 重新塞回旧 monitorTaskQueue -> old handler”。
3. 不允许为了兼容旧实现保留 `AUTO_SYMBOL_SWITCH_DISTANCE` / `LIQUIDATION_DISTANCE_CHECK` 作为隐藏兜底入口。
4. 不允许继续复用 `MONITOR.PRICE_CHANGE_THRESHOLD` 作为业务触发门槛。
5. 不允许把 `MonitorState.monitorPrice` 视为新的业务真相源；事件价格必须来自当前 quote push payload。
6. 不允许让距离换标状态机在 `CANCEL_PENDING` / `SELL_OUT` / `WAIT_QUOTE` / `REBUY` 阶段继续“等待主循环下一次心跳”。
7. 不允许引入兼容式轮询补丁，例如“若事件没来就每秒再扫一次”。
8. 不允许在生命周期门禁关闭、baseline 未完成、连续交易时段门禁关闭、或末日保护收盘前 5 分钟清仓窗口接管后继续执行这两条链路。

---

## 2. 第一性原理拆解

### 2.1 这两条链路的本质触发因子是什么

#### 静态标的距回收价检查

输入真相只有三项：

1. 当前监控标的价格
2. 当前席位绑定的静态交易标的及其回收价缓存
3. 当前持仓与执行态行情是否允许提交清仓

其中真正改变“是否应触发清仓”的最前置因子，是 **监控标的价格变化**。  
因此入口应归属 monitor quote push。

#### 距离换标

输入真相分为两层：

1. 是否应启动换标：由监控标的价格变化 + 当前席位回收价距离区间决定
2. 换标启动后如何继续推进：由订单状态变化、持仓刷新完成、新标的行情可用性等事件决定

因此：

- **启动入口** 必须归属 monitor quote push
- **后续推进** 不能只靠 monitor quote push，更不能靠主循环轮询

### 2.2 主循环是否应拥有这两条链路

不应。

主循环适合做的是：

1. 生命周期 tick
2. 展示所需缓存读取
3. 指标快照推进与显示
4. 其他尚未事件化的业务调度

而这两条链路都是对“监控价变化”的即时响应，不需要等待下一秒，也不应和展示去抖、批量拉 quote 的主循环节奏耦合。

### 2.3 事件驱动闭环必须满足什么条件

一个正确的事件驱动重构，必须满足：

1. 入口事件明确
2. 中间状态明确
3. 每个等待状态都有明确的后续唤醒源
4. 状态失效条件明确
5. 生命周期停启边界明确

当前代码的问题不在于“没有状态机”，而在于“状态机的若干阶段默认由主循环再次触发”。  
本次方案的核心，就是把这些隐式唤醒点显式化。

---

## 3. 当前实现全链路复核

### 3.1 当前静态标的距回收价检查链路

当前链路：

```text
mainProgram
  -> processMonitor
     -> 读取 monitorQuote
     -> 计算 monitorPriceChanged（复用展示阈值 0.001）
     -> scheduleRiskTasks(...)
        -> monitorTaskQueue.scheduleLatest(LIQUIDATION_DISTANCE_CHECK)
           -> MonitorTaskProcessor
              -> liquidationDistance handler
                 -> waitForFresh + seat snapshot 校验
                 -> 执行时重新拉 monitor / trading quotes
                 -> checkWarrantDistanceLiquidation(...)
                 -> trader.executeSignals(...)
                 -> clearBuyOrders + refreshUnrealizedLossData
```

复核结论：

1. 真正执行态口径是正确的，因为 handler 会重新拉执行态 quote。
2. 入口层口径不够纯，当前依赖主循环 + 展示阈值去抖。
3. 该链路迁移到 quote push 是安全的，因为执行层并不依赖主循环那一拍的 quote 快照。

### 3.2 当前距离换标链路

当前链路：

```text
mainProgram
  -> processMonitor
     -> 读取 monitorQuote
     -> 计算 monitorPriceChanged（复用展示阈值 0.001）
     -> scheduleAutoSymbolTasks(...)
        -> monitorTaskQueue.scheduleLatest(AUTO_SYMBOL_SWITCH_DISTANCE)
           -> MonitorTaskProcessor
              -> autoSymbol handler
                 -> waitForFresh + seat snapshot 校验
                 -> autoSymbolManager.maybeSwitchOnDistance(...)
                    -> switchStateMachine.startSwitchFlow(...)
                    -> processSwitchState(...)
```

`switchStateMachine` 复核结果：

1. `maybeSwitchOnDistance(...)` 在没有 pending switch 时负责“是否应启动换标”。
2. 一旦已有 pending switch，后续每次再调 `maybeSwitchOnDistance(...)` 会继续推进状态机。
3. 也就是说，**当前状态机推进本质上依赖“主循环每秒继续把 monitor price 送进来”**。

### 3.3 当前距离换标状态机的阶段与实际唤醒依赖

现有阶段：

1. `CANCEL_PENDING`
2. `SELL_OUT`
3. `BIND_NEW`
4. `WAIT_QUOTE`
5. `REBUY`
6. `COMPLETE`

二次复核后的真实依赖如下：

| 阶段 | 当前等待的真实条件 | 当前隐式唤醒方式 | 问题 |
| --- | --- | --- | --- |
| `CANCEL_PENDING` | 旧标的买单撤单状态推进 | 主循环再次调 `maybeSwitchOnDistance` | 不应依赖 monitor quote / 主循环 |
| `SELL_OUT` | 旧标的可用持仓变化、卖单成交结果 | 主循环再次调 `maybeSwitchOnDistance` | 不应依赖 monitor quote / 主循环 |
| `BIND_NEW` | 内部同步步骤 | 同次调用直接推进 | 无问题 |
| `WAIT_QUOTE` | 新标的价格与手数可用 | 主循环再次调 `maybeSwitchOnDistance` | 错误事件源 |
| `REBUY` | 新标的价格与手数仍可用 | 主循环再次调 `maybeSwitchOnDistance` | 错误事件源 |
| `COMPLETE` | 内部同步步骤 | 同次调用直接推进 | 无问题 |

结论：

- 当前“入口”与“推进”混在一个 API 里。
- 取消主循环轮询后，如果不拆开这两件事，状态机一定会卡。

### 3.4 当前业务触发还复用了展示去抖阈值

`processMonitor` 当前使用：

```text
Math.abs(resolvedMonitorPrice - lastMonitorPrice) > MONITOR.PRICE_CHANGE_THRESHOLD
```

该阈值当前同时服务于：

1. 监控价展示
2. 静态距回收价清仓入口
3. 距离换标入口

这是一个业务与展示耦合点。  
从第一性原理看：

- 展示需要去抖
- 风控与换标不应由展示阈值决定

因此本次重构必须拆开。

---

## 4. 二次复核后确认的最终架构

## 4.1 顶层新增 `MonitorQuoteEventRuntime`

职责：

1. 监听 `MarketDataClient.onQuoteUpdated(...)`
2. 持有两类 quote 路由：
   - monitor quote 业务启动路由
   - 静态清仓 retry 专属 trading quote 唤醒路由
3. 对每个 `monitorSymbol` 维护 `single-flight + latest-only collapse`
4. 在事件回调中直接做：
   - 自动寻标关闭时的静态距回收价检查入口
   - 自动寻标开启时的距离换标启动入口
5. 对已登记的静态清仓 retry，仅允许由 `monitorSymbol` 或当前席位绑定 `tradingSymbol` 的 quote 事件提前唤醒同一条链路
6. 不处理展示，不处理指标，不处理买卖信号生成

该 runtime 是本次重构的唯一 monitor quote 入口 owner，也是静态清仓 retry quote 唤醒 owner；但它**不是**距离换标 pending 状态机的统一推进 owner。

## 4.2 顶层新增 `SwitchWakeupRuntime`

职责：

1. 持有“距离换标 pending 状态的后续唤醒注册表”
2. 接收以下事件并驱动距离换标继续推进：
   - 旧标的订单权威进展事件
   - 成交后一致性 freshness 完成事件
   - 旧标的 / 新标的 trading quote 事件
   - 旧标的 / 新标的 quote retry timer 到期事件
3. 不负责决定“是否启动距离换标”，只负责“已启动后的继续推进”

为什么必须单独存在：

1. monitor quote 只适合做启动判定，不适合驱动所有等待阶段。
2. 如果把所有等待都塞回 `MonitorQuoteEventRuntime`，仍会把“非 monitor quote 事件”误归类为 monitor quote 逻辑。
3. 把“启动”与“推进”拆开后，语义边界最清晰，也最容易验证没有遗漏分支。

## 4.3 对 `autoSymbolManager` / `switchStateMachine` 的要求

`switchStateMachine` 必须从“隐式心跳推进”改成“显式返回下一次唤醒需求”，并把“启动判定”与“pending drive”彻底拆开。

推荐形态：

```ts
type SwitchStartResult =
  | { kind: 'NOT_TRIGGERED' }
  | { kind: 'STARTED'; next: SwitchDriveResult }
  | { kind: 'SUPPRESSED_SAME_SYMBOL' }
  | { kind: 'FAILED'; reason: string };
```

新增统一返回结构，例如：

```ts
type SwitchDriveResult =
  | { kind: 'COMPLETED' }
  | { kind: 'NOOP' }
  | { kind: 'FAILED'; reason: string }
  | { kind: 'WAIT_ORDER_EVENT'; symbols: ReadonlyArray<string> }
  | { kind: 'WAIT_FRESHNESS' }
  | { kind: 'WAIT_SYMBOL_QUOTE'; symbol: string }
  | { kind: 'WAIT_RETRY_TIMER'; key: string; atMs: number };
```

要求：

1. 状态机每推进一次，都必须返回“下一步需要什么事件”。
2. `SwitchWakeupRuntime` 按返回结果完成注册或取消注册。
3. 不允许继续存在“返回了但没人知道下一次该等谁”的隐式状态。
4. `monitorPrice` 只属于“是否触发距离换标”的启动判定输入；pending switch 的后续 drive 不允许继续依赖触发时那份 `monitorPrice` 或 `positions` 快照。

## 4.4 对静态距回收价清仓链路的要求

静态清仓不需要单独第二个状态机，但仍需要显式重试 owner：

1. monitor quote 事件到达后立即检查
2. 为保持现有执行态语义，真正执行前仍重新拉取 monitor quote 与 trading quote；若任一执行态 quote 不满足要求，则登记一次性 retry timer
3. 若重试前已经收到相关 symbol 的 quote push，可直接提前执行；这里的相关 symbol 包括 `monitorSymbol` 本身以及当前席位绑定的 trading symbol
4. 不再经过 monitorTaskQueue

这仍然是事件驱动，而不是主循环兜底。

## 4.5 drive 时的权威快照读取规则

第一性原理下，事件是“唤醒源”，不是“全部业务真相”。

因此必须固定以下规则：

1. monitor quote 事件只提供“现在值得重新判定”的启动信号，不提供后续阶段的持仓真相。
2. 距离换标一旦进入 pending，`SwitchWakeupRuntime` 每次收到合法 wakeup 后，都必须重新读取当前权威快照再 drive：
   - 最新 `lastState.cachedPositions` / `positionCache`
   - 当前席位快照与 `seatVersion`
   - 当前 `orderRecorder` / 待成交占用状态
   - 必要时最新 `getPendingOrders([oldSymbol])` 结果
3. 这里的“重新读取当前快照”只是**在显式事件到达后的单次评估输入**，不构成新的独立轮询 owner，也不是兜底路径。
4. 静态清仓同理：真正执行前仍必须重新拉执行态 quote 与读取最新持仓，禁止复用首次 monitor quote 到达时的历史快照。

---

## 5. 事件与真相源设计

## 5.1 监控标的 quote 事件

事件源：

- 现有 `MarketDataClient.onQuoteUpdated(...)`

真相源：

- 当前事件 payload 中的 `quote.price`

规则：

1. monitor quote 启动路由只消费 `monitorContexts` 中存在的 `monitorSymbol`
2. 不再使用 `MonitorState.monitorPrice` 作为业务触发判断依据
3. 不再使用 `MONITOR.PRICE_CHANGE_THRESHOLD`
4. 每个有效 monitor quote push 都可进入业务 runtime；latest-only collapse 负责避免堆积

## 5.2 交易标的 quote 事件

事件源：

- 现有 `MarketDataClient.onQuoteUpdated(...)`

用途：

1. 距离换标 `SELL_OUT` 中 oldSymbol quote 未就绪后的 retry 推进
2. 距离换标 `WAIT_QUOTE` / `REBUY` 阶段推进
3. 静态清仓链路中“之前因为执行态 quote 未就绪而挂起”的 retry 可提前唤醒

规则：

1. `SwitchWakeupRuntime` 只消费距离换标 pending 状态机已登记的 old/new trading symbol quote 唤醒
2. `MonitorQuoteEventRuntime` 只消费自己已登记的静态清仓 retry trading symbol quote 唤醒
3. trading symbol quote 不可反向驱动“是否应启动距离换标”，启动入口仍然只能来自 monitor quote

## 5.3 订单状态事件

当前缺口：

- 订单监控内部有 `PushOrderChanged` 处理，但没有对外统一事件端口

本次必须新增最小事件端口，例如：

```ts
interface OrderStateEventPort {
  onOrderStateChanged: (listener: (event: NormalizedOrderStateEvent) => void) => () => void;
}
```

用途：

1. `CANCEL_PENDING` 阶段等待旧标的买单撤单进展
2. `SELL_OUT` 阶段等待卖单终态推进

规则：

1. 事件必须来自 order monitor 的**权威订单进展归一化结果**，来源可以是：
   - 正常 WS push 推进
   - 撤单/改单后的单订单权威状态确认结果
   - 基于权威终态完成的本地结算推进
2. `SwitchWakeupRuntime` 不允许自己发起“为了等事件而轮询订单”的独立 owner；但在合法 wakeup 到达后，允许单次读取当前 `getPendingOrders()` 作为 drive 输入快照

## 5.4 freshness 完成事件

当前缺口：

- `postTradeConsistencyRuntime` 只有 `waitForFresh()`，没有广播式“fresh 完成”事件

本次必须新增最小事件端口，例如：

```ts
interface PostTradeFreshEventPort {
  onFreshReached: (listener: (status: PostTradeConsistencyRuntimeStatus) => void) => () => void;
}
```

用途：

1. `SELL_OUT` 后等待持仓与订单记录刷新完成，再判断是否可进入 `BIND_NEW`
2. 周期换标 pending 与距离换标接管场景中，需要在刷新后复核席位快照与本地占用状态

规则：

1. 只能用 freshness 事件表明“刷新已追平”
2. 不允许用主循环下一秒再查一遍代替 freshness 事件

## 5.5 一次性 retry timer

用途：

1. 距离换标中 quote 未就绪时的 `ORDER_QUOTE_RETRY`
2. 静态清仓中执行态 quote 未就绪时的 retry

规则：

1. timer 是业务显式等待事件，不是轮询兜底
2. timer 必须按现有 `ORDER_QUOTE_RETRY` 常量控制，语义保持不变
3. timer 到期后由对应 runtime 收到一个“重试事件”，而不是交回主循环
4. timer 只用于“quote readiness 等待”，不允许扩展成 `CANCEL_PENDING` 的订单状态轮询补丁

---

## 6. 目标链路详细说明

## 6.1 静态标的距回收价检查目标链路

适用前提：

1. `autoSearchEnabled === false`
2. 收到 `monitorSymbol` 的有效 quote push

目标链路：

```text
monitorSymbol quote push
  -> MonitorQuoteEventRuntime
     -> 校验 lifecycle gate / canTrade / baseline
     -> 读取当前 monitorContext / symbolRegistry / seatVersion
     -> 若 autoSearchEnabled=false，则直接进入 StaticLiquidationExecutor
        -> waitForFresh 后再次校验席位快照
        -> 执行态拉取 monitor / trading quotes
        -> 调用 checkWarrantDistanceLiquidation(...)
        -> 若触发，则 trader.executeSignals(...)
        -> 提交成功后 clearBuyOrders + refreshUnrealizedLossData
        -> 若 monitor / trading 任一执行态 quote 未就绪，则登记 retry timer，并由本 runtime 持有 monitorSymbol / tradingSymbol 的提前唤醒注册
```

关键点：

1. 执行前仍然必须 `waitForFresh()`，保持与现有 monitor task handler 一致的时序保护。
2. 为保持现有执行态口径，静态清仓在真正提交前仍重新拉取 monitor quote 与 trading quote；monitor quote 负责清仓业务判定，trading quote 负责订单提交价格与后续缓存刷新。
3. 提交后清理订单记录与刷新浮亏缓存的语义不变。
4. quote 未就绪时只能等待显式重试事件，不能回退到主循环。
5. tradingSymbol quote 只允许唤醒“已登记的静态清仓 retry”，不能反向变成新的清仓启动入口。

## 6.2 距离换标启动目标链路

适用前提：

1. `autoSearchEnabled === true`
2. 收到 `monitorSymbol` 的有效 quote push

目标链路：

```text
monitorSymbol quote push
  -> MonitorQuoteEventRuntime
     -> 校验 lifecycle gate / canTrade / baseline
     -> waitForFresh 前后各做一次快照校验
     -> 调用 autoSymbolManager.handleMonitorQuoteEvent(...)
        -> 若无 pending switch，则按当前席位与 monitor price 判断是否越界
        -> 越界则 startSwitchFlow(...)
        -> processSwitchStateStep(...)
        -> 返回下一次唤醒需求
     -> 将唤醒需求交给 SwitchWakeupRuntime 注册
```

关键点：

1. monitor quote 只负责“启动或重新评估是否应触发距离换标”。
2. 一旦进入 pending switch，后续推进不再依赖 monitor quote 反复到来。
3. 距离换标启动前对持仓的任何判断，都必须基于 `waitForFresh()` 之后的最新 `cachedPositions`，不能复用事件到达瞬间的旧快照。

## 6.3 距离换标推进目标链路

目标链路：

```text
距离换标已启动
  -> SwitchWakeupRuntime 持有 wakeup registry
     -> 收到 order progress event / freshness event / tradingSymbol quote event / retry timer event
     -> 找到对应 direction 的 switch state
     -> 复核 lifecycle gate + seatVersion + seat symbol
     -> 重新读取当前权威 positions / pending orders / orderRecorder 状态
     -> 调用 processSwitchStateStep(...)
     -> 再次返回下一次唤醒需求
     -> 完成则注销全部注册；失败则 fail-fast 清席位
```

关键点：

1. 状态机 owner 始终只有一份，不允许“monitor quote runtime 与 wakeup runtime 同时推进同一状态机”。
2. `SwitchWakeupRuntime` 必须以 `monitorSymbol + direction + seatVersion` 作为唯一标识，旧席位版本的注册必须立即作废；不允许仅用 `direction + seatVersion`，否则在多监控标的并发场景下会发生 wakeup registry 冲突。
3. `SwitchWakeupRuntime` 每次 drive 都必须重新读取最新 `lastState.cachedPositions`；禁止把首次 monitor quote 触发时的 positions 作为整个换标流程的持久真相源。

---

## 7. 距离换标状态机唤醒矩阵

| 阶段 | 进入条件 | 允许的下一步唤醒源 | 禁止的唤醒源 | 退出条件 |
| --- | --- | --- | --- | --- |
| `CANCEL_PENDING` | 已进入 `SWITCHING`，需撤旧标的买单 | 旧标的订单权威进展事件 | monitor quote 心跳、主循环、订单轮询 timer | 所有可撤买单离开待撤/待成交态 |
| `SELL_OUT` | 撤单已完成，需要移仓卖出或等待可用持仓 | 旧标的订单权威进展事件、freshness 完成事件、旧标的 quote retry timer | monitor quote 心跳 | 卖出提交并结算完成，或确认无需回补 |
| `BIND_NEW` | 旧标的处理已结束 | 无需外部唤醒，同次执行推进 | 任何异步心跳 | 新标的已写入 `SWITCHING` 席位 |
| `WAIT_QUOTE` | 已绑定新标的，等待新标的 price+lotSize 就绪 | 新标的 quote 事件、retry timer | monitor quote 心跳、主循环 | `PRICE_AND_LOT_SIZE` 就绪 |
| `REBUY` | 已拿到新标的 quote，准备回补买入 | 新标的 quote 事件、retry timer | monitor quote 心跳、主循环 | 回补提交成功或确认买量无效可跳过 |
| `COMPLETE` | 状态机内部完成 | 无需外部唤醒 | 任何异步心跳 | 席位进入 `ACTIVATING` 并触发 `SEAT_REFRESH` |
| `FAILED` | 任一 fail-fast 分支 | 无 | 无 | 清席位并注销 wakeup |

附加规则：

1. 若 `periodic pending` 已存在，monitor quote 触发距离换标时仍允许按现有语义接管。
2. 若本次仅因“候选与当前标的一致”被抑制，则必须保留原有周期 pending 状态，不得误清除。

---

## 8. 关键业务分支复核

## 8.1 自动寻标关闭

必须满足：

1. monitor quote push 直接触发静态距回收价检查
2. 不再调度 `LIQUIDATION_DISTANCE_CHECK`
3. 距离换标完全不参与

## 8.2 自动寻标开启

必须满足：

1. monitor quote push 直接触发距离换标入口判定
2. 静态距回收价清仓链路不参与
3. 换标成功后仍按原有 `SEAT_REFRESH` 刷新订单、账户、浮亏、回收价缓存

## 8.3 距离换标与周期换标并存

必须保持现有业务口径：

1. 周期换标 pending 等待时，距离换标可以优先接管。
2. 若距离换标本次仅因“候选与当前标的一致”被抑制，周期 pending 保持原状。
3. 周期换标自身仍由 `AUTO_SYMBOL_TICK` 维持，本次不改变该事实。

## 8.4 席位版本失效

必须保持现有一致性模型：

1. 任何事件处理前后都要校验 `seatVersion`
2. 旧版本挂起的 quote / order / freshness / timer 注册必须被立即注销
3. `SEAT_REFRESH` 失败导致 bump version 后，旧 wakeup 不能再继续推进

## 8.5 `ACTIVATING -> ACTIVE`

必须保持现有激活屏障：

1. 距离换标完成后只把 seat 推进到 `ACTIVATING`
2. 真正进入 `ACTIVE` 必须等 `SEAT_REFRESH` 成功
3. 在 `ACTIVATING` 阶段不得消费旧标的相关事件

## 8.6 末日保护

必须保持：

1. 生命周期与交易时段门禁优先
2. 收盘前 5 分钟末日保护清仓窗口接管后，这两条链路都不得继续执行
3. 不能因为 WS 事件实时到达而绕开末日保护接管语义

## 8.7 午夜清理 / 开盘重建 / startupRebuildPending

必须保持：

1. 新 runtime 在午夜清理前按 owner 顺序停止并排空
2. 所有 wakeup registry、retry timer 必须在午夜清理时清空
3. 只有 open rebuild 完成且 `postTradeConsistencyRuntime.completeRebuildBaseline()` 之后，runtime 才能重新启动
4. 启动快照失败进入 `startupRebuildPending` 时，新 runtime 不允许提前启动
5. 静态清仓 retry 注册与距离换标 wakeup registry 都必须在 stopAndDrain / midnight clear 时完全清空，不能跨生命周期残留

## 8.8 cleanup / 进程退出

必须把新增 runtime 纳入 [createCleanup](D:/code/Longbridge-Quantitative-Trading/src/app/createCleanup.ts) 的 stop 顺序中：

1. 先终止 freshness 等待
2. 再停 `MonitorQuoteEventRuntime`
3. 再停 `SwitchWakeupRuntime`
4. 再停其他处理器

原因：

- 防止退出时仍有 quote / order / timer 事件继续推进换标状态机

---

## 9. 文件级改造方案

## 9.1 新增模块

- `src/main/monitorQuoteEventRuntime/index.ts`
- `src/main/monitorQuoteEventRuntime/types.ts`
- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
- `src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts`
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`

说明：

1. 新增模块只保留本次事件驱动闭环所必需的 owner 与执行器。
2. 不预先引入路由表、注册中心或独立 validation facade；若实现过程中确实出现不可避免的复用点，再按最小必要原则补充，而不是先抽象后落地。

## 9.2 改造现有模块

### 主循环与单标的处理

- `src/main/processMonitor/index.ts`
- `src/main/processMonitor/autoSymbolTasks.ts`
- `src/main/processMonitor/riskTasks.ts`

改造目标：

1. 删除距离换标与静态清仓的 monitor task 生产逻辑
2. 保留展示、指标、信号链路

### monitor task 体系

- `src/main/asyncProgram/monitorTaskProcessor/types.ts`
- `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/liquidationDistance.ts`

改造目标：

1. 删除 `AUTO_SYMBOL_SWITCH_DISTANCE`
2. 删除 `LIQUIDATION_DISTANCE_CHECK`
3. 保留 `AUTO_SYMBOL_TICK` 与 `SEAT_REFRESH`

### auto symbol 状态机

- `src/services/autoSymbolManager/index.ts`
- `src/services/autoSymbolManager/switchStateMachine.ts`
- `src/services/autoSymbolManager/types.ts`

改造目标：

1. 把“启动距离换标”和“推进 pending switch”拆开
2. 引入显式 `SwitchDriveResult`
3. 清楚声明每个阶段的下一次唤醒需求

### order monitor / trader 端口

- `src/core/trader/orderMonitor/index.ts`
- `src/core/trader/orderMonitor/types.ts`
- `src/core/trader/index.ts`
- `src/core/trader/types.ts`
- `src/types/services.ts`

改造目标：

1. 新增最小 `onOrderStateChanged(...)` 事件端口
2. 仅暴露距离换标继续推进所需的权威订单进展事件，统一覆盖 WS 推进与单订单权威状态确认推进

### post trade consistency runtime 端口

- `src/app/runtime/createPostTradeConsistencyRuntime.ts`
- `src/app/types.ts`
- `src/types/services.ts`

改造目标：

1. 新增 `onFreshReached(...)` 事件端口
2. 保持原有 `waitForFresh()` 语义不变

### runtime 装配与 lifecycle

- `src/app/runtime/createPostGateRuntime.ts`
- `src/app/runApp.ts`
- `src/app/createCleanup.ts`
- `src/app/createLifecycleRuntime.ts`
- `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
- `src/main/lifecycle/cacheDomains/types.ts`
- `src/app/types.ts`

改造目标：

1. 创建并装配新 runtime
2. 将新 runtime 纳入 lifecycle cache domain 的依赖类型与装配链路，确保能参与 startup、cleanup、midnight clear、open rebuild

---

## 10. 详细实施步骤

- [ ] 新增 `MonitorQuoteEventRuntime`，以 monitorSymbol quote 作为业务启动入口，并实现每个 `monitorSymbol` 的 `single-flight + latest-only collapse`。
- [ ] 由 `MonitorQuoteEventRuntime` 显式持有静态清仓 retry 的 tradingSymbol 唤醒注册，但这类 trading quote 只能唤醒已存在 retry，不得启动新业务链路。
- [ ] 将静态距回收价清仓逻辑从旧 `liquidationDistance handler` 中抽成 `staticLiquidationExecutor`，改为由 `MonitorQuoteEventRuntime` 直接调用。
- [ ] 删除 `processMonitor -> scheduleRiskTasks` 中对 `LIQUIDATION_DISTANCE_CHECK` 的调度。
- [ ] 删除 `MonitorTaskProcessor` 中 `LIQUIDATION_DISTANCE_CHECK` 的类型、分派与 handler 接线。
- [ ] 将距离换标入口逻辑从旧 `AUTO_SYMBOL_SWITCH_DISTANCE` handler 中抽到 `autoSymbolManager` 的 monitor quote 入口 API。
- [ ] 改造 `switchStateMachine`，让每次推进都返回显式 `SwitchDriveResult`，不再隐式等待主循环下一秒。
- [ ] 明确 `SwitchWakeupRuntime` 的 drive 输入规则：每次合法 wakeup 后重新读取最新 `lastState.cachedPositions`、必要的 `getPendingOrders()` 和当前席位快照，禁止复用首次触发时的 positions。
- [ ] 新增 `SwitchWakeupRuntime`，负责管理 pending switch 的 order event / freshness event / symbol quote event / retry timer 注册与继续推进。
- [ ] 在 order monitor / trader 边界新增标准化订单权威进展事件端口，统一覆盖 WS 推进与单订单权威状态确认推进。
- [ ] 在 `postTradeConsistencyRuntime` 边界新增 freshness 完成事件端口。
- [ ] 删除 `processMonitor -> scheduleAutoSymbolTasks` 中对 `AUTO_SYMBOL_SWITCH_DISTANCE` 的调度；保留 `AUTO_SYMBOL_TICK`。
- [ ] 删除 `MonitorTaskProcessor` 中 `AUTO_SYMBOL_SWITCH_DISTANCE` 的类型、分派与 handler 接线。
- [ ] 将两个新 runtime 纳入 `createPostGateRuntime`、`runApp`、`signalRuntimeDomain` 与 `createCleanup` 的 owner 链路。
- [ ] 运行实现所需的 `bun format`、`bun lint`、`bun type-check` 并修复全部问题。

---

## 11. 验证矩阵

### 11.1 静态距回收价清仓

1. 自动寻标关闭，monitor quote 越过清仓阈值，能直接触发静态清仓。
2. monitor quote 到达时，若执行态 monitor quote 或 trading quote 任一未就绪，能登记 retry。
3. retry 前若 monitorSymbol 或 tradingSymbol 的 quote push 先到，能提前继续。
4. 提交成功后能清空订单记录并刷新浮亏缓存。
5. 生命周期门禁关闭、末日保护接管、baseline 未完成时，不会误触发。

### 11.2 距离换标启动

1. 自动寻标开启，monitor quote 越界时，能直接启动距离换标。
2. 候选与当前标的一致时，只记录抑制，不启动换标。
3. 周期 pending 存在时，距离换标能按现有语义接管。

### 11.3 距离换标推进

1. `CANCEL_PENDING` 阶段在旧标的买单撤单事件推进后继续，而不是等主循环。
2. `SELL_OUT` 阶段在卖单成交 / freshness 追平后继续，而不是等主循环。
3. `WAIT_QUOTE` / `REBUY` 阶段在新标的 quote push 到达后继续，而不是等主循环。
4. retry 耗尽时按现有 fail-fast 语义清席位，不产生隐藏兜底。
5. 任意阶段继续推进时，读取的是当前最新 positions / pending orders，而不是首次 monitor quote 触发时的旧快照。

### 11.4 席位与一致性

1. 换标中 bump version 后，旧事件全部失效。
2. `SEAT_REFRESH` 成功前席位不会进入 `ACTIVE`。
3. `SEAT_REFRESH` 失败会按原口径清席位并清理旧任务。

### 11.5 生命周期

1. 午夜清理时，新 runtime 会停止、清空 registry、清理 timer。
2. 开盘重建完成并 baseline 追平后，新 runtime 才重新启动。
3. startupRebuildPending 场景下，新 runtime 不会提前启动。
4. cleanup / midnight clear 后不会残留旧 seatVersion 的 wakeup 注册或静态清仓 retry 注册。

---

## 12. 本方案明确拒绝的错误实现

1. **错误实现：** quote push 到达后只是把旧 task 再塞进 `monitorTaskQueue`。  
   **拒绝原因：** 这只是换入口，不是换 owner，双轨与旧耦合仍在。

2. **错误实现：** 搬入口后仍让 `maybeSwitchOnDistance(...)` 靠主循环每秒继续被调用。  
   **拒绝原因：** 状态机 owner 仍然是主循环，事件驱动名存实亡。

3. **错误实现：** 用 `MONITOR.PRICE_CHANGE_THRESHOLD` 决定是否执行业务检查。  
   **拒绝原因：** 展示去抖与业务触发口径混用，会遗漏边界价位。

4. **错误实现：** quote 未就绪时“先跳过，等主循环下次再说”。  
   **拒绝原因：** 这是典型隐藏兜底，不是显式事件驱动。

5. **错误实现：** monitor quote 负责推进 `WAIT_QUOTE` / `SELL_OUT` 等所有阶段。  
   **拒绝原因：** 这些阶段等待的并不是 monitor quote，而是订单、freshness 或新标的 quote。

6. **错误实现：** 新 runtime 直接读 `MonitorState.monitorPrice` 或主循环 `quotesMap` 作为业务真相。  
   **拒绝原因：** 真相源必须是当前 push 事件和执行态拉取结果，而不是展示缓存。

7. **错误实现：** 距离换标开始后持续复用首次触发时传入的 `positions`。  
   **拒绝原因：** `SELL_OUT` / `BIND_NEW` / `REBUY` 判断依赖的是当前持仓真相，不是触发瞬间快照。

8. **错误实现：** 订单推进事件只认原始 WS push，不认权威状态确认与其结算结果。  
   **拒绝原因：** 这会把合法推进路径遗漏掉，最终逼出新的隐藏兜底。

9. **错误实现：** 为了静态清仓 retry 提前唤醒，临时再加一个无 owner 的 tradingSymbol quote 监听器。  
   **拒绝原因：** quote owner 不清会重新引入隐式双轨，必须由既定 runtime 显式持有注册与注销。

---

## 13. 最终结论

二次复核后的最终结论是：

1. 你的重构方向完全正确。
2. 这次重构真正要做的，不只是“把检查入口搬到 WS 回调”，而是 **把这两条链路的 owner 从主循环迁到事件系统**。
3. 静态距回收价清仓可以直接事件化，难点不大。
4. 距离换标真正的难点是“状态机后续阶段的显式唤醒”，这是本次方案必须一次性做对的核心。
5. 只要严格按本方案落地，就能在不引入兼容逻辑、补丁逻辑、隐藏轮询或降级路径的前提下，完成这两条链路从主循环轮询到 monitor quote 事件直驱的重构。
