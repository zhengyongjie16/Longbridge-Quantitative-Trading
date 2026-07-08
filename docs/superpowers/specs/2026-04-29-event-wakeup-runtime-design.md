# 事件唤醒运行时重构设计

## 背景

当前程序的固定时间主循环位于 `src/app/runApp.ts`，每秒调用一次旧 `timeDriverProgram`。该循环仍承担交易日状态、连续交易时段门禁、开盘保护、交易日生命周期、末日保护和周期换标等时间语义职责。

系统中普通 K 线信号、延迟验证、自动寻标、距离换标、风险监控、订单追踪和成交后刷新已经基本事件驱动化。本次重构只处理时间循环内的剩余逻辑，不改变已有事件链路。

## 目标

- 完全移除每秒主循环。
- 将时间循环内逻辑改为“计算下一时间点 → one-shot timer 唤醒 → 单次权威重评估 → 重新计算下一次唤醒”。
- 保持现有交易业务语义不变。
- 保持开盘保护的最小门禁口径：只阻断普通信号生成，不阻断自动寻标、距离换标、周期换标或风险任务。
- 保持周期换标的交易时段累计时长口径，午休、收盘后、非交易日不计时。

## 非目标

- 不引入统一 EventBus。
- 不重写普通 K 线信号链路。
- 不把自动寻标改回时间扫描。
- 不改变距离换标、风险监控、订单追踪、成交刷新现有事件源。
- 不保留新旧双路径兼容逻辑。
- 不增加会改变交易语义的兜底或降级逻辑。

## 推荐方案

采用统一的 `TimeWakeupRuntime` 作为系统级时间事件 owner。

`TimeWakeupRuntime` 替代 `runApp` 中的无限循环。它只持有一个 one-shot timer，每次 timer 触发后执行一次时间语义评估。评估完成后，根据返回的候选唤醒时间注册下一次 timer。

该方案把全局时间边界集中在一个 owner 中，避免多个 timer 分散计算交易日、午休、半日市、末日保护和生命周期 retry 时产生顺序漂移。

## 架构边界

### `runApp`

- 完成 pre-gate runtime、post-gate runtime、business event program、async runtime、lifecycle runtime 等现有装配。
- 完成运行时装配并注册 cleanup 后，必须启动 `TimeWakeupRuntime.start()`，由它接管系统级时间评估。
- `PeriodicSwitchWakeupRuntime` 是普通业务任务投递 owner，必须跟随 `signalRuntimeDomain` 的普通 runtime 启停边界：初始重建成功后启动，午夜清理时停止并清空 route 状态，开盘重建成功后再启动。即使启动快照处于 `startupRebuildPending` 或初始重建失败导致普通业务 runtime 未启动，也只能启动 `TimeWakeupRuntime` 推进生命周期重建 retry；不能提前启动周期换标 owner。
- 初始重建成功路径中，`PeriodicSwitchWakeupRuntime.start()` 必须先于 `TimeWakeupRuntime.start()` 完成订阅，避免第一次时间评估发布 gate-open 时周期换标 owner 尚未接收事件。初始重建失败或 pending 路径不启动周期换标 owner。
- 不再持有 `for (;;)` 或固定 `TRADING.INTERVAL_MS` sleep；启动完成后显式等待 shutdown signal，不依赖 timer 或订阅隐式维持进程作为生命周期契约。
- `runApp` 是唯一 shutdown owner。信号等待器只负责 resolve shutdown promise，不执行 cleanup、不调用 `process.exit`；cleanup 只能由 `runApp` 收口路径调用一次。`CleanupController` 类型层也必须删除 `registerExitHandlers`，避免保留可被误用的第二个 shutdown 入口。

### `TimeWakeupRuntime`

职责：

- start 时立即请求一次时间评估。
- 持有 one-shot timer。
- 执行中收到重新评估请求时只标记 dirty，当前评估完成后立即再评估一次。
- stopAndDrain 时清理 timer 并等待在途评估完成。
- 捕获评估错误，记录日志，并安排恢复性 retry。

不负责：

- 不直接计算交易许可。
- 不直接修改交易状态。
- 不执行具体交易业务。

### `timeWakeupEvaluationProgram`

旧 `timeDriverProgram` 模块应重命名为 `timeWakeupEvaluationProgram`，从“每秒驱动程序”改为“单次时间唤醒评估器”。它保留当前业务执行顺序，但不再承担调度职责，也不假设外部会持续调用。

职责：

- 读取当前时间和交易日状态。
- 计算连续交易门禁。
- 计算开盘保护状态。
- 驱动交易日生命周期单次评估。
- 处理末日保护窗口进入。
- 计算系统级下一次唤醒计划。
- 不再直接调度周期换标 `AUTO_SYMBOL_TICK`；周期换标由专门的周期换标唤醒 owner 根据计划候选和事件重新投递。

### `timeWakeupPlanner`

纯计算层，负责汇总下一次唤醒候选时间。

输入包括：

- 当前时间。
- 交易日信息。
- 半日市状态。
- 开盘保护配置。
- 生命周期计划。
- 末日保护配置与当日窗口状态。
- 末日保护内部继续推进计划。
- 恢复性 retry 计划。

周期换标到期候选不进入 `timeWakeupPlanner`，避免与周期换标唤醒 owner 形成双时间 owner。

输出包括：

- 候选唤醒时间列表。
- 最早的 `nextWakeupAtMs`。
- 用于日志和测试的候选原因。

### 周期换标计划器

周期换标不再由 `processMonitor` 每秒调度 `AUTO_SYMBOL_TICK`。

新的周期换标唤醒 owner 按 `monitorSymbol + direction` 计算下一次到期时间。计划必须绑定计算时的席位事实：`symbol`、`seatVersion` 与 `lastSeatActivatedAt`。到点后复用现有 `monitorTaskQueue.scheduleLatest` 写入 `AUTO_SYMBOL_TICK`，让现有 `MonitorTaskProcessor` 继续完成席位快照校验、`maybeSwitchOnInterval` 调用，以及真正进入 pending switch 后的 `switchWakeupRuntime.handoffPendingSwitch` 交接。

周期换标等待空仓不是现有 `SwitchDriveResult.kind === 'WAIT'` 语义：当前 `maybeSwitchOnInterval` 在到期但仍有订单或持仓占用时会记录周期 pending 并返回 `NOOP`。因此周期换标唤醒 owner 必须通过 `AutoSymbolManagerPort.getPeriodicSwitchPendingState(direction)` 读取现有周期 pending 状态来记录 waiting-empty 路线，不能把它直接交给现有 `switchWakeupRuntime`，也不能改变 `SwitchDriveResult` 让周期等待空仓混入真实 pending switch 语义。

周期换标到期任务处理完成后必须回写给周期换标唤醒 owner。`MonitorTaskProcessor` 在处理 `AUTO_SYMBOL_TICK` 后，调用 `getPeriodicSwitchPendingState(direction)` 执行三类动作：pending 为 true 时标记 waiting-empty；pending 为 false 且席位基线仍匹配时清除 waiting-empty 并重算下一次到期；任务快照已过期时清除旧基线状态但不得按旧任务继续计划。该回写是替代旧每秒扫描的任务结果闭环，不是兜底轮询。

周期换标等待空仓后的事件闭环由周期换标唤醒 owner 承担。该 owner 订阅订单状态事件与 post-trade consistency freshness 事件，在可能解除本地订单或持仓占用后重新投递同一 `AUTO_SYMBOL_TICK`。seat truth 事件只用于席位激活、清理、版本变化或 `lastSeatActivatedAt` 变化后重新计算下一次周期换标计划，不作为等待空仓状态的新增推进语义。gate-open 事件只用于非 waiting-empty 路线在下一连续交易时段打开后重算计划，恢复旧主循环“下一交易时段再检查”的业务语义；它不得推进 waiting-empty，也不得在 gate-close 或午休中主动重投递。若 seat truth 显示 `symbol`、`seatVersion` 或 `lastSeatActivatedAt` 已变化，旧 timer 与 waiting-empty 路线必须清除，再按新席位事实重算。

## 单次评估执行顺序

每次时间唤醒必须按以下顺序执行。

### 1. 读取当前时间与交易日信息

- 使用香港日期键判断当前港股日。
- 交易日信息缓存必须携带对应的港股日期键。只有缓存 `dateKey` 与当前港股日一致时才允许命中。
- 当前港股日交易日信息缺失或缓存日期不匹配时，调用 `marketDataClient.isTradingDay(now)` 并写入带 `dateKey` 的缓存。
- 查询失败时保持现有失败后重试语义：`isTradingDay = null`，`canTradeNow = false`，并安排下一次时间评估；该 retry 只改变唤醒 owner，不是交易许可兜底或降级路径。
- `tradingCalendarSnapshot` 只能写入带明确日期来源的交易日信息，不能把无日期证明的缓存绑定到当前日期。

### 2. 计算连续交易门禁

- 正常交易日连续交易时段为 09:30-12:00、13:00-16:00。
- 半日交易日连续交易时段为 09:30-12:00。
- `lastState.canTrade` 只由 `isTradingDay && isInContinuousHKSession(now, isHalfDay)` 决定。
- 门禁从开到关时，取消普通延迟验证信号。
- 本步骤只更新门禁状态，不发布 gate event。gate event 必须在生命周期单次评估之后，使用评估前的 `previousCanTrade` 与评估后的 `lastState.canTrade` 比较后发布，保持现有顺序基准。

### 3. 计算开盘保护状态

- 只在 `canTradeNow = true` 时计算。
- 早盘保护从 09:30 起算。
- 午盘保护从 13:00 起算，半日市不计算午盘保护。
- 只更新 `lastState.openProtectionActive`。
- 不关闭 `canTrade`，不阻断自动寻标、周期换标、距离换标或风险任务。

### 4. 驱动生命周期

- 跨日时先执行午夜清理并关闭 `isTradingEnabled`。
- 午夜清理完成后进入 `pendingOpenRebuild`，等待下一次连续交易门禁打开。
- 开盘重建只在 `isTradingDay = true` 且 `canTradeNow = true` 时执行。
- 午夜清理或开盘重建失败时，生命周期返回下一次 retry 时间。
- 开盘重建成功后恢复 `isTradingEnabled`。
- `pendingOpenRebuild = false` 时仍要收敛到 `lifecycleState = ACTIVE` 与 `isTradingEnabled = true`，保持现有状态机语义。
- 生命周期单次评估完成后，才根据 `previousCanTrade` 与当前 `lastState.canTrade` 发布 gate event，保证自动寻标 gate-open 唤醒顺序不漂移。

### 5. 执行末日保护窗口动作

仅当以下条件同时满足时执行：

- `lastState.isTradingEnabled = true`。
- `isTradingDay = true`。
- `canTradeNow = true`。
- 末日保护配置启用。

窗口动作：

- 买入截止窗口进入时，执行买入截止撤单；该撤单动作按港股日记录是否已提交过，避免同一窗口内重复提交撤单请求。
- 清仓接管窗口进入时，先取消普通延迟验证信号，再执行清仓接管。
- 清仓接管不是按港股日 one-shot 的动作。进入窗口后仍要复用现有 `executeClearance` 的即时执行与后续 retry 语义；若因行情缺失或内部等待产生继续推进时间，该时间必须进入下一唤醒候选。若本轮已提交部分清仓信号但仍有缺行情标的需要 retry，`executed` 与 `signalCount` 必须继续反映已提交信号，不能因存在 `nextRetryAtMs` 而改成未执行。
- 清仓接管窗口内，quote/switch 类普通执行门禁保持关闭，避免普通链路与末日清仓竞争。

### 6. 同步周期换标 owner

- 时间评估器不调度周期换标到期任务，只在 gate event 发布后让周期换标唤醒 owner 通过既有 gate-open 订阅获得交易时段重新打开事件。
- 周期换标 owner 对每个开启自动寻标且 `switchIntervalMinutes > 0` 的 `monitorSymbol + direction` 计算下一次周期换标检查时间。
- 该计算结果交给周期换标唤醒 owner 管理，不进入 `timeWakeupPlanner`。
- 到期时写入 `AUTO_SYMBOL_TICK` 任务。
- `AUTO_SYMBOL_TICK` 仍携带 seat version 与 symbol 快照。
- `MonitorTaskProcessor` 处理 `AUTO_SYMBOL_TICK` 后必须把任务结果回写给周期换标 owner；没有这个回写，旧每秒扫描移除后会丢失 NOOP、gate-closed 与 waiting-empty 场景的后续推进来源。
- 如果周期换标进入等待空仓状态，不注册紧密 timer。
- 等待空仓后的闭环为：订单状态事件或 post-trade consistency freshness 事件到达后，由周期换标唤醒 owner 重新投递同一 dedupeKey 的 `AUTO_SYMBOL_TICK`；`MonitorTaskProcessor` 再调用 `maybeSwitchOnInterval` 判断占用是否解除。
- seat truth 只触发周期换标计划重算，不作为等待空仓状态的新增推进唤醒源。
- gate-open 只触发非 waiting-empty 路线重算计划，不作为 waiting-empty 状态的新增推进唤醒源。

### 7. 计算下一次唤醒

评估结束后汇总所有候选时间，取最早且大于当前时间的 `nextWakeupAtMs`。`timeWakeupPlanner` 不得返回等于或早于当前时间的候选；计划类型必须区分“有下一次唤醒”和“无候选”，禁止 `hasWork=false` 仍携带候选或时间。`TimeWakeupRuntime` 遇到 `nextWakeupAtMs <= now` 时不能注册 0ms timer，也不能把它当作 dirty 立即重评估；该结果视为非法计划并转入正延迟恢复性 retry。timer 触发时必须重新读取权威状态，不把上次计划当作交易许可或席位事实。

## 下一唤醒候选时间

### 全局交易时段边界

正常交易日：

- 港股日 00:00。
- 09:30。
- 12:00。
- 13:00。
- 16:00。

半日交易日：

- 港股日 00:00。
- 09:30。
- 12:00。

非交易日：

- 港股日 00:00。
- 下一港股日 00:00 重新解析交易日信息。

### 开盘保护边界

- 早盘保护结束：`09:30 + morning.minutes`。
- 午盘保护结束：`13:00 + afternoon.minutes`。
- 半日市不计算午盘保护。

保护结束只影响 `openProtectionActive`，不触发额外交易动作。

### 生命周期边界

- 午夜清理失败后的 `nextMidnightRetryAtMs`。
- 开盘重建失败后的 `nextOpenRebuildRetryAtMs`。
- `pendingOpenRebuild = true` 时，由单次评估器解析出下一可交易日的首个连续交易开盘点，并以绝对时间传给 planner；planner 不得把当前 `dayKey` 的 09:30 当作默认值。
- 下一开盘点解析必须基于当前时间之后的交易日历事实，当前日 09:30 已过、收盘后、半日市收盘后、非交易日或节假日都必须跳到后续可交易日的首个连续交易开盘点；交易日历不足时不能放行交易，也不能生成基于猜测的开盘候选。
- 下一港股日 00:00。

### 末日保护边界

正常交易日：

- 15:45：买入截止窗口开始。
- 15:55：清仓接管窗口开始。
- 16:00：收盘。

半日交易日：

- 11:45：买入截止窗口开始。
- 11:55：清仓接管窗口开始。
- 12:00：收盘。

### 恢复性 retry 边界

恢复性 retry 分为两类 owner，不能混用：

- 业务评估成功后产生的 retry 是显式候选时间，进入 `timeWakeupPlanner`，并参与与确定性交易边界的最小值比较；它保持现有失败后重试语义，仅改变唤醒 owner，不能作为交易许可兜底或降级路径。
- 单次评估器自身抛错时，本轮没有可靠 planner 输入，由 `TimeWakeupRuntime` 直接安排正延迟恢复唤醒；该路径只负责重新进入权威评估，不能改变交易许可，也不能替代确定性交易边界。

进入 `timeWakeupPlanner` 的业务 retry 候选包括：

- 交易日信息查询失败后的 `recoveryRetryAtMs`。
- 末日清仓接管内部需要继续推进时返回的下一次 retry 时间。

周期换标到期计算缺少交易日历时，由周期换标唤醒 owner 记录等待重算或等待开盘重建补齐，不作为 `timeWakeupPlanner` 的候选输入。

### 周期换标边界

周期换标到期时间必须由交易时段累计时长反推，不能用自然时间直接相加。

计算规则：

- 起点为席位 `lastSeatActivatedAt`。
- `lastSeatActivatedAt` 表示该路线最近一次进入 `ACTIVE` 的时间，不是换标触发时间、`SWITCHING` 开始时间或状态机完成时间。
- 距离换标或周期换标完成后，新标的先进入 `ACTIVATING`；只有 seat refresh 成功推进到 `ACTIVE` 并写入新的 `lastSeatActivatedAt` 后，下一轮周期换标才从该新时间重新计时。
- 目标累计时长为 `switchIntervalMinutes * 60_000`。
- 仅累计交易日连续交易时段。
- 午休、收盘后、非交易日、节假日不计。
- 半日市只累计上午时段。
- 使用与 `calculateTradingDurationMsBetween` 相同的 session range 规则。
- 如果交易日历快照不足以可靠计算，不触发周期换标；由周期换标唤醒 owner 等待 seat truth、gate-open 或开盘重建补齐后的明确事件重算，不注册扫描式 fallback timer。
- 如果计算中的席位基线在 timer 到期前发生变化，旧计算结果失效；runtime 必须重新读取当前 seat truth 后再决定是否投递 `AUTO_SYMBOL_TICK`。

## 状态与去重

### 时间 runtime 重入控制

`TimeWakeupRuntime` 维护：

- `running`。
- 当前 timer handle。
- `inFlight`。
- `dirty`。
- 当前评估 promise 集合。

同一时间只允许一轮评估在途。评估中出现新的唤醒请求时，设置 dirty，评估完成后立即再执行一次。

### 末日保护窗口状态

按港股日维护：

- 买入截止撤单是否已提交。
- 清仓接管窗口是否已经完成进入窗口时的延迟验证清理。
- 清仓接管内部继续推进的下一次 retry 时间。

跨日午夜清理时重置。清仓接管执行本身不按港股日去重，窗口内仍可按现有清仓逻辑和 retry 计划继续推进。

### 周期换标席位基线、任务回写与去重

周期换标唤醒 owner 按路线保存最近一次计划所依据的 `symbol`、`seatVersion` 与 `lastSeatActivatedAt`。席位被距离换标、周期换标、开盘重建或清理流程重新激活后，新的 `lastSeatActivatedAt` 代表新的周期计时起点；旧 timer 和 waiting-empty 状态不得跨基线复用。

`AUTO_SYMBOL_TICK` 处理结果必须带着任务入队时的 `symbol` 与 `seatVersion` 回写。若回写时当前席位基线已变化，runtime 只清理旧路线状态，不按旧任务重算。若基线仍一致，则按周期 pending 状态决定进入 waiting-empty 或重新计算下一次到期。处理失败也只能按当前席位事实重新计划，不能注册额外兜底 timer。

继续使用现有 `monitorTaskQueue.scheduleLatest` 和 dedupeKey：

- `monitorSymbol:AUTO_SYMBOL_TICK:LONG`。
- `monitorSymbol:AUTO_SYMBOL_TICK:SHORT`。

这保持同一方向只处理最新任务，避免到点唤醒和状态事件同时到达时重复推进。

## 错误处理

- 交易日信息查询失败：关闭本次 `canTradeNow`，由单次评估器返回业务 recovery retry 候选。
- 生命周期清理或重建失败：由生命周期状态机记录失败次数并返回 retryAt。
- 周期换标到期计算缺少交易日历：不假设可交易，不触发换标，由周期换标唤醒 owner 等待 seat truth、开盘重建补齐或明确事件后重算；不得注册扫描式 fallback timer。
- 末日清仓接管需要继续推进时：把内部 retry 时间纳入候选唤醒，不把清仓接管压缩为一次性动作。
- 单次评估抛错：`TimeWakeupRuntime` 记录错误并安排正延迟恢复唤醒；该恢复唤醒不进入 planner，也不放行交易。
- 进入 planner 的业务 recovery retry 与确定性时间边界共同取最早值，不能拖后交易时段、开盘保护、末日保护或跨日边界。
- timer 只作为唤醒机制，所有业务动作执行前仍重新校验权威状态。

## 测试验证清单

### Planner 测试

- 非交易日启动时不产生交易窗口动作，并安排下一次评估。
- 交易日前 09:29 启动，下一唤醒为 09:30。
- 正常交易日 11:59 后下一全局边界为 12:00。
- 正常交易日 12:00 后下一全局边界为 13:00。
- 半日市 11:59 后下一全局边界为 12:00，且无 13:00。
- 早盘保护结束时间正确。
- 午盘保护结束时间正确，半日市无午盘保护。
- 正常日末日保护边界为 15:45、15:55、16:00。
- 半日市末日保护边界为 11:45、11:55、12:00。
- 生命周期 retryAt 会成为下一唤醒候选。
- 周期换标到期时间按交易时段累计，午休不累计。

### Runtime 测试

- `start()` 立即评估一次。
- 任意时刻最多一个 timer。
- 执行中重新请求评估只设置 dirty。
- dirty 在当前评估完成后触发第二次评估。
- `stopAndDrain()` 清理 timer 并等待在途评估结束。
- 评估异常后安排恢复性 retry。

### 业务链路测试

- 09:30 gate 打开并发布 gate event。
- 12:00 gate 关闭并取消普通延迟验证。
- 正常日 13:00 gate 重新打开。
- 开盘保护期内 `canTrade = true` 且 `openProtectionActive = true`。
- 保护结束只更新保护状态，不重复开盘重建。
- 15:45 或 11:45 的买入截止撤单按港股日只提交一次。
- 15:55 或 11:55 进入清仓接管窗口时取消普通延迟验证。
- 清仓接管窗口内可按现有 `executeClearance` 语义继续推进和 retry，不被当日 one-shot 标记阻断。
- 跨日 00:00 先执行午夜清理，再等待开盘重建。
- 生命周期失败按 retryAt 唤醒。
- 周期换标到期后仍通过 `AUTO_SYMBOL_TICK` 与现有 processor 执行。
- 周期换标等待空仓后由订单状态事件或 post-trade consistency freshness 事件重新投递 `AUTO_SYMBOL_TICK`，不靠扫描。
- `AUTO_SYMBOL_TICK` 处理后会把周期 pending、非 pending、gate-closed、失败和快照过期结果回写给周期换标 owner，不会让到期后 `NOOP` 路线失去后续计划。
- gate-open 事件只让非 waiting-empty 路线重算计划，不能推进 waiting-empty 路线。
- seat 激活、清理、版本变化和 `lastSeatActivatedAt` 变化触发周期换标计划重算，但不作为等待空仓状态的新增推进唤醒源。
- 距离换标完成并重新进入 ACTIVE 后，周期换标从新的 `lastSeatActivatedAt` 重新计时。
- 周期换标完成并重新进入 ACTIVE 后，下一轮周期换标同样从新的 `lastSeatActivatedAt` 重新计时。

## 实施顺序

1. 为时间计划新增类型与纯函数测试。
2. 调整 `dayLifecycleManager`，让单次评估返回 retry 计划。
3. 将旧 `timeDriverProgram` 重命名为 `timeWakeupEvaluationProgram`，返回下一唤醒计划，同时保持当前业务顺序。
4. 新增 `TimeWakeupRuntime`。
5. 新增周期换标到期反推工具，并接入 `AUTO_SYMBOL_TICK` 调度。
6. 替换 `runApp` 中的无限主循环。
7. 移除 `processMonitor` 的固定循环调度入口。
8. 补齐 runtime、planner、生命周期、周期换标和末日保护测试。
9. 运行 `bun format`、`bun lint`、`bun type-check` 并修复全部问题。

## 设计自检结论

- 无新旧双路径兼容设计。
- 无统一 EventBus 过度设计。
- 未改变普通 K 线信号链路。
- 未改变自动寻标、距离换标、风险监控、订单追踪的现有事件源。
- 周期换标保留交易时段累计时长口径。
- 开盘保护保持最小门禁语义。
- 生命周期失败 retry 不再依赖每秒 tick。
- gate event 发布顺序保留在生命周期评估之后。
- 末日清仓接管保留窗口内继续推进语义，不被 one-shot 去重阻断。
- 周期换标等待空仓只由订单状态与 freshness 闭环重新投递检查任务。
