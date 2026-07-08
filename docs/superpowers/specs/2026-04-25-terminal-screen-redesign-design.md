# 终端 screen 投影重构设计

日期：2026-04-25状态：已复核修正设计

## 目标

把当前运行态终端显示从 `logger.info(...)` 追加式瀑布输出，重构为 `src/screens` 下统一的终端 screen 投影层。终端主屏由 screen runtime 独占，业务事件完成后提交展示 patch，并以事件驱动方式立即刷新固定区域。

本设计以 `docs/plans/2026-04/2026-04-23-tty-dashboard-immediate-refresh-plan.md` 为参考，但按当前要求改为：目录使用 `src/screens`，代码命名保持中性，不出现 `ui`，并完全废弃当前运行态终端追加输出形式。

## 已确认范围

首版采用“行情与席位优先 + 固定账户/持仓区”：

1. 第一行固定显示运行摘要。
2. 第二行固定显示 lifecycle/status 行，用于展示持续状态、等待条件与交易安全门禁。
3. 第三行固定显示账户信息。
4. 第四行起显示持仓区；持仓区有稳定可见上限，超出时显示溢出提示，高度受限时优先降级为摘要。
5. monitor 与 LONG/SHORT 席位作为实时主链路。
6. Events 区纳入首版，但只显示离散错误和关键交易动作，不显示普通 quote/kline 摘要，也不承载持续状态。
7. 非 TTY 不启动 screen，不恢复旧瀑布式终端显示；本地文件日志继续实时写入。
8. 启动过程中的普通日志不保留终端输出，只写本地日志；终端可见内容只保留 screen 投影。OAuth 登录需要用户打开跳转链接或输入验证码时，允许认证 owner 在 screen 接管 stdout 前输出必要登录跳转信息。

## 总体架构

```text
业务事件完成
-> 现有业务 owner / display runtime 完成计算与一致性校验
-> 构造 screen patch
-> src/screens 状态提交
-> screenRuntime 请求 immediate flush
-> renderer 在固定终端坐标局部覆盖
```

新增目录首版只固定必要模块边界：

```text
src/screens/
├── types.ts
├── state.ts
├── runtime.ts
├── scheduler.ts
├── renderer.ts
├── layout.ts
└── builders/
    ├── monitor.ts
    ├── tradingQuote.ts
    ├── accountPositions.ts
    ├── event.ts
    ├── summary.ts
    └── status.ts
```

`commit` 作为 state/runtime 内部提交能力，不要求独立 `commit.ts` 文件；`status.ts`、`format.ts`、`width.ts` 也不在设计阶段强制拆出，只有当实现中出现稳定复用边界或模块职责过重时才独立成文件。

命名规则：

- 不使用 `ui` 作为目录、文件、类型或函数命名。
- 代码命名使用 `screen`、`surface`、`layout`、`renderer`、`patch`、`snapshot` 等中性词。
- 不以 `dashboard` 作为代码命名主词。
- `src/services/marketMonitor` 不继续作为终端渲染出口；其格式化逻辑迁移到 `src/screens/builders/monitor.ts` 与 `src/screens/builders/tradingQuote.ts`。

架构边界：

- screen state 只保存展示事实，不被信号、风控、下单、席位、订阅链路读取。
- `businessEventProgram`、`monitorDisplayRuntime`、`tradingQuoteDisplayRuntime` 保留现有事件驱动与 latest-only collapse 边界。
- `screenRuntime` 是 stdout 主屏唯一 owner。
- 本地文件日志继续实时写入。
- 运行态终端追加输出完全废弃。

迁移约束：

- `marketMonitor.renderMonitorIndicators(...)` 的运行态 stdout 输出调用必须同步删除或替换为 `buildMonitorPatch(...) -> screenRuntime.commit(...)`。
- `marketMonitor.renderTradingQuote(...)` 的运行态 stdout 输出调用必须同步删除或替换为 `buildTradingQuotePatch(...) -> screenRuntime.commit(...)`。
- `displayAccountAndPositions(...)` 的运行态 stdout 输出调用必须同步删除或替换为 `buildAccountPositionsPatch(...) -> screenRuntime.commit(...)`。
- 改造期间不得保留“旧 logger 终端输出 + 新 screen 输出”的并行显示路径。
- 文件日志可以继续实时写入，但文件日志不是终端显示路径，也不能作为 screen state 的数据来源。

## 终端界面

标准布局示例：

```text
Longbridge | HK 09:45:18 | RUNNING | trade ON | session YES
Status | lifecycle ACTIVE | pendingRebuild NO | openProtection OFF | baseline READY | doomsday NORMAL | quoteSub READY
Account | netAssets 312880.20 | totalCash 128420.55 | positionValue 184459.65 | buyPower 128420.55 | currency HKD
Positions | visible 2/5 | value 184459.65
[SEC] 64213.HK HSI Bull 62000 | qty 20000.00 | avail 20000.00 | px 0.086 | mkt 1720.00 | weight 0.55%
[SEC] 64456.HK HSI Bear 59000 | qty 18000.00 | avail 18000.00 | px 0.073 | mkt 1314.00 | weight 0.42%
... more positions: 3

HSI.HK | K 09:45:00 | px 17245.330 | chg +0.38%
  ind EMA20 17210.233 | RSI14 61.284 | MACD 12.331
  LONG  ACTIVE 64213.HK | quote 09:45:17 | px 0.086 | chg +8.86% | dist 12.44% | pnl +420.00 | openBuy 2 | sellOcc NO
  SHORT ACTIVE 64456.HK | quote 09:45:16 | px 0.073 | chg -6.41% | dist 18.02% | pnl -155.00 | openBuy 1 | sellOcc YES

TECH.HK | K 09:45:00 | px 3682.120 | chg -0.21%
  ind EMA20 3688.412 | RSI14 42.177
  LONG  EMPTY | symbol - | quote - | px - | dist - | pnl - | openBuy 0 | sellOcc NO
  SHORT SEARCHING | symbol - | quote - | px - | dist - | pnl - | openBuy 0 | sellOcc NO

Events
09:45:18 ORDER_REJECTED 64213.HK reason=...
09:44:59 ORDER_SUBMITTED BUY 64456.HK qty=...
```

布局规则：

1. 第 1 行是运行摘要，固定显示 `Longbridge`、香港时间、程序状态、生命周期交易开关和连续交易时段门禁。
2. 第 2 行是持续状态行，固定显示权威 `lifecycleState`、`pendingOpenRebuild`、开盘保护、成交后一致性 baseline 状态、末日保护接管状态与 quote 订阅提交状态；这些字段都来自对应 owner 的已提交事实，不由 screen 推断。
3. 第 3 行是账户摘要，固定显示 `netAssets`、`totalCash`、`positionValue`、`buyPower` 和币种；不使用账户模型中不存在的顶层 `available` 字段。
4. 第 4 行起是持仓区；常规高度下显示持仓摘要、最多 10 条可见持仓与溢出提示，高度受限时先压缩为持仓摘要，再减少可见持仓行。
5. monitor 与 LONG/SHORT 席位是实时主链路；高度受限时优先保留 summary、status、account、monitor/seat 主链路、eventsTitle 与 1 条事件行。
6. 每个完整 monitor block 固定 4 行：monitor 行、indicator 行、LONG 席位行、SHORT 席位行。
7. Events 固定在底部，只显示离散错误和关键交易动作；持续状态必须显示在 status 行，不进入 Events ring buffer。
8. 香港时间可以由轻量定时器更新；业务字段必须由事件驱动更新。quote/kline 时间戳表示事实发生时间，不允许由定时器改写。

字段宽度规范：

| 字段 | 宽度 | 对齐 | 小数位 | 示例 | 说明 |
| --- | --: | --- | --: | --- | --- |
| `symbol` | 10 | 左 | - | `64213.HK` | 代码必须完整保留。 |
| `name` | 18 | 左 | - | `HSI Bull 62000` | 名称可截断。 |
| `timestamp` | 8 | 左 | - | `09:45:17` | 固定 `HH:mm:ss`。 |
| `seatState` | 10 | 左 | - | `ACTIVE` | 席位状态。 |
| `lifecycleState` | 20 | 左 | - | `OPEN_REBUILD_FAILED` | 权威生命周期状态，原样来自 lifecycle owner。 |
| `gateState` | 12 | 左 | - | `READY` | 交易安全门禁或等待条件摘要。 |
| `quantity` | 14 | 右 | 2 | `20000.00` | 持仓数量。 |
| `availableQuantity` | 14 | 右 | 2 | `20000.00` | 可用数量。 |
| `quotePrice` | 12 | 右 | 3 | `20000.007` | 行情价格至少容纳 5 位整数与 3 位小数。 |
| `largePrice` | 12 | 右 | 3 | `1000000.880` | 百万级价格完整显示。 |
| `indicatorValue` | 12 | 右 | 3 | `20000.007` | 计算指标按价格口径保留 3 位小数。 |
| `marketValue` | 16 | 右 | 2 | `184459.65` | 账户与持仓市值。 |
| `accountAmount` | 16 | 右 | 2 | `312880.20` | 净资产、总现金、持仓市值与购买力等账户金额。 |
| `weight` | 8 | 右 | 2 | `0.55%` | 持仓占比。 |
| `changePercent` | 9 | 右 | 2 | `+8.86%` | 涨跌幅。 |
| `warrantDistance` | 9 | 右 | 2 | `12.44%` | 距回收价。 |
| `positionPnl` | 13 | 右 | 2 | `+420.00` | 持仓盈亏。 |
| `openBuyOrderCount` | 7 | 右 | 0 | `2` | 当前方向未平买入订单数，来自订单记录器。 |
| `pendingSellOccupied` | 7 | 左 | - | `YES` | 当前方向是否存在待成交卖出占用，来自订单记录器。 |

字段宽度规则：

1. 价格与指标字段统一保留 3 位小数，右对齐并写满字段宽度。
2. `quotePrice` 与 `indicatorValue` 必须完整容纳 `20000.007`；百万级价格必须完整容纳 `1000000.880`。
3. 价格、指标、数量、金额字段在固定宽度区域内不使用千分位分隔符，避免逗号导致列宽随数量级变化。
4. 价格与指标字段的负号计入固定宽度；`-1000000.880` 正好占满 12 列。
5. 百分比字段保留 2 位小数，正数带 `+` 的字段必须把符号计入宽度。
6. 文本字段左对齐；超出宽度时截断，代码字段不截断。
7. 字段实际文本短于宽度时补空格，长于宽度时只允许按字段优先级裁剪低优先级文本，不允许破坏代码、价格、指标、席位状态、距回收价和盈亏。
8. 价格与指标字段的首版数值契约是完整支持 `-1000000.880` 到 `1000000.880`；实现必须用测试覆盖该范围。该契约外的数值不在首版展示范围内，不能通过截断数字、改写为日志、提交 Events patch 或恢复旧终端输出来处理；若后续业务需要更大范围，必须先调整字段宽度契约。

逻辑行身份：

- `summary`：运行摘要行。
- `status`：持续状态与等待条件行。
- `account`：账户摘要行。
- `positionsSummary`：持仓摘要行。
- `positions[0..9]`：常规高度下最多 10 条可见持仓行。
- `positionsMore`：持仓溢出提示行，仅在持仓超过可见数量时占用。
- `monitor:<monitorSymbol>:summary`：单 monitor 摘要行。
- `monitor:<monitorSymbol>:indicators`：单 monitor 指标行。
- `monitor:<monitorSymbol>:seat:LONG`：做多席位行。
- `monitor:<monitorSymbol>:seat:SHORT`：做空席位行。
- `monitorMore`：monitor 溢出提示行，仅在 monitor 数量超过可见数量时占用。
- `eventsTitle`：底部事件区标题行。
- `events[0..N-1]`：底部关键事件行。

逻辑行规则：

1. dirty 粒度以 logical row 为主；field dirty 只用于决定重建哪一行文本，不直接逐字段写 stdout。
2. layout 在当前 `columns` / `rows` 下把 logical row key 映射为终端坐标。
3. resize、monitor 可见集合变化、positions 可见集合变化都会使旧坐标失效，必须触发 full repaint。
4. 普通 quote 事件只标记对应 `monitor:<monitorSymbol>:seat:<direction>` 行。
5. monitor snapshot 事件只标记对应 monitor 的 summary 与 indicators 行。
6. account/positions patch 只标记 `account`、`positionsSummary`、`positions[0..9]` 与 `positionsMore`。
7. status patch 只标记 `status` 行；startup failure、open rebuild waiting、runtime degraded、terminal too small 等持续状态不得写入 Events。
8. event patch 只标记底部 `eventsTitle` 与 `events[0..N-1]` 区域，且每次 event patch 都把当前可见 Events 区作为整体 dirty 区刷新；ring buffer FIFO 淘汰会导致可见事件整体上移，不允许只刷新单条事件行。

窄终端规则：

- 不做复杂多列布局。
- 名称可截断，代码必须保留。
- 优先保留运行摘要、持续状态、账户摘要、monitor 代码/价格、席位状态/价格/距回收价/盈亏/订单占用摘要和关键事件；持仓区在高度受限时优先压缩为摘要。
- Events 区在常规布局中固定保留标题行与 2 条事件行；当终端高度不足以同时容纳账户、持仓、monitor 与 2 条事件行时，Events 保留标题行与 1 条事件行。
- 终端高度不足时先压缩持仓明细为 `positionsSummary`，再减少可见持仓行数，再减少可见 monitor 数量；最终必须保留 summary、status、account、1 个 monitor 摘要、1 个可见 seat 行、eventsTitle 和 1 条事件行。
- 首版支持的最小高度为 7 行；rows=7 时 7 行固定为 summary、status、account、1 个 monitor 摘要、1 个 seat 行、eventsTitle、1 条事件行，不再强制保留完整 4 行 monitor block。低于 7 行时不渲染业务字段，只渲染确定的 `terminal too small: need rows >= 7` 提示帧并保持 stdout owner 不变。该提示帧不是旧输出回退；resize 回升到 rows>=7 时必须触发 full repaint 并恢复业务布局。
- rows=7 只能显示一个 monitor 摘要和一个 seat 行时，选择规则必须稳定且只基于已提交展示事实：先按配置 monitor 顺序选择第一个可见 monitor；在该 monitor 内优先显示 `ACTIVE` 且有持仓盈亏或待成交卖出占用的 seat，其次显示任一 `ACTIVE` seat，再次显示 `SWITCHING` / `ACTIVATING` / `SEARCHING` seat，仍并列时按 `LONG` 优先于 `SHORT`。renderer 不得为了选择 monitor 或 seat 主动读取业务服务。
- rows=7 隐藏其他 seat 时，首版不新增隐藏 seat 风险显式提示，不提供 `hiddenRisk` 归纳字段；交易安全事实仅通过 status 行、可见 seat 的已提交事实、Events 与溢出提示表达，screen 不把隐藏展示事实二次归纳成新的风险语义。
- monitor 过多时显示前 N 个，并通过稳定 logical row key `monitorMore` 显示 `... more monitors: X`。
- 宽度计算使用终端显示 cell 宽度，不使用 JavaScript 字符串长度；ANSI 控制序列不计入字段宽度，CJK 宽字符按实际终端 cell 宽度计算。
- `symbol` 宽度 10 是最小展示宽度，不是截断上限；代码超过 10 列时完整保留，并优先裁剪同一行的名称、长指标列表等低优先级字段。

## 模块职责

### `src/screens/types.ts`

定义 screen 层唯一共享类型：

- `ScreenPatch`：业务 owner 提交的最小展示事实变更，按 `summary`、`status`、`account`、`positions`、`monitor`、`seat`、`event` 区分。
- `ScreenSnapshot`：renderer 读取的不可变展示快照。
- `ScreenRuntime`：只暴露 `start()`、`commit(patch)`、`requestFullRepaint()`、`stopAndRestore()`。
- `ScreenSink`：业务装配层注入给 builder 调用方的提交端口，只包含 `commit(patch)`。

`types.ts` 只放类型，不定义常量、函数、Schema 或运行时代码。

### `src/screens/state.ts`

维护当前 screen 展示态与 dirty 标记：

```text
ScreenState
├── summary
├── status
├── account
├── positions
├── monitors
├── seats
└── events
```

只提供展示态提交与 dirty snapshot 消费能力，不读取业务服务，不拉行情，不访问 Longbridge SDK，不计算信号，不参与风控。

Events state 使用固定容量 ring buffer，首版容量为 20 条，按提交顺序 FIFO 淘汰；renderer 只显示 layout 当前分配到的最后 N 条关键事件。

### 状态投影事实

定义持续状态投影事实；首版由 `builders/status.ts` 构造 patch，不强制独立 `status.ts` 文件。状态投影不读取业务服务：

- `lifecycleState`：权威生命周期状态，原样来自 lifecycle owner。
- `pendingOpenRebuild`：等待开盘重建条件，不能被 screen 改写成新的 lifecycle 状态。
- `openProtectionActive`：开盘保护门禁。
- `postTradeBaseline`：成交后一致性 baseline 状态，只允许 `READY`、`REFRESHING`、`FAILED`。`READY` 来自 `completeRebuildBaseline()` 或 fresh reached 事实；`REFRESHING` 来自成交后刷新需求被记录或刷新进行中；`FAILED` 只能来自一致性运行时不可恢复中止事实。该字段只投影 baseline 可用性，不表达普通刷新重试、可重试失败、暂时等待、screen 写入结果、展示层异常、订阅重投影状态或风险缓存刷新状态。
- `doomsdayMode`：普通状态、拒买窗口或清仓接管窗口。
- `quoteSubscription`：quote 订阅集合最近一次 reconcile/mutation 的提交状态，只表达订阅 owner 已提交的事实。
- `marketDataFreshness`：首版只表达当前 screen 已收到的 quote/kline 展示快照时间戳与展示快照质量摘要。质量只允许 `WAITING`、`READY`、`MISSING`、`INVALID`；`WAITING` 表示尚未收到展示快照，`MISSING` / `INVALID` 必须由 display owner 在处理已提交业务事实时显式提交。该字段不是连接健康、订阅健康、断流检测或 stale 监控，不区分网络层原因，也不因为长时间没有事件自行变化。首版不新增连接探测器，不新增 stale 判定 owner，不由 screen 定时推断行情断流；只有未来已有业务 owner 明确提交 `STALE` 事实时，screen 才能原样投影。订阅或连接异常由对应业务 owner 记录文件日志并在存在离散错误事实时提交 Events。

status patch 由 app/lifecycle/trading gate owner 在状态迁移或门禁事实提交后构造；renderer 只负责显示。

status owner 边界：

- `lifecycleState`、`pendingOpenRebuild` 与 `targetTradingDayKey` 来自 lifecycle owner 或 app startup failure owner；screen 不创造新的生命周期状态名，也不把等待条件写入 Events。
- `canTrade`、`isTradingEnabled` 与 `openProtectionActive` 来自交易时段或生命周期门禁 owner；screen 不自行计算港股交易时段，也不通过定时器推断开盘保护状态。
- `postTradeBaseline` 来自 `postTradeConsistencyRuntime` 的 baseline 可用性事实；screen 不推进 freshness，不等待 screen 后再 mark fresh，不把 screen 写入结果作为 baseline 状态。
- `doomsdayMode` 来自 `timeDriverProgram` / `doomsdayProtection`；screen 不把末日清仓提交写成成交完成。
- `quoteSubscription` 来自 `quoteSubscriptionRuntime` 的 reconcile 或 retain mutation 结果；screen 不直接订阅或退订行情。
- `marketDataFreshness` 来自 `monitorDisplayRuntime` / `tradingQuoteDisplayRuntime` 对展示快照质量的显式提交；screen 不新增轮询，不从缺少事件推断连接断开，不新增首版 stale 或 connection 健康语义。

### `src/screens/runtime.ts`

终端主屏 owner：

- `start()`：TTY 环境进入 alternate screen、隐藏光标、绘制空骨架。
- `commit(patch)`：提交 patch 并请求立即刷新。
- `requestFullRepaint()`：标记全屏 dirty，并通过 scheduler 触发下一轮 full repaint。
- `stopAndRestore()`：显示光标、退出 alternate screen、清理监听。

非 TTY 不启动 runtime，不接管 stdout。

装配层只向业务链路注入 `ScreenSink`，不直接暴露 runtime 实例。TTY 下 `ScreenSink.commit` 连接到 `screenRuntime.commit`；非 TTY 下 `ScreenSink.commit` 是明确的 no-op sink，只丢弃展示 patch，不写 stdout/stderr、不拉数据、不恢复旧日志输出。no-op sink 是展示边界实现，不是业务回退路径。

### `src/screens/scheduler.ts`

管理 immediate flush 的单飞边界：

```text
commit
-> mark dirty
-> requestFlush
-> if idle: schedule microtask flush
-> if rendering: pendingFlush = true
-> after flush: if pendingFlush, flush latest state
```

调度规则：

1. 不按固定频率刷新业务状态。
2. `commit(patch)` 只同步更新内存展示态和 dirty 标记，不同步等待 stdout 写入完成。
3. 空闲状态下，`requestFlush()` 通过 microtask 安排一次 flush，避免业务 owner 被终端 I/O 阻塞。
4. flush 开始时只从当前 screen state 读取最新 dirty snapshot。
5. flush 期间到达的新 patch 只更新最新 state 并标记需要补刷，不得排队旧 frame。
6. 本轮 frame 必须拼接完成后做一次 stdout 写入。
7. 如果 stdout 写入返回 backpressure，scheduler 只保留最新展示态，并在 drain 后触发一次 latest-only flush。
8. 如果 stdout 在 `stopAndRestore()` 前仍未 drain，cleanup 只执行终端恢复序列和资源释放，不补写旧 frame、不输出旧日志、不把 screen 写入失败升级为交易业务失败。

### `src/screens/renderer.ts`

把 dirty snapshot 转成 ANSI frame：

```text
dirty snapshot
-> layout coordinates
-> ANSI cursor/clear/write commands
-> join into one frame
-> stdout writer writes one frame
```

stdout writer 是 `runtime.ts` 注入 scheduler/renderer 的唯一写入适配层；它负责封装 Bun/Node stdout 差异，并向 scheduler 暴露统一结果：`written`、`backpressure`、`drain`。renderer 不直接订阅 drain，也不直接根据 Bun 或 Node stream 细节决策。

renderer 如需记录自身异常，只能调用由 `runtime.ts` 注入的 file log port；renderer、layout 以及后续可能拆出的 format、width 模块不得直接 import `logger`，避免破坏 logger 初始化顺序与 stdout ownership。

规则：

- 每次 flush 合并为一次写入。
- 每个被刷新的 logical row 必须先移动到行首并清除整行，或写满到当前 `columns` 的 cell 宽度，避免短文本覆盖长文本后残留脏字符。
- quote 只刷新对应席位行。
- monitor snapshot 只刷新对应 monitor 行和 indicator 行。
- account/positions 刷新固定账户区与最多 10 行持仓区。
- Events 只刷新底部固定 ring buffer。
- resize 触发 full repaint，但不是常规刷新路径。

### `src/screens/layout.ts`

根据 `columns/rows` 生成坐标：

- 顶部 1 行 summary。
- 第 2 行 status。
- 第 3 行 account。
- 后续为 positionsSummary 与可见 positions 明细；高度受限时可只保留 positionsSummary。
- 中间 monitor/seat 主链路；高度受限时先保留 monitor 摘要与至少 1 个 seat 行。
- 底部固定 events 区。

layout 只做坐标与可见区域分配，不持有业务状态。

### `src/screens/builders/*`

把现有业务完成点的数据转换为 screen patch：

- `builders/monitor.ts`：替代 monitor indicators 日志字符串生成。
- `builders/tradingQuote.ts`：替代 trading quote 日志字符串生成。
- `builders/accountPositions.ts`：替代账户与持仓终端追加输出。
- `builders/event.ts`：只接收错误或关键交易动作，不接收普通 quote/kline 事件。
- `builders/summary.ts`：只生成运行摘要 patch。
- `builders/status.ts`：生成 lifecycle/status patch，原样投影 `lifecycleState`、`pendingOpenRebuild`、post-trade baseline 状态、quote 订阅提交状态与 market data freshness/quality 等等待条件；不得创造 `startupRebuildPending` 这类新业务状态名。

monitor skeleton patch 只用于结构占位，不承载交易判断：monitor summary 行显示 `K - | px - | chg - | data WAITING`；indicator 行显示 `ind -`；席位行按当前 seat truth 显示 `LONG <state> <symbol-or-> | quote WAITING | px - | chg - | dist - | pnl - | openBuy <count> | sellOcc <YES|NO>` 与 `SHORT ...`。`quote WAITING` 表示尚未收到展示快照，不表示行情为空或行情失效；`quote MISSING` 与 `quote INVALID` 只能来自 display owner 对已提交快照事实的显式判断，screen 不自行推断。skeleton 只展示已知状态、订单记录摘要与等待事实，不推断行情、信号或交易决策。

## 数据流

### monitor K 线

主业务链路：

```text
marketDataClient.onCandlestickUpdated
-> businessEventProgram
-> runIndicatorPipeline
-> indicatorCache.push
-> syncSignalSeatState
-> monitorDisplayRuntime.requestRender(enqueue only)
-> runSignalPipeline
```

展示旁路：

```text
monitorDisplayRuntime.requestRender
-> async getQuotes([monitorSymbol])
-> buildMonitorPatch
-> screenRuntime.commit
-> immediate dirty flush
```

`monitorDisplayRuntime.requestRender(...)` 只提交异步展示请求，不被 `await`，也不改变后续信号生成顺序。screen commit、stdout flush、backpressure drain 都不属于交易业务时序，不能作为 `runSignalPipeline(...)`、席位门禁、延迟验证或买卖分流的前置条件，也不能要求显示旁路先于信号流水线完成。

显示 patch 使用已提交 snapshot；信号生成不依赖 screen。首版 monitor 行不展示 `sig`，因为当前 indicator snapshot 不包含权威 signal 字段，真实交易信号是在后续 `runSignalPipeline` 中生成并继续经过席位、门禁、延迟验证与买卖分流。screen 不重新推断 signal，也不把指标快照提示伪装成交易决策结果。

### trading quote

```text
marketDataClient.onQuoteUpdated
-> tradingQuoteDisplayRuntime
-> resolveTradingRiskRoute
-> getQuotes([monitorSymbol])
-> route revalidate
-> buildTradingQuotePatch
-> screenRuntime.commit
-> immediate dirty flush
```

异步后 route 过期时不提交 patch。

### 账户与持仓

```text
startup / open rebuild / post trade consistency
-> cached account + positions ready
-> buildAccountPositionsPatch
-> screenRuntime.commit
-> immediate dirty flush
```

账户/持仓强制接入点：

1. 启动成功并执行初次 `rebuildTradingDayState` 后，使用已提交的 `lastState.cachedAccount`、`lastState.cachedPositions` 与启动快照行情构造 account/positions patch。
2. 开盘重建完成后，使用重建后的缓存与行情构造 account/positions patch。
3. `postTradeConsistencyRuntime` 在 `cachedAccount` 或 `cachedPositions` 任一缓存提交完成点必须构造 account/positions patch；不能只依赖 `rebuildTradingDayState` 的展示调用，也不能只覆盖 positions refresh 而漏掉 account-only refresh。
4. post-trade consistency 必须新增独立的非阻塞 screen patch hook，例如 `onAccountPositionsCommitted`；该 hook 不复用当前 `onPositionsCommitted` 的订阅重投影职责，不改变 `reconcilePositionHoldFromCurrentTruth()` 的执行时序。
5. screen patch hook 不得被 `await` 作为 freshness、订阅重投影、风险缓存刷新、保护性清仓完成判定的前置条件；它只提交展示事实。若 hook 内部需要异步写 screen，只能自行 fire-and-forget 并把失败写入文件日志，不能让 post-trade consistency 等待 screen。
6. post-trade consistency 已有的持仓提交事件可以继续服务订阅重投影，但 screen 不改变 freshness、订阅重投影、风险缓存刷新或保护性清仓完成判定。

screen 不主动轮询账户，也不替代账户缓存。

### 关键事件

```text
order submit / order filled / protective liquidation completed / doomsday clearance / lifecycle error / runtime error
-> buildScreenEventPatch
-> screenRuntime.commit
-> bottom events dirty flush
```

Events 是离散事件摘要，不是完整日志，也不是持续状态区；完整本地文件日志继续实时写入。

关键事件来源规则：

- Events patch 必须由既有业务 owner 的完成点、失败点或离散动作边界显式提交。
- 持续状态迁移只更新 `status` 行；不得依赖 Events ring buffer 承载 startup failure、open rebuild waiting、runtime degraded 或 terminal too small。
- 事件类型必须显式区分 `ORDER_SUBMITTED`、`BUY_FILLED`、`SELL_FILLED`、`ORDER_REJECTED`、`PROTECTIVE_LIQUIDATION_TRIGGERED`、`PROTECTIVE_LIQUIDATION_SUBMITTED`、`PROTECTIVE_LIQUIDATION_COMPLETED`、`DOOMSDAY_CLEARANCE_SUBMITTED`、`DOOMSDAY_CLEARANCE_FILLED`、`LIFECYCLE_ERROR`、`RUNTIME_ERROR`。`BUY_FILLED` / `SELL_FILLED` 表达普通买入或卖出订单成交方向；保护性清仓和末日清仓仍使用各自专属事件类型，不复用普通成交事件表达清仓完成。
- 保护性清仓的 `COMPLETED` 只能来自 post-trade consistency 确认方向已空仓且不存在待成交保护性卖单之后；卖单提交或成交不得被写成保护性清仓完成。
- 末日清仓提交成功只生成 `DOOMSDAY_CLEARANCE_SUBMITTED`；若后续订单监控确认末日清仓卖单成交，才允许生成 `DOOMSDAY_CLEARANCE_FILLED`。`DoomsdayProtection.executeClearance(...)` 返回的 `executed=true` 只表示清仓信号已提交，不表示订单已成交。
- 末日清仓必须使用 `DOOMSDAY_CLEARANCE_*` 类型，不得写成保护性清仓事件。
- renderer 不得根据屏幕文本推断事件。
- screen 不得从 logger 文本回收事件。
- 普通 quote/kline 事件不进入 Events。

## 生命周期接入矩阵

| 生命周期点 | screen 行为 | 禁止事项 |
| --- | --- | --- |
| startup success | 初次 `rebuildTradingDayState` 完成后提交 summary、status、account、positions、monitor skeleton patch，然后启动实时 display runtime。 | 不在 screen 启动前输出运行态瀑布日志。 |
| startup failure | TTY screen 模式下，output mode 与 file-only logger 必须已经在首次日志前确定，screen runtime 必须已接管 stdout；app 启动装配层随后提交首帧 summary 与 status，status 必须原样显示 `lifecycleState=OPEN_REBUILD_FAILED`；若存在明确启动失败错误事实，再提交一条最小 `LIFECYCLE_ERROR` 事件。 | 不恢复旧 logger 终端输出；不让 screen 主动拉数据补齐；不通过定时器刷新业务等待状态；不在 terminal 恢复前向 stdout/stderr 输出失败摘要；不为缺少明确错误对象的失败路径强行构造复杂 event payload；不从失败文本派生新的失败分类语义。 |
| pendingOpenRebuild | lifecycle owner 提交 status patch，原样显示 `pendingOpenRebuild=YES` 与目标交易日等待条件；仅当存在独立错误事实时才提交 Events。 | 不把等待条件改写成业务状态；不把等待本身写入 Events。 |
| open rebuild | 重建完成后提交 status、account/positions、seat 状态和 monitor skeleton patch，并触发 full repaint。 | 不在重建未完成前展示可交易态；不把 `OPEN_REBUILDING`、`OPEN_REBUILD_FAILED` 与 `pendingOpenRebuild` 混成同一文案。 |
| post-trade consistency refresh | `cachedAccount` / `cachedPositions` 提交完成后提交 account/positions patch；freshness、订阅重投影和风险缓存刷新仍由原 owner 负责。 | 不由 screen 推进 freshness 或订阅。 |
| runtime error | 对应 owner 记录本地文件日志，并提交关键 Events patch。 | 不由 renderer 捕获普通日志文本生成事件。 |
| cleanup / Ctrl+C | 先停止业务事件来源与 display runtime，再调用注入 `createCleanup` 的 `screenRuntime.stopAndRestore()` 恢复终端光标和主屏，最后允许退出流程完成。`CleanupContext` 必须显式表达 screen restore 依赖，使恢复顺序可测试。 | 不在 terminal 未恢复时向 stdout/stderr 写退出摘要；cleanup 失败记录进入文件日志，不穿透未恢复的 screen。 |

## 输出权责

运行态输出分成两条通道：

```text
终端实时显示：src/screens/runtime.ts 独占 stdout 主屏
本地文件日志：logger 继续实时写入文件
```

废弃以下运行态终端显示路径：

- `marketMonitor.renderMonitorIndicators(...) -> logger.info(...)`
- `marketMonitor.renderTradingQuote(...) -> logger.info(...)`
- `displayAccountAndPositions(...) -> logger.info(...)`

screen 启动前后的普通启动日志、配置加载日志、运行时摘要和运行态 `logger.info(...)` 都不再向 stdout/stderr 追加；这些内容只进入本地文件日志。终端可见内容只保留 `src/screens` 投影；`warn/error` 不直接打破主屏，关键错误通过 `builders/event.ts` 写入 Events 区，持续状态通过 `builders/status.ts` 写入 status 行。

唯一允许的非 screen 终端输出例外是 OAuth 登录交互：当 Longbridge 认证流程需要用户打开授权 URL、复制验证码或完成浏览器跳转时，认证 owner 可以输出最小必要登录跳转信息。该 owner 必须落在 Longbridge 认证装配点，而不是通用 logger；实施时需要把当前 `createPreGateRuntime` 中通过 `logger.info` 输出授权 URL 的路径改为认证专用输出端口。该例外只服务人工认证交互，不允许复用为启动日志、运行态日志或错误摘要输出通道。

OAuth 认证交互仅允许发生在 screen `start()` 之前；screen 已进入 alternate screen 后不得穿透主屏输出认证提示。运行中重新认证不属于首版 screen 契约，需要另行设计，不能在 screen 接管期间混写 OAuth 文本。

logger console stream 规则：

1. TTY screen 模式必须禁用 logger console stream，只保留 file stream 实时写入；本方案不保留任何运行态 stdout/stderr 瀑布日志模式。
2. 非 TTY 模式不启动 screen，也不恢复旧运行态瀑布显示；是否输出最小进程级启动失败/退出摘要属于独立可观测性策略，不作为本 screen 首版契约。
3. logger console stream 的接管必须发生在首次运行态日志写入之前，不能在 logger 已经写入 stdout/stderr 后再补丁式切断。
4. app 启动入口是 output mode 判定 owner；不得由 `src/screens` 反向配置 logger，也不得让业务模块自行决定 console stream。
5. output mode 必须在任何会初始化 logger stream 的模块写入日志前确定。TTY screen 模式下，生产 logger 必须以 file-only 形态创建或初始化；不得先创建 console+file logger，再在 screen start 前移除 console stream。当前 `logger` 模块固定 multistream 的实现必须作为首批改造对象，而不是在 `src/screens` 内部绕过。业务模块只能拿到已按 output mode 初始化完成的 logger 或 file log port，不能直接 import 后触发固定 stdout/stderr stream。
6. app 装配 `createCleanup` 时必须确保 screen runtime 能在进程退出前恢复 terminal；具体依赖注入形态属于实现计划，不在本设计中固定为唯一形式。
7. OAuth 登录跳转信息是唯一认证交互例外；该输出必须限定在 Longbridge 认证 owner，且只能通过认证专用输出端口在 screen 接管 stdout 前输出授权 URL、验证码提示或浏览器跳转说明等人工登录所需信息。运行中重新认证不属于首版 screen 契约；OAuth 输出不得复用通用 logger。
8. 关键错误由对应业务 owner 同时写本地文件日志并提交 Events patch；Events 不是完整日志替代品。
9. terminal 恢复完成前，cleanup 不得向 stdout/stderr 写退出摘要。
10. 如需在 terminal 恢复后展示退出摘要，其 owner 必须是 cleanup 流程，且不能恢复运行态瀑布日志。

## 非 TTY 行为

```text
stdout 是 TTY
-> resolveOutputMode
-> initializeLogger(file-only logger mode)
-> 如需 OAuth 登录且 screen 尚未启动，先由认证 owner 输出最小必要登录跳转信息
-> 启动 screenRuntime 并进入 alternate screen
-> 执行启动快照、重建与 screen 首帧提交
-> 若 startup failure，提交 summary/status 首帧；存在明确错误事实时提交首帧显示所需的最小 LIFECYCLE_ERROR，不派生失败分类语义，并保持 terminal owner 到 cleanup
-> 固定区域实时刷新

stdout 非 TTY
-> resolveOutputMode
-> 不启动 screenRuntime
-> 不进入 alternate screen
-> 不恢复旧瀑布式终端显示
-> 保留本地文件日志实时写入
-> 不新增运行态 stdout/stderr screen 替代分支
```

非 TTY 行为不是回退到旧终端输出，而是明确不启用 screen；不得新建非 TTY stdout/stderr 运行态显示分支。普通运行态日志只进入本地文件日志。必要启动失败、退出摘要或进程级 stderr 可观测性属于独立策略，不作为本 screen 首版契约。若未来允许 screen start 后 `runApp` 抛出并由最外层进程级策略输出摘要，必须先恢复 terminal 再输出。OAuth 登录交互仍允许认证 owner 输出最小必要登录跳转信息，因为该输出是人工认证步骤，不是运行态终端显示路径。

## 错误与 I/O 边界

screen 是显示 side effect，不改变交易业务结果：

- `commit(patch)` 不阻塞业务链路等待 stdout。
- flush 中有新 patch 到达，只保留最新展示态。
- stdout 写入忙时，scheduler 标记 pending，等待可写时补刷最新状态。
- drain 只用于恢复 screen 自身最新帧，不触发业务重算、不提交业务 patch、不恢复旧终端输出。
- renderer 错误通过注入式 file log port 写本地文件日志，并标记下一轮 full repaint；renderer 不直接 import logger。
- 退出时恢复光标、退出 alternate screen、清理 resize/drain 监听。

这些是终端 I/O 边界保护，不是业务兜底路径，也不改变交易事实。

## 禁止事项

- 禁止从日志文本解析 screen state。
- 禁止 screen 主动拉行情、拉账户、重建席位 truth。
- 禁止 fixed interval 轮询业务状态刷新屏幕。
- 禁止保留旧 `logger.info` 瀑布终端输出作为并行显示。
- 禁止 quote 事件同时刷新 LONG/SHORT 双边。
- 禁止 screen state 被信号、风控、下单、订阅链路读取。
- 禁止为了首版引入 Ink/React/blessed/terminal-kit/Web server。
- 禁止以 `ui` 命名目录、文件、类型或函数。

## TypeScript 工程约束

- `src/screens/types.ts` 只定义类型和接口；运行时代码放在其他模块。
- `src/screens/utils.ts` 不作为首版文件；若后续确需工具函数，必须只放纯工具函数且类型从 `types.ts` 引入。
- `src/screens/builders/*` 只把业务完成点数据转换成 `ScreenPatch`，不读取 Longbridge SDK、不写 stdout/stderr、不写 logger 终端流。
- `src/screens/runtime.ts` 是唯一 stdout owner；其他 screen 模块不得直接写 stdout/stderr。
- 依赖方向固定为：业务装配层注入 `ScreenSink`，display runtime 调用 builders 生成 patch，patch 提交到 sink；`src/screens` 不反向 import app/main/core/services 的业务 runtime。
- 导出使用具名导出，不使用 default export，不做 re-export barrel。
- 测试文件放在根目录 `tests/screens/` 下，并与 `src/screens/` 模块结构对应。
- 新增 TypeScript 代码必须强制遵守 `typescript-project-specifications`：工厂函数与依赖注入、`readonly` 数据、无 `any`、无无理由断言、无 re-export、无 default export、`types.ts` 只放类型、测试放在根目录 `tests/screens/` 对应结构下。
- 实际实现完成后必须按顺序运行并通过 `bun format`、`bun lint`、`bun type-check`。

## 测试验证

### renderer 测试

- full repaint 会清屏并绘制固定骨架。
- 数字变短不会残留旧字符。
- status 行固定在 summary 行下一行，并覆盖 `postTradeBaseline=READY/REFRESHING/FAILED`、早盘/午盘开盘保护事实与 market data `WAITING/READY/MISSING/INVALID` 质量。
- account 行固定在 status 行下一行。
- positions 常规高度下最多 10 行，超出显示 `... more positions: X`；高度受限时可压缩为 `positionsSummary`。
- quote 只刷新对应席位行。
- Events 只显示离散错误和关键交易动作，不显示持续状态。
- 价格、百万级价格与指标字段按 12 列宽完整显示。
- 价格与指标字段完整覆盖 `-1000000.880` 到 `1000000.880`；该契约外数值不通过截断数字、写日志、提交 Events patch 或旧终端输出处理。
- rows=7 时固定渲染 summary、status、account、1 个 monitor 摘要、按稳定优先级选择的 1 个 seat 行、eventsTitle 和 1 条事件行；终端高度低于 7 行时只渲染 `terminal too small: need rows >= 7` 提示帧。
- CJK 名称截断按显示 cell 宽度计算，不按字符串长度截断；测试口径固定为 ambiguous-width 字符按 1 cell 计算，CJK wide/fullwidth 字符按 2 cells 计算。

### scheduler 测试

- commit 后空闲通过 microtask 安排 flush，不同步等待 stdout 写入完成。
- flush 中再次 commit 不重入，只置 pending。
- flush 结束后补刷最新状态。
- 多个 patch 合并后单次 flush 只写一次 frame。
- stdout backpressure 期间继续到达的 patch 只保留最新展示态，drain 后只补刷一次 latest state。

### builder 测试

- monitor snapshot 转 screen patch，不写 logger。
- trading quote route 当前时生成席位 patch。
- route stale 时不生成 patch。
- account/positions 生成账户行、持仓摘要与常规高度下最多 10 行持仓 patch。
- account-only refresh 与 positions refresh 都会生成 account/positions patch。
- summary 只生成运行摘要；status builder 原样投影 lifecycle state、等待条件、post-trade baseline 状态、quote 订阅提交状态与 market data freshness/quality，不由 renderer 推断。
- monitor patch 不包含 `sig` 字段，screen 不从 indicator snapshot 推断交易信号。
- 普通买入成交、普通卖出成交、保护性清仓、末日清仓分别生成独立事件类型；普通买卖成交使用 `BUY_FILLED` / `SELL_FILLED`，不使用泛化 `ORDER_FILLED`。
- 保护性清仓提交或成交不得生成 `PROTECTIVE_LIQUIDATION_COMPLETED`；完成事件只能来自 post-trade consistency 确认空仓且无待成交保护性卖单后的业务事实。
- 末日清仓提交成功必须生成 `DOOMSDAY_CLEARANCE_SUBMITTED`；订单监控确认成交后才允许生成 `DOOMSDAY_CLEARANCE_FILLED`；不得生成保护性清仓事件。
- 普通 quote/kline 不进入 Events。

### 集成验证

- `monitorDisplayRuntime` 不再调用 `marketMonitor.renderMonitorIndicators(...)` 打终端日志。
- `tradingQuoteDisplayRuntime` 不再通过 `marketMonitor.renderTradingQuote(...)` 打终端日志。
- 启动过程普通日志、账户/持仓展示和运行时摘要不再追加 stdout/stderr，只写本地文件日志或 screen patch。
- OAuth 登录场景允许认证 owner 输出最小必要登录跳转信息，并禁止复用为普通启动日志通道。
- `postTradeConsistencyRuntime` 在 `runRefresh` 成功刷新分支中，于 account 或 positions 缓存提交后、`refreshOk` 判定不被 screen 依赖的边界上，通过独立 screen hook 触发 account/positions patch。
- screen hook 不复用 `onPositionsCommitted` 的订阅重投影职责，不改变 freshness、订阅重投影和风险缓存刷新时序。
- monitor patch 不包含 `sig` 字段，screen 不展示后续 `runSignalPipeline` 才形成的交易决策结果。
- startup failure 原样显示 `lifecycleState`；存在明确错误事实时提交最小 `LIFECYCLE_ERROR`；pendingOpenRebuild 原样显示等待条件且不把等待本身写入 Events；两者都不启动旧终端输出路径。
- cleanup / Ctrl+C 会先停止事件来源与 display runtime，再恢复 terminal。
- screen 启动后 stdout 只由 `screenRuntime` 写入。
- TTY screen 模式下 logger console stream 被禁用，file stream 仍实时写入；非 TTY 不启动 screen 且不恢复旧瀑布输出。
- renderer 通过注入式 file log port 写自身异常，不直接 import logger。
- 非 TTY 不启动 screen，`ScreenSink.commit` 为 no-op，且不新增运行态 stdout/stderr screen 替代分支。
- 本地文件日志仍实时写入。
- Ctrl+C 后终端恢复正常。

## 完成定义

首版完成必须同时满足：

1. 所有运行态终端显示均通过 `src/screens` 的 screen patch 与 renderer 输出。
2. 旧 `marketMonitor.render* -> logger` 和 `displayAccountAndPositions -> logger` 终端显示路径不再存在。
3. monitor、trading quote、account/positions、status、Events 五类 patch 均有测试覆盖。
4. startup success、startup failure、pendingOpenRebuild、open rebuild、post-trade consistency refresh、runtime error、cleanup 七类生命周期点均有明确接入或测试替身验证。
5. logger file stream 实时写入保留；TTY screen 模式下 console stream 不写 stdout/stderr，且 logger console stream 在首次运行态日志写入前已按 output mode 接管。
6. 启动期普通日志不保留终端输出；OAuth 登录跳转信息是唯一允许的认证交互例外，且只能在 screen 接管 stdout 前输出。
7. renderer 对 logical row key、resize full repaint、字段超宽、CJK 宽度、rows=7 布局、低于最小高度、Events 高度不足都有确定行为。
8. `monitorMore`、`positionsMore`、Events ring buffer 容量、Events 全区 dirty 刷新与 monitor skeleton 文案都有固定实现口径。
9. 非 TTY 通过 no-op `ScreenSink` 丢弃展示 patch，不恢复旧输出，也不新增运行态 stdout/stderr screen 替代分支。
10. Events 测试覆盖普通买入成交、普通卖出成交、保护性清仓和末日清仓的类型区分，并验证保护性清仓完成事件只能来自 post-trade consistency 完成确认。
11. post-trade consistency 的 screen hook 独立于订阅重投影 hook，且覆盖 account-only refresh 与 positions refresh。
12. 所有新增 TypeScript 模块遵守 `typescript-project-specifications`。
13. 实现后通过 `bun format`、`bun lint`、`bun type-check`。
