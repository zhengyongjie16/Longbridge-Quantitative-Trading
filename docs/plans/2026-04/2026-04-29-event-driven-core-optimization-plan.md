# 事件驱动主链路前三项优化全链路分析与实施方案

**日期:** 2026-04-29

**状态:** 方案文档，尚未实施

**目标:** 在当前已经完成大量事件驱动改造的基础上，对剩余可优化空间中的前三项进行全链路验证，并给出不依赖兼容双轨、不引入兜底轮询、不过度设计的实施方案。

---

## 0. 第一性原理结论

交易程序里的“事件驱动”不是形式上的“没有循环”，而是业务状态只能由权威事实源推进：

1. 市场行情事实由 Longbridge push 事件推进。
2. 订单事实由订单 WebSocket、订单保留集、成交后 freshness 推进。
3. 生命周期、交易时段、末日窗口这类时间事实由明确的时间边界 timer 推进。
4. 策略信号只能在交易门禁允许时生成并进入后续业务链路。
5. 不允许一个 owner 已经能从事件得到真相，另一个每秒扫描 owner 还在做同一件事。

基于当前代码复核，本程序的普通 K 线指标、普通 immediate/delayed signal 主链路、交易标的 quote 风控、非周期自动寻标、pending switch 推进、订单监控、成交后一致性刷新，已经以事件 owner 为主。剩余最值得优先优化的三项是：

1. `runSignalPipeline` 中普通门禁关闭时仍先调用 `strategy.generateSignals(...)`，导致候选信号和延迟验证理由在不允许生成信号的窗口内仍被构造。
2. 周期换标仍通过 `timeDriverProgram -> processMonitor -> AUTO_SYMBOL_TICK` 每秒入队检查，属于显式残留轮询。
3. 顶层 `runApp` 仍以 `TRADING.INTERVAL_MS = 1000` 固定循环驱动 `timeDriverProgram`，虽然其中有生命周期、交易时段、末日保护等天然时间语义，但实现形态仍是固定采样。

优先级判断：

1. 第一项可直接实施，风险最低，收益明确。
2. 第二项可实施，但需要新增周期换标 wakeup runtime，并移除 `AUTO_SYMBOL_TICK` 旧链路，不能保留双轨。
3. 第三项可行，但必须在第二项之后做；否则 `timeDriverProgram` 仍承担周期换标每秒 tick，无法正确收敛为边界 timer。第三项还必须补齐末日清仓窗口内的成交后事件唤醒，否则会漏掉窗口内新成交持仓。

---

## 1. 当前代码证据图

### 1.1 已经事件驱动的主业务链路

普通 K 线主链路当前由 `BusinessEventProgram` 接收 Longbridge K 线 push 后推进：

```text
QuoteClient.setOnCandlestick(...)
  -> BusinessEventProgram.onCandlestickUpdated(...)
  -> runIndicatorPipeline(...)
  -> indicatorCache.push(...)
  -> monitorDisplayRuntime.requestRender(...)
  -> runSignalPipeline(...)
```

这一链路的关键性质是：指标推进、指标缓存写入、普通信号评估不再由顶层主循环读取 candlestick cache 后轮询触发。

交易标的 quote 相关的距离换标和 pending switch 当前也已经有事件 owner：

```text
QuoteClient.setOnQuote(...)
  -> MonitorQuoteEventRuntime
  -> autoSymbolManager.startSwitchOnDistance(...)
  -> SwitchWakeupRuntime.handoffPendingSwitch(...)
  -> quote / order / freshness / retry timer wakeup
  -> autoSymbolManager.advancePendingSwitch(...)
```

非周期空席位自动寻标当前由 `AutoSearchWakeupRuntime` 消费 seat/gate/timer 事件，不再由 `AUTO_SYMBOL_TICK` 扫描空席位。

### 1.2 仍然保留固定 tick 的链路

当前顶层循环位于 `src/app/runApp.ts`：

```text
for (;;) {
  await timeDriverProgram(...)
  await sleep(max(0, TRADING.INTERVAL_MS - elapsedMs))
}
```

`TRADING.INTERVAL_MS` 在 `src/constants/index.ts` 中为 `1000`。

`timeDriverProgram` 当前仍负责：

1. 计算交易日、连续交易时段、开盘保护状态。
2. 调用 `dayLifecycleManager.tick(...)`。
3. 交易门禁变化时发布 gate event。
4. 非连续交易时段或清仓接管窗口开始时清理普通 delayed signals。
5. 末日保护买入截止窗口撤单、清仓接管窗口清仓。
6. 调用 `processMonitor(...)`，后者只剩调度周期换标 `AUTO_SYMBOL_TICK`。

周期换标当前链路是：

```text
runApp fixed 1s loop
  -> timeDriverProgram(...)
  -> processMonitor(...)
  -> scheduleAutoSymbolTasks(...)
  -> monitorTaskQueue.scheduleLatest(AUTO_SYMBOL_TICK)
  -> MonitorTaskProcessor.handleAutoSymbolTick(...)
  -> autoSymbolManager.maybeSwitchOnInterval(...)
```

`maybeSwitchOnInterval(...)` 内部已经有正确的业务判断：

1. 自动寻标和周期换标开关关闭时直接清理 pending。
2. 已有 pending switch 时不重复启动。
3. seat 非 ACTIVE 时不触发。
4. 通过 `calculateTradingDurationMsBetween(...)` 计算交易时段累计时长。
5. 到期后先检查 `ORDER_RECORDER` 和 `LOCAL_PENDING_ORDER` 阻塞。
6. 被阻塞时进入 `periodicSwitchPending`，空仓后再启动周期换标。

问题不在状态机业务规则，而在“每秒问一次是否到期”的触发方式。

---

## 2. 优化一：普通信号门禁前置到候选生成前

### 2.1 当前链路

当前 `runSignalPipeline(...)` 的执行顺序是：

```text
if (openProtectionActive) return

canEnqueue = ordinarySignalGuard(...)

strategy.generateSignals(...)

for immediateSignals:
  prepareSignal(...)
  if canEnqueue push queue
  else log skip

for delayedSignals:
  prepareSignal(...)
  if canEnqueue delayedSignalVerifier.addSignal(...)
  else log skip
```

这意味着：

1. 开盘保护窗口内不会调用 `strategy.generateSignals(...)`。
2. 但生命周期交易门禁关闭、非连续交易时段、清仓接管窗口这些 `ordinarySignalGuard(...) === false` 的场景，仍会先生成 immediate/delayed 候选信号。
3. delayed signal 的 `reason` 会在策略层被构造，例如包含“将在某时间验证”的语义，但随后又因门禁关闭不加入 verifier。

从第一性原理看，`ordinarySignalGuard` 表示普通信号链路的准入门，不只是队列入队门。准入门关闭时，普通策略候选本身就不应该生成。

### 2.2 业务边界验证

这一优化只改变“门禁关闭时是否生成候选信号”，不改变以下事实：

1. K 线事件仍会推进 `runIndicatorPipeline(...)`。
2. `indicatorCache.push(...)` 仍会写入最新指标样本，保证已有 delayed verification 需要读取最近样本时仍有数据。
3. `monitorDisplayRuntime.requestRender(...)` 仍可基于最新 snapshot 刷新展示。
4. `openProtectionActive` 已经是提前 return，本次只是让 `ordinarySignalGuard` 的语义与开盘保护一致。
5. delayed verification callback 侧仍应继续使用普通信号准入检查；已经进入 verifier 的历史信号在触发时仍要以当时门禁为准。
6. 末日保护买入截止窗口不是本次优化范围。当前买入截止主要由风控/订单执行链路拒绝买入，并由 `doomsdayProtection.cancelPendingBuyOrders(...)` 撤单；本次不把买入截止窗口扩大解释成“策略层不生成买入候选”，避免改变现有业务含义。

### 2.3 可行性

可行性：高。

原因：

1. 修改点局限在 `src/main/businessEventProgram/signalPipeline.ts`。
2. 当前测试 `tests/main/processMonitor/signalPipeline.business.test.ts` 已经有 `openProtectionActive` 时 `generateSignals` 调用次数为 0 的断言，可以直接扩展同类断言。
3. 该改动不会触碰订单执行、自动换标、生命周期、订阅 owner。
4. 它删除的是无效候选生成和无效日志，不会删除任何可以执行的交易动作。

### 2.4 具体方案

改造后的顺序应为：

```text
if (openProtectionActive) return

if (!ordinarySignalGuard(...)) return

strategy.generateSignals(...)

prepareSignal(...)
push immediate / delayed
```

需要同步删除或改写 `canEnqueue === false` 分支下的逐信号 debug 日志，因为这些分支在新语义下不会再存在。若仍需要可观测性，只允许保留一条 route 级 debug，例如“普通信号门禁关闭，本次 K 线事件不生成普通信号”，不能为了日志保留候选生成。

### 2.5 验证要求

必须新增或调整测试：

1. `isTradingEnabled=false` 时 `strategy.generateSignals` 调用次数为 0，买卖队列为空，delayed verifier 未添加信号。
2. `canTradeNow=false` 时 `strategy.generateSignals` 调用次数为 0。
3. `openProtectionActive=true` 原有测试继续通过。
4. `ordinarySignalGuard=true` 时现有 immediate/delayed routing 行为不变。
5. 若补充清仓接管窗口测试，应只验证 `ordinarySignalGuard=false` 时不生成普通候选，不把买入截止窗口混入本次语义。

---

## 3. 优化二：周期换标从 `AUTO_SYMBOL_TICK` 改为显式 wakeup runtime

### 3.1 当前链路

当前周期换标入口由固定 1 秒主循环间接驱动：

```text
timeDriverProgram(...)
  -> processMonitor(...)
  -> scheduleAutoSymbolTasks(...)
  -> AUTO_SYMBOL_TICK
  -> handleAutoSymbolTick(...)
  -> autoSymbolManager.maybeSwitchOnInterval(...)
```

这条链路的业务决策在 `autoSymbolManager.maybeSwitchOnInterval(...)`，但触发方式是每秒扫描。`scheduleAutoSymbolTasks(...)` 对每个 monitor 的 LONG/SHORT 都调度一次 latest 任务，虽然队列有 dedupe，但它仍然是轮询。

### 3.2 第一性原理判断

周期换标的真实触发条件不是“每秒发生一次”，而是：

1. seat 必须处于 ACTIVE。
2. 周期换标配置启用。
3. 从 `lastSeatActivatedAt` 开始累计的交易时段时长达到 `switchIntervalMinutes`。
4. 交易门禁处于连续交易时段。
5. 当前 seat symbol 没有本地买入记录，也没有本地 pending order。
6. 若到期时被本地订单链路阻塞，应进入 pending，等待订单/freshness 事件后再推进。

因此正确 owner 应是“周期换标 wakeup runtime”，而不是 `AUTO_SYMBOL_TICK`。

### 3.3 必须补齐的时间能力

当前 `src/utils/time/index.ts` 只有：

```text
calculateTradingDurationMsBetween(startMs, endMs, calendarSnapshot)
```

它能回答“两个时间点之间累计了多少交易时长”，但不能回答“累计交易时长到达目标值的下一个时间点在哪里”。

周期换标去轮询前，必须新增一个反向解析能力，例如：

```text
resolveTradingDurationTargetTimeMs({
  startMs,
  targetTradingDurationMs,
  calendarSnapshot,
})
```

语义要求：

1. 使用与 `calculateTradingDurationMsBetween(...)` 同一套交易日历快照和会话规则。
2. 正常交易日累计 09:30-12:00 与 13:00-16:00。
3. 半日市只累计 09:30-12:00。
4. 午休、收盘后、非交易日不累计。
5. 快照缺失日期按不可解析处理，不新增“每秒试试看”的兜底轮询。
6. 返回第一个累计交易时长达到目标值的 UTC 毫秒时间戳；如果快照范围内无法解析，返回 `null`。

实现上不应复制一份会话规则。应把 `resolveSessionRangesByDay(...)` 这类能力从 `utils/time/index.ts` 内部抽成可复用纯函数，或在同一模块内实现反向解析并共享内部 helper。

### 3.4 新 owner 设计

新增 `PeriodicSwitchWakeupRuntime`，只负责周期换标入口，不负责非周期寻标、距离换标、pending switch 后续推进。

建议路径：

```text
src/main/periodicSwitchWakeupRuntime/index.ts
src/main/periodicSwitchWakeupRuntime/types.ts
```

运行时依赖：

1. `tradingConfig`
2. `monitorContexts`
3. `lastState`
4. `tradingGateEventRuntime`
5. `trader.onOrderHoldSymbolsChanged(...)`
6. `postTradeConsistencyRuntime.onFreshReached(...)`
7. `switchWakeupRuntime.handoffPendingSwitch(...)`
8. `now / scheduleTimer / clearTimer`

它的 wakeup 来源只能是：

1. runtime start 后对当前 ACTIVE seat 做一次即时 reconcile。
2. seat state changed：seat 进入 ACTIVE 或 ACTIVE seat 的 `lastSeatActivatedAt` 发生重置时，重新计算该 route/direction 的到期 timer。
3. gate state changed：进入连续交易时段时，对 ACTIVE 或 periodic pending 的 route/direction 重新推进一次。
4. due timer：累计交易时长达到 `switchIntervalMinutes` 的精确 timer。
5. order hold symbols changed：`LOCAL_PENDING_ORDER` 阻塞变化后，重新推进受影响 symbol 对应的 pending route。
6. freshness reached：成交后 position/orderRecorder 相关缓存达到一致后，重新推进被 `ORDER_RECORDER` 阻塞的 pending route。

它不允许：

1. 每秒扫所有 monitor。
2. 保留 `AUTO_SYMBOL_TICK` 作为兼容备用。
3. 在 runtime 内长期缓存 positions/orderRecorder/orderHold 的事实副本。
4. 自己推进 pending switch 的 quote/order/freshness/retry 后续步骤；后续步骤仍归 `SwitchWakeupRuntime`。

### 3.5 推进规则

每次 wakeup 只做一件事：

```text
autoSymbolManager.maybeSwitchOnInterval({
  direction,
  currentTime: now(),
  canTradeNow: lastState.canTrade === true,
})
```

如果返回 WAIT 类型的 switch drive result，则立即交给：

```text
switchWakeupRuntime.handoffPendingSwitch(...)
```

如果未到期，则使用 `lastSeatActivatedAt + switchIntervalMinutes` 在交易时段累计语义下解析下一次 due timer。

如果已到期但被 `ORDER_RECORDER` 或 `LOCAL_PENDING_ORDER` 阻塞，则不再安排固定 tick；只保留订单/freshness 事件唤醒。

如果 seat 变为非 ACTIVE、配置关闭、已有 pending switch，清理该 route/direction 的 timer。

### 3.6 装配与删除范围

需要新增接线：

1. 在 `src/app/runtime/createPostGateRuntime.ts` 创建 `periodicSwitchWakeupRuntime`。
2. 在 `src/app/types.ts` 的 post-gate runtime 类型中加入该 runtime。
3. 在启动流程中启动它。
4. 在 `signalRuntimeDomain` 的 midnight clear/open rebuild 中 stop/start 它。
5. 在 cleanup 中 stop/drain 它。

启动顺序应调整为：

```text
switchWakeupRuntime.start()
monitorQuoteEventRuntime.start()
periodicSwitchWakeupRuntime.start()
```

理由：`monitorQuoteEventRuntime` 和 `periodicSwitchWakeupRuntime` 都可能产生 pending switch handoff，`switchWakeupRuntime` 必须先成为可接收 owner。

必须删除旧链路：

1. 删除 `src/main/processMonitor/autoSymbolTasks.ts`。
2. 删除或清空后移除 `src/main/processMonitor/index.ts` 和相关 types。
3. 从 `timeDriverProgram` 删除 `processMonitor(...)` 调用和 `monitorTaskQueue` 依赖。
4. 从 `MonitorTaskDataMap` 删除 `AUTO_SYMBOL_TICK`。
5. 从 `monitorTaskProcessor` 删除 `handleAutoSymbolTick` 分支。
6. 删除或改写 `tests/main/processMonitor/autoSymbolTasks.business.test.ts`、`tests/main/processMonitor/index.business.test.ts` 中依赖周期 tick 的测试。

这一步不能保留旧 `AUTO_SYMBOL_TICK`，否则只是新增一个事件入口，同时旧轮询仍在影响业务。

### 3.7 可行性

可行性：中高。

成立原因：

1. 核心业务判断已经在 `autoSymbolManager.maybeSwitchOnInterval(...)` 内，不需要重写状态机。
2. 当前仓库已有 `AutoSearchWakeupRuntime`、`SwitchWakeupRuntime`、`PostTradeConsistencyRuntime`、`OrderHoldRegistry` 等事件端口，可复用同类模式。
3. 阻塞解除所需的两个事实源已经存在：`trader.onOrderHoldSymbolsChanged(...)` 与 `postTradeConsistencyRuntime.onFreshReached(...)`。

主要风险：

1. 交易时长反向解析必须严格复用交易日历语义，否则午休、半日市、跨交易日会触发错误。
2. 启停顺序必须确保 handoff owner 先启动。
3. orderRecorder 阻塞解除没有独立事件，必须以成交后 freshness 作为一致性事件；不能用轮询补洞。

### 3.8 验证要求

必须新增测试：

1. `resolveTradingDurationTargetTimeMs(...)`
   - 09:30 后 30 分钟到 10:00。
   - 11:45 后 30 分钟跨午休到 13:15。
   - 15:45 后 30 分钟跨到下一交易日。
   - 半日市 11:45 后 30 分钟无法在当天解析，应落到后续交易日或在快照不足时返回 `null`。
   - 快照缺失时不返回伪造时间。
2. `PeriodicSwitchWakeupRuntime`
   - start 后 ACTIVE seat 安排 due timer。
   - gate closed 时不触发换标，gate open 后立即推进。
   - due timer 到期时调用 `maybeSwitchOnInterval(...)`。
   - pending 被 `LOCAL_PENDING_ORDER` 阻塞后，order hold removed 事件触发重新推进。
   - pending 被 `ORDER_RECORDER` 阻塞后，freshness reached 事件触发重新推进。
   - WAIT result 被 handoff 给 `SwitchWakeupRuntime`。
   - stop 后清理所有 timer 和 unsubscribe。
3. 删除旧链路后验证：
   - `MonitorTaskDataMap` 不再包含 `AUTO_SYMBOL_TICK`。
   - `timeDriverProgram` 不再依赖 `monitorTaskQueue`。
   - `processMonitor` 不再存在或不再被任何生产代码引用。

---

## 4. 优化三：固定 1 秒 `timeDriverProgram` 主循环改为边界 timer runtime

### 4.1 当前链路

当前 `runApp` 中固定每秒执行 `timeDriverProgram(...)`。这不是普通业务主链路的 owner，但它仍承担系统时间控制平面：

1. 交易日信息缺失时拉取 `marketDataClient.isTradingDay(...)`。
2. 计算 `canTrade` 与 `openProtectionActive`。
3. 调用 `dayLifecycleManager.tick(...)`。
4. 发布 gate state changed 事件。
5. 非连续交易时段或清仓接管窗口开始时清理普通 delayed signals。
6. 执行末日买入截止窗口撤单。
7. 执行末日清仓接管窗口清仓。
8. 当前还驱动周期换标 tick。

第三项优化必须在第二项之后做，因为只要周期换标还依赖 `processMonitor(...)` 每秒调度，`timeDriverProgram` 就不能去掉固定 1 秒循环。

### 4.2 不能采用的错误方案

不能把主循环简单改成“开盘、收盘、15:45、15:55 定几个 timer”。

原因：

1. `dayLifecycleManager` 内部有开盘重建失败和午夜清理失败的指数退避重试时间；当前这个时间只存在闭包变量 `nextRetryAtMs` / `nextMidnightRetryAtMs` 中，外部无法知道下一次应该什么时候 tick。
2. 末日清仓接管窗口内可能在 15:55 之后仍出现新成交持仓。当前每秒调用 `executeClearance(...)` 可以再次看到 `lastState.cachedPositions` 的变化。改成只在 15:55 触发一次会漏掉窗口内后续成交。
3. 交易日信息拉取失败后需要明确 retry timer，不能靠固定 1 秒循环隐式重试，也不能完全不重试。
4. 开盘保护结束、午休、半日市收盘、正常日收盘都是边界事件；边界计算错误会导致普通信号门禁和 delayed signal 清理错误。

### 4.3 正确 owner 设计

新增 `TimeDriverRuntime`，替代 `runApp` 中的固定 `for (;;)`。

建议路径：

```text
src/main/timeDriverRuntime/index.ts
src/main/timeDriverRuntime/types.ts
```

`timeDriverProgram(...)` 应改造成单次执行函数，并返回下一次所需 wakeup 信息，例如：

```text
type TimeDriverRunResult = Readonly<{
  nextWakeupAtMs: number | null;
  wakeupReasons: ReadonlyArray<TimeDriverWakeupReason>;
}>;
```

`dayLifecycleManager.tick(...)` 也必须返回生命周期下一次 wakeup 信息，例如：

```text
type DayLifecycleTickResult = Readonly<{
  nextRetryAtMs: number | null;
}>;
```

这样 `TimeDriverRuntime` 才能用显式 timer 替代固定采样。

### 4.4 必须覆盖的 wakeup 来源

`TimeDriverRuntime` 的 wakeup 来源应只有以下几类：

1. start 后立即执行一次。
2. 香港自然日切换边界。
3. 连续交易时段边界：
   - 09:30 开始。
   - 12:00 上午收市。
   - 正常日 13:00 午盘开始。
   - 正常日 16:00 收市。
   - 半日市 12:00 收市。
4. 开盘保护结束边界：
   - 09:30 + morning open protection minutes。
   - 正常日 13:00 + afternoon open protection minutes。
5. 末日保护边界：
   - 半日市 11:45 / 正常日 15:45 买入截止窗口开始。
   - 半日市 11:55 / 正常日 15:55 清仓接管窗口开始。
   - 收盘窗口结束。
6. `dayLifecycleManager.tick(...)` 返回的重试时间。
7. 交易日信息拉取失败后的显式 retry timer。
8. 清仓接管窗口内的成交后 freshness event。

第 8 点是第三项能否正确成立的关键。清仓接管不是“只在窗口开始做一次”的时间动作，而是“窗口内每次持仓事实变化后都要再次确认是否需要清仓”的业务动作。正确链路应为：

```text
clearance takeover window active
  -> TimeDriverRuntime run doomsday clearance once
  -> order monitor / settlement updates positions
  -> postTradeConsistencyRuntime.onFreshReached(...)
  -> TimeDriverRuntime detects still inside clearance window
  -> run doomsday clearance again with current lastState.cachedPositions
```

这不是兜底轮询，而是订单事实变化后的显式事件唤醒。

### 4.5 时间边界计算

需要新增纯函数解析下一次时间边界，例如：

```text
resolveNextTimeDriverWakeupAtMs({
  now,
  cachedTradingDayInfo,
  openProtectionConfig,
  doomsdayProtectionEnabled,
  lifecycleNextRetryAtMs,
  tradingDayInfoRetryAtMs,
})
```

要求：

1. 所有返回值必须是 UTC 毫秒。
2. 交易日和半日市必须使用 `lastState.cachedTradingDayInfo`。
3. 交易日信息未知时，只能返回交易日信息 retry timer 和自然日边界，不允许假设今天可交易。
4. 开盘保护只在连续交易时段内生效。
5. delayed signal 清理必须发生在 `canTrade true -> false` 的状态转移上，不能只依赖固定时间点；timer 触发后仍以当前时间重新计算真实状态。
6. 清仓接管开始时必须清理普通 delayed signals，并把普通信号链路交给 `ordinarySignalGuard` 阻断。

### 4.6 装配方案

改造后 `runApp` 不再持有固定循环，而是：

```text
const timeDriverRuntime = createTimeDriverRuntime(...)
timeDriverRuntime.start()
await timeDriverRuntime.waitUntilStopped()
```

需要同步调整：

1. `RunAppDeps` 中去掉 `sleep` 作为主循环依赖，或只在其他非主循环测试场景保留。
2. `createCleanup(...)` 纳入 `timeDriverRuntime.stopAndDrain()`。
3. lifecycle midnight clear 时先停止时间 driver 自己的 timer，再停止其他事件 owner，避免停止过程中继续触发新一轮时间动作。
4. open rebuild 成功后重新 start time driver runtime 或让 runtime 在生命周期重建期间持有暂停状态并由 `dayLifecycleManager` 返回 wakeup。推荐前者：停止就是停止，重建成功后由 lifecycle 显式恢复，owner 边界更清晰。

### 4.7 可行性

可行性：中等，但风险高于前两项。

成立条件：

1. 第二项已经移除周期换标 tick。
2. `dayLifecycleManager.tick(...)` 对外暴露下一次 retry 时间。
3. 末日清仓接管窗口内接入 freshness event。
4. 交易日信息失败有明确 retry timer。
5. 所有 session/open-protection/doomsday 边界都有 fake timer 测试覆盖。

不满足这些条件时，不应实施第三项。否则它会从“去掉固定循环”变成“漏掉时间事实或成交事实”。

### 4.8 验证要求

必须新增测试：

1. `TimeDriverRuntime` start 后立即执行一次 `timeDriverProgram`。
2. 非交易时段启动时，下一次 wakeup 指向最近的合法交易边界。
3. 09:30 触发 `canTrade false -> true` 并发布 gate event。
4. 12:00 或 16:00 触发 `canTrade true -> false`，并清理普通 delayed signals。
5. 开盘保护结束时更新 `openProtectionActive`。
6. 15:45 / 11:45 只触发一次买入截止撤单检查。
7. 15:55 / 11:55 触发清仓接管；窗口内 `postTradeConsistencyRuntime.onFreshReached(...)` 再触发清仓确认。
8. `dayLifecycleManager` 开盘重建失败后，下一次 wakeup 等于指数退避 retry 时间。
9. `marketDataClient.isTradingDay(...)` 失败后，只安排显式 retry timer。
10. `runApp` 测试不再断言固定 `sleep(TRADING.INTERVAL_MS)` 主循环。

---

## 5. 推荐实施顺序

### Phase 1：普通信号门禁前置

目标：先消除门禁关闭时无意义的候选生成。

改动范围：

1. `src/main/businessEventProgram/signalPipeline.ts`
2. `tests/main/processMonitor/signalPipeline.business.test.ts`

验收：

1. `bun test tests/main/processMonitor/signalPipeline.business.test.ts`
2. 相关普通信号链路测试通过。

### Phase 2：周期换标 wakeup runtime

目标：删除 `AUTO_SYMBOL_TICK`，让周期换标由 due timer 和订单/freshness/gate/seat 事件推进。

改动范围：

1. `src/utils/time/index.ts`
2. `src/main/periodicSwitchWakeupRuntime/*`
3. `src/app/runtime/createPostGateRuntime.ts`
4. `src/app/types.ts`
5. `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
6. `src/main/timeDriverProgram/index.ts`
7. `src/main/timeDriverProgram/types.ts`
8. `src/main/asyncProgram/monitorTaskProcessor/*`
9. 删除 `src/main/processMonitor/*` 中仅服务 `AUTO_SYMBOL_TICK` 的代码
10. 对应测试

验收：

1. `rg "AUTO_SYMBOL_TICK|scheduleAutoSymbolTasks|processMonitor" src tests` 不应再出现生产路径残留；测试路径只允许迁移说明或删除后的不存在。
2. 周期换标 runtime fake timer 测试覆盖 due/gate/order/freshness/stop。
3. `autoSymbolManager` 现有业务测试继续通过。

### Phase 3：时间控制平面边界 timer 化

目标：移除 `runApp` 固定 1 秒主循环，把生命周期、交易门禁、开盘保护、末日保护改为明确边界 timer 与业务事件唤醒。

改动范围：

1. `src/main/timeDriverRuntime/*`
2. `src/main/timeDriverProgram/index.ts`
3. `src/main/timeDriverProgram/types.ts`
4. `src/main/lifecycle/dayLifecycleManager.ts`
5. `src/main/lifecycle/types.ts`
6. `src/app/runApp.ts`
7. `src/app/types.ts`
8. cleanup/lifecycle runtime 装配
9. 对应 fake timer 测试

验收：

1. `runApp` 中不再存在固定 `for (;;)` + `sleep(TRADING.INTERVAL_MS)` 主循环。
2. `timeDriverProgram` 不再负责周期换标。
3. 生命周期 retry、交易日信息 retry、session 边界、open protection 边界、doomsday 边界全部由显式 wakeup 测试覆盖。
4. 清仓接管窗口内 freshness event 能再次触发清仓确认。

---

## 6. 最终验收命令

每个 phase 完成后都应执行与范围匹配的测试。全部完成后执行：

```powershell
bun run format
bun run lint
bun run type-check
bun test
```

如果 Phase 2 或 Phase 3 涉及删除生产模块，还需要执行：

```powershell
rg "AUTO_SYMBOL_TICK|scheduleAutoSymbolTasks|processMonitor" src tests
rg "TRADING\\.INTERVAL_MS|sleep\\(" src/app src/main tests
```

第二条不是要求完全没有 `sleep` 字符串，而是要求没有顶层固定 1 秒主循环语义残留。

---

## 7. 本方案明确不做的事

1. 不把买入截止窗口强行解释成策略层不生成买入候选；这会改变现有风控边界。
2. 不保留 `AUTO_SYMBOL_TICK` 作为周期换标 runtime 的备用路径。
3. 不新增“事件没来就每秒检查一次”的 fallback。
4. 不把 `TimeDriverRuntime` 做成通用调度框架；它只服务交易日、交易时段、开盘保护、生命周期 retry、末日保护这些时间控制平面事实。
5. 不重写 `autoSymbolManager` 状态机；Phase 2 只替换触发 owner，业务判断继续由状态机负责。

---

## 8. 总结

前三项优化中，第一项是低风险语义收敛，应优先落地。第二项是事件驱动收敛的关键点，完成后周期换标不再依赖每秒 tick。第三项是最终把时间控制平面从固定采样改成边界 timer 的工程收口，但它必须建立在第二项完成、生命周期 retry 对外可见、末日清仓接入 freshness 事件之后，否则会造成漏触发。

推荐顺序是严格的：先做普通信号门禁前置，再做周期换标 wakeup runtime，最后做 `TimeDriverRuntime`。不要跨阶段保留双轨，也不要为了降低短期风险加入轮询兜底。
