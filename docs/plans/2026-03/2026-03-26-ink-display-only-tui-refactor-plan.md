# 2026-03-26 Ink 只读展示型 TUI 重构方案

> 状态：rechecked  
> 目标：在不引入 Node 作为运行时基座的前提下，评估并落地 `Ink` 只读展示型 TUI；不提供聊天输入框，不改变交易业务逻辑。

## 1. 文档目的

本文档用于把“为当前量化交易程序接入 Ink TUI”这件事，收敛为一份经过再次校验、与现有代码事实一致、且不偏离交易业务语义的实施方案。

本文只回答三件事：

1. `bun-only + Ink` 在当前仓库里是否可以作为目标方向。
2. 如果可以，正确的接入边界是什么。
3. 为了不破坏现有交易、风控、生命周期与恢复语义，哪些工程约束必须先冻结。

## 2. 重新校验后的最终结论

重新校验后，结论不是“当前方案已经可以直接开做”，而是：

1. 目标方向可以保留，但必须先经过 `bun + Ink` 的兼容性闸门验证。
2. 只读展示型 TUI 的定位是正确的，聊天输入框、命令模式、焦点导航都应明确排除。
3. TUI 必须作为独立展示层接入，不能侵入或重排现有交易主链路。
4. 当前文档原先对“启动时机”“可观察性缺口”“logger 退出方式”的表述不够准确，已经在本版修正。

因此，本次重构的正确目标是：

`Bun 下运行的只读展示型交易驾驶舱`

但其成立前提不是“默认认为 Ink 在 Bun 下没问题”，而是：

`先通过最小兼容性验证，再进入正式重构`

## 3. 需求边界冻结

### 3.1 在范围内

1. 使用 `Ink` 渲染终端 UI。
2. UI 仅作只读展示，不提供聊天输入框。
3. 实时展示账户、持仓、生命周期、交易门禁、关键异步运行态。
4. 每组监控标的在独立区块展示监控标的 K 线和当前策略相关指标。
5. 每组标的中的 LONG / SHORT 席位各占一行。
6. LONG / SHORT 两行的行情与持仓字段口径必须对齐当前 `marketMonitor` 展示口径。
7. 底部只保留单条最新状态摘要，不做瀑布式事件墙。
8. 保留文件日志用于审计和排障。
9. 启动方式仍然保持 `bun start`。

### 3.2 不在范围内

1. 聊天输入框。
2. 命令模式。
3. 复杂热键交互。
4. 运行时切换到 `node`。
5. 改写交易业务规则。
6. 为 TUI 重新发明一套行情、指标、浮亏、席位展示口径。
7. 长期维持“控制台日志展示”和“TUI 展示”两套业务主输出路径并行。

## 4. 已核实的当前代码事实

### 4.1 当前薄入口与启动顺序

当前入口链路是：

```text
src/index.ts
-> app/runApp.ts
-> createPreGateRuntime()
-> createPostGateRuntime()
-> startup snapshot / monitor contexts / async runtime
-> 主循环
```

这意味着：

1. 如果 TUI 只在 `createPreGateRuntime()` 之后再挂载，则启动前阶段的状态不会进入 TUI。
2. `OAuth URL`、配置校验、startup gate 等前置阶段不能再被当作“主循环后的附属信息”。

### 4.2 pre-gate 阶段已经有大量业务可见输出

当前 `createPreGateRuntime()` 与配置校验链路已经会输出：

1. 配置校验结果。
2. Longbridge OAuth 授权 URL。
3. startup gate 策略与等待状态。
4. 交易日信息获取失败告警。

因此，正确的 TUI 启动时机应当早于 `createPreGateRuntime()` 的业务可见输出，而不是晚于它。

### 4.3 当前程序的业务可见输出仍由 logger 主导

当前控制台输出仍由 `logger` 主导：

1. `src/utils/logger/index.ts` 中存在 console stream，直接写入 `process.stdout / process.stderr`。
2. `src/services/accountDisplay/index.ts` 通过 `logger.info` 输出账户和持仓。
3. `src/services/marketMonitor/index.ts` 通过 `logger.info / logger.warn` 输出监控标的、LONG/SHORT 行情和指标。
4. `mainProgram`、`pre-gate`、生命周期、风控与订单链路广泛依赖 logger 输出状态。

因此，仓库当前没有独立 UI 层，只有“业务日志层”。

### 4.4 当前仓库没有真正落地的 TUI 模块

`src/utils/tui/` 当前为空目录，`src/tui/` 也不存在现成实现，因此不能假设仓库已有可复用 TUI 基础设施。

### 4.5 当前运行时已经具备一批可直接读取的状态源

以下状态源已经存在，不需要为了 TUI 先重写业务系统：

1. `createPostGateRuntime()` 已集中创建 `lastState`、`monitorContexts`、`refreshGate`、`marketMonitor`、`indicatorCache`、`buyTaskQueue`、`sellTaskQueue`、`monitorTaskQueue`、`trader`。
2. `MarketDataClient.getCandlestickSnapshot()` 已可直接读取监控标的本地 K 线缓存快照。
3. `MonitorState` 已包含：
   - `signal`
   - `pendingDelayedSignals`
   - `monitorValues`
   - `lastMonitorSnapshot`
   - `lastCandlestickCacheVersion`
4. `RefreshGate` 已提供 `getStatus()`。
5. `DelayedSignalVerifierPort` 已提供 `getPendingCount()`。

因此，“TUI 完全没有状态可读”这个判断不成立；真实情况是：

`已有一部分状态源，但缺少统一展示快照与少量运行态只读接口`

### 4.6 当前工程配置还不支持直接引入 React / Ink TSX 页面

当前 `package.json` 与 `tsconfig.json` 存在客观约束：

1. 尚未安装 `react`、`ink` 及其类型依赖。
2. `tsconfig.json` 尚未配置 JSX 编译选项。
3. 仓库当前没有 `.tsx` 文件。

因此，如果不先补齐 React / TSX 工程基线，`bun type-check` 无法通过。

### 4.7 `src/index.ts` 的 import 边界限制仍然成立

`eslint.config.js` 对 `src/index.ts` 的 import 边界仍有限制，目前允许其直接依赖的 app 入口仍以 `./app/runApp.js` 为主。

因此，本次重构不应让 `src/index.ts` 直接 import `src/tui/**`，而应保持：

```text
src/index.ts
-> runApp
-> app 层统一装配 TUI 与 business runtime
```

## 5. 对业务逻辑的硬约束

本方案必须保证以下业务语义不变：

1. `mainProgram` 的每拍调度顺序不变。
2. `processMonitor` 中自动寻标、席位同步、风险任务、指标流水线、信号流水线的顺序不变。
3. 买卖任务队列仍保持现有入队/出队语义，不因展示需要改变消费时机。
4. `RefreshGate` 的 `markStale -> waitForFresh -> markFresh` 版本语义不变。
5. `PostTradeRefresher` 对账户、持仓、浮亏与保护性清仓完成确认的流程不变。
6. `OrderMonitor` 的恢复严格模式、终态结算、待成交卖出占用与保护性清仓在途判断不变。
7. 席位状态机与席位版本校验不变。
8. 延迟验证、风险检查、保护性清仓、末日保护、自动换标等业务判断只允许“被展示”，不允许“为展示改写”。

换句话说，TUI 只能：

1. 读取现有状态。
2. 订阅非阻塞事件。
3. 渲染只读画面。

TUI 不能：

1. 成为新的业务判断入口。
2. 引入会反向影响交易链路的同步等待。
3. 让展示层异常向业务层传播。

## 6. 对上一版方案的关键修正

### 6.1 不是“直接进入 Ink 重构”，而是先过兼容性闸门

上一版把 `bun-only + Ink` 当作已成立前提，这是不严谨的。

修正后要求：

1. 先在当前仓库执行最小 `bun + react + ink` smoke test。
2. 验证通过后，才进入正式重构。
3. 若 smoke test 不通过，则本次方案判定为“不满足前提”，应停止，而不是继续侵入业务代码。

这里不是备选方案，而是前置闸门。

### 6.2 TUI 启动时机必须前移到 pre-gate 之前

上一版隐含地把 TUI 理解成“主循环展示层”，这是不完整的。

修正后要求：

1. TUI shell 必须在 `runApp()` 进入 `createPreGateRuntime()` 之前就完成挂载。
2. pre-gate 阶段状态必须可进入 TUI store。
3. startup gate / OAuth / 配置校验等必须有 TUI 可见状态。

否则“控制台不再作为业务主输出路径”这条无法成立。

### 6.3 先复用现有状态源，只补最少缺口

上一版把“可观察性接口缺口”写得过重，容易把方案引向过度改造。

修正后原则：

1. 优先读取 `lastState`、`monitorContext.state`、`refreshGate.getStatus()`、`MarketDataClient.getCandlestickSnapshot()`、`DelayedSignalVerifier.getPendingCount()`。
2. 只有在现有状态源确实不够渲染时，才新增只读接口。
3. 新增接口必须只读、无副作用、不得改变现有拥有者边界。

### 6.4 事件层必须是非阻塞旁路，不得改变业务主链路

上一版提到了 event bus，但没有写清楚约束。

修正后要求：

1. event bus 只能 `emit(event): void`。
2. 业务模块发事件不能 `await`。
3. 事件接收侧异常必须被吞掉并降级为文件日志，不能回抛到交易链路。
4. event bus 用于“最新状态摘要”，不是用于驱动业务状态机。

## 7. 正确的目标架构

本次重构后的展示架构固定为四层：

```text
App Bootstrap Phase
-> Startup TUI Store
-> Ink Shell

Business Runtime
-> Runtime Snapshot Reader
-> TUI Store
-> Ink Panels

Business Boundary Events
-> Runtime Event Bus
-> TUI Store
-> Latest Status Line
```

### 7.1 Startup TUI Shell

职责：

1. 在 `runApp()` 进入 pre-gate 之前挂载。
2. 展示启动阶段状态，而不是等待主循环后再出现。
3. 承接启动失败、授权提示、startup gate 等状态。

这个壳层不是独立第二入口，而是仍然由 `runApp()` 装配。

### 7.2 Snapshot Reader

职责：

1. 定时读取 runtime 当前状态。
2. 生成稳定的只读展示快照。
3. 为固定面板提供当前态，而不是历史日志。

优先读取的状态源：

1. `lastState`
2. `monitorContexts`
3. `refreshGate.getStatus()`
4. `MarketDataClient.getCandlestickSnapshot()`
5. `DelayedSignalVerifier.getPendingCount()`

仅在确有缺口时新增只读接口：

1. task queue 大小与队首摘要
2. processor / worker / refresher 运行态
3. trader 暴露出来的 order monitor 摘要

### 7.3 Event Bus

职责：

1. 提供“最新状态摘要”的事件来源。
2. 只承载少量高价值边界事件。
3. 不承担瀑布流展示。

首批应该进入事件总线的事件仅限边界事件：

1. TUI 启动 / pre-gate 阶段变化
2. startup snapshot 成功或失败
3. 生命周期状态切换
4. 信号入队 / 延迟验证通过或失败
5. 风控拦截
6. 下单提交 / 成交 / 撤单 / 改单
7. 自动寻标 / 换标 / 保护性清仓

### 7.4 Ink Render Layer

职责：

1. 渲染固定面板。
2. 渲染底部单条最新摘要。
3. 不直接依赖业务模块内部细节。

## 8. UI 形态

UI 固定为只读驾驶舱，不做聊天输入区。

建议布局如下：

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ 时间 | 运行时长 | 生命周期 | 交易门禁 | 开盘保护 | 主循环耗时         │
├──────────────────────────────────────────────────────────────────────────┤
│ 账户概览 | 持仓概览 | 队列概览 | 刷新/盯单/延迟验证                   │
├──────────────────────────────────────────────────────────────────────────┤
│ 标的组 A                                                             │
│ 监控标的 K 线 | OHLC | 当前价 | 当前信号 | 指标值                    │
│ 做多席位行：席位状态 + 当前做多标的 + 当前日志同口径字段              │
│ 做空席位行：席位状态 + 当前做空标的 + 当前日志同口径字段              │
├──────────────────────────────────────────────────────────────────────────┤
│ 标的组 B                                                             │
│ 监控标的 K 线 | OHLC | 当前价 | 当前信号 | 指标值                    │
│ 做多席位行：席位状态 + 当前做多标的 + 当前日志同口径字段              │
│ 做空席位行：席位状态 + 当前做空标的 + 当前日志同口径字段              │
├──────────────────────────────────────────────────────────────────────────┤
│ 持仓表                                                               │
├──────────────────────────────────────────────────────────────────────────┤
│ 最新状态摘要                                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

### 8.1 UI 字段约束

1. 账户信息至少包含余额、净资产、持仓市值、可用现金。
2. 持仓信息至少包含标的、数量、可用数量、现价、市值、盈亏。
3. 每组监控标的必须展示单张监控标的 K 线，不展示 long/short 自己的 K 线。
4. LONG / SHORT 两行必须直接复用当前 `marketMonitor` 展示口径：
   - 最新价格
   - 涨跌额
   - 涨跌幅
   - 距回收价
   - 持仓市值
   - 持仓盈亏
   - 订单数量
5. 仅靠当前日志口径还不足以表达席位是否可交易，因此 seat line 还必须额外展示：
   - 席位状态
   - 席位版本
6. 延迟验证数量必须可见，因为它属于当前交易运行态的重要组成部分。
7. 所有固定标签统一使用中文。

## 9. 模块放置与边界

### 9.1 TUI 模块位置

TUI 放在 `src/tui/`，不放在 `src/utils/tui/`。

原因：

1. TUI 不是通用工具。
2. 它属于 app 层展示装配。
3. 它会读取 app/runtime 聚合状态，而不是只做纯工具函数。

### 9.2 入口策略

入口保持：

```text
src/index.ts
-> app/runApp.ts
```

不新增第二运行时入口。

### 9.3 logger 退出主展示路径的正确方式

不能粗暴地“直接删掉 console sink”，而应分两步：

1. TUI 未挂载前，允许 startup-fatal 信息继续走 stderr。
2. TUI 挂载后，连续业务遥测不再以控制台日志作为主展示渠道。

要点：

1. 文件日志保留。
2. 启动致命错误与进程级致命错误允许保留 stderr 兜底。
3. 不再让持续刷新的业务行情与监控日志占用 stdout/stderr 主视图。

## 10. 需要新增或改造的模块

### 10.1 建议新增

1. `src/tui/app.tsx`
2. `src/tui/bootstrap/runTuiApp.tsx`
3. `src/tui/store/types.ts`
4. `src/tui/store/createTuiStore.ts`
5. `src/tui/events/types.ts`
6. `src/tui/events/createRuntimeEventBus.ts`
7. `src/tui/snapshot/createRuntimeSnapshotReader.ts`
8. `src/tui/components/overview.tsx`
9. `src/tui/components/groupMonitorBlock.tsx`
10. `src/tui/components/positionsPanel.tsx`
11. `src/tui/components/latestStatusLine.tsx`
12. `src/tui/components/candlestickChart.tsx`
13. `src/tui/components/seatQuoteLine.tsx`
14. `src/tui/constants/*`

### 10.2 需要改造

1. `src/app/runApp.ts`
   - 改为“TUI shell + business runtime”统一装配入口
2. `src/services/accountDisplay/index.ts`
   - 提炼账户/持仓格式化能力，避免只剩 logger side effect
3. `src/services/marketMonitor/index.ts`
   - 保留现有变化检测与 `monitorValues` 更新语义
   - 将展示字段提炼为可复用结构，而不是继续只输出字符串
4. `src/utils/logger/index.ts`
   - 保留文件 sink
   - 在 TUI 挂载后退出持续业务 console 遥测主路径
5. `src/main/asyncProgram/*`
   - 仅补充确实缺失的只读运行态接口
6. `src/core/trader/*`
   - 如需展示 order monitor 摘要，应优先通过 trader 暴露只读摘要，不让 TUI 直接依赖 `core/trader/orderMonitor/*` 内部实现细节

## 11. 必须补齐的最小可观察性缺口

### 11.1 已有接口，直接复用

以下能力已存在，不应重复设计：

1. `RefreshGate.getStatus()`
2. `DelayedSignalVerifier.getPendingCount()`
3. `MarketDataClient.getCandlestickSnapshot()`
4. `MonitorState.lastMonitorSnapshot`
5. `MonitorState.monitorValues`
6. `MonitorState.signal`

### 11.2 TaskQueue

当前 `TaskQueue` 只有：

1. `push`
2. `pop`
3. `isEmpty`
4. `removeTasks`
5. `clearAll`
6. `onTaskAdded`

最小补齐：

1. `size()`
2. `peekSnapshot(limit?: number)`

`peekSnapshot()` 只返回只读摘要，不返回可变内部数组引用。

### 11.3 MonitorTaskQueue

同样最小补齐：

1. `size()`
2. `peekSnapshot(limit?: number)`

### 11.4 Processor / Worker / Refresher

以下运行器目前缺少公开只读状态：

1. `Processor`
2. `OrderMonitorWorker`
3. `PostTradeRefresher`

最小补齐统一为：

1. `getStatus()`

建议最少包含：

1. `running`
2. `inFlight`
3. `pendingCount`
4. `queued` 或 `pendingVersion` 等模块特有摘要

### 11.5 Order Monitor 摘要

`OrderMonitor` 内部已有：

1. `trackedOrders`
2. `pendingRefreshSymbols`
3. `runtimeState`

但当前未对外提供只读摘要。

正确补齐方式：

1. 通过 `Trader` 暴露只读摘要接口，或在 `OrderMonitorWorker` 侧暴露聚合摘要。
2. 不让 `tui` 直接 import `orderMonitor` 内部 runtime store。

建议最少包含：

1. `trackedOrderCount`
2. `pendingRefreshCount`
3. `runtimeState`

## 12. 关键实现原则

### 12.1 K 线与指标口径

为了满足“每组标的显示实时 K 线”的需求，snapshot reader 必须直接读取：

1. `MarketDataClient.getCandlestickSnapshot(monitorSymbol, TRADING.CANDLE_PERIOD)`
2. `monitorContext.state.lastMonitorSnapshot`
3. `indicatorProfile.displayPlan`

并遵守：

1. K 线数据源只能使用 monitor symbol。
2. 指标值只能复用现有指标流水线结果。
3. 不允许为了 TUI 单独重算一套 EMA / RSI / PSY / KDJ / MACD / ADX。

### 12.2 Seat Line 口径

LONG / SHORT seat line 的行情与持仓字段，必须继续来自当前 `marketMonitor` 已使用的数据口径：

1. `formatQuoteDisplay`
2. `formatWarrantDistanceDisplay`
3. `formatPositionDisplay`
4. `PriceDisplayInfo`

同时补充席位状态字段：

1. `seat status`
2. `seat version`

这样既保持当前展示口径，又不会把 `EMPTY / SEARCHING / SWITCHING / ACTIVATING` 错误显示成“无行情”。

### 12.3 Event Bus 约束

event bus 必须满足：

1. 无阻塞。
2. 无 await。
3. 监听器异常不得回传业务层。
4. 丢事件最多影响最新摘要，不影响交易正确性。

### 12.4 不把日志字符串喂给 TUI

错误路径：

```text
业务模块 -> logger.info('字符串') -> TUI 解析字符串
```

正确路径：

```text
业务模块 -> 结构化 snapshot / 结构化 event -> TUI 渲染
```

## 13. 分阶段实施方案

### 阶段 0：兼容性闸门

目标：

1. 在当前仓库中验证 `bun + react + ink` 的最小可运行性。
2. 验证 Windows 终端下的基本刷新、中文宽度与退出行为。

范围：

1. 安装最小依赖
2. 增加一次性 smoke test 页面
3. 不接入任何业务 runtime

通过标准：

1. `bun start` 或独立 smoke 命令能渲染最小 Ink 页面。
2. 定时刷新正常。
3. `Ctrl+C` 退出正常。
4. 中文不出现明显错位。

未通过则：

1. 停止正式重构。
2. 不进入业务层改造。

### 阶段 1：建立 TUI Shell 与启动阶段状态

目标：

1. 在 `runApp()` 最外层先挂载 TUI shell。
2. 将 pre-gate 阶段状态纳入 TUI store。

范围：

1. `runApp`
2. startup phase store
3. 最小启动面板

通过标准：

1. 配置校验、OAuth 提示、startup gate 等状态可见。
2. 即使业务 runtime 尚未启动，TUI 也能工作。

### 阶段 2：接入业务 runtime Snapshot MVP

目标：

1. TUI 能读取现有 runtime 状态并渲染固定面板。
2. 优先复用现有状态源，不先大改业务模块。

范围：

1. `lastState`
2. `monitorContexts`
3. `refreshGate`
4. `MarketDataClient.getCandlestickSnapshot()`
5. `DelayedSignalVerifier.getPendingCount()`

通过标准：

1. 已能渲染顶部总览、账户、持仓、每组监控标的块。
2. 已能渲染监控标的 K 线、OHLC、指标、LONG / SHORT seat line。

### 阶段 3：补齐最小缺口接口

目标：

1. 只为 TUI 真实缺失的数据补接口。

范围：

1. task queue `size / peekSnapshot`
2. processor / worker / refresher `getStatus`
3. trader 侧 order monitor 摘要

通过标准：

1. TUI 不再依赖猜测或日志文本推断运行态。

### 阶段 4：接入 Runtime Event Bus

目标：

1. 为底部最新摘要接入结构化事件。

范围：

1. 生命周期边界
2. 延迟验证结果
3. 风控拦截
4. 下单与成交
5. 自动寻标 / 换标 / 保护性清仓

通过标准：

1. UI 底部只显示最新一条结构化摘要。
2. 不引入事件墙。

### 阶段 5：退出持续业务 console 遥测主路径

目标：

1. TUI 成为主展示面。
2. logger 保留文件日志与 fatal stderr。

通过标准：

1. `bun start` 默认进入 TUI。
2. 控制台不再持续刷业务行情/监控日志。
3. 文件日志仍保留。

## 14. 验收标准

方案落地后，必须满足：

1. `bun start` 直接进入 Ink TUI。
2. UI 能看到：
   - 启动阶段状态
   - 生命周期状态
   - 交易门禁状态
   - 账户与持仓
   - 队列长度
   - 延迟验证数量
   - 刷新门禁状态
   - 订单监控摘要
   - 每组监控标的单张实时 K 线
   - 每组监控标的当前计算指标
   - 每组 LONG / SHORT seat line
   - 最新状态摘要
3. 不存在聊天输入框。
4. 不依赖 `node` 启动程序。
5. 不改变现有交易业务语义。
6. 文件日志仍正常写入。
7. 最终通过：

```powershell
bun format
bun lint
bun type-check
```

## 15. 风险与控制

### 15.1 Ink 在 Bun 下的兼容风险

这是前置风险，不应被弱化。

控制方式：

1. 阶段 0 先做 smoke test。
2. 未通过则停止，不进入业务改造。

### 15.2 Windows 终端渲染差异

需要实际验证：

1. 刷新是否闪烁。
2. 中文宽度是否稳定。
3. 边框与多列布局是否错位。

### 15.3 双主输出路径漂移风险

如果长期保留“控制台业务展示”和“TUI 展示”双主链路，一定漂移。

控制方式：

1. 文件日志保留。
2. 连续业务 console 遥测退出主路径。
3. fatal stderr 保留为异常兜底，而不是常态展示面。

### 15.4 展示层反向污染业务层风险

这是本方案最大的业务逻辑风险。

控制方式：

1. snapshot reader 只读。
2. event bus 非阻塞。
3. 展示层异常不得影响交易链路。

## 16. 最终判断

再次校验后，本方案可以保留，但必须按以下结论执行：

1. 正确方向是“只读展示型 TUI”，不是交互式终端应用。
2. 正确接入点是 `runApp()` 最外层，而不是等 pre-gate 结束后再挂 TUI。
3. 正确的数据策略是“先复用现有 runtime 状态源，只补最少缺口”。
4. 正确的事件策略是“非阻塞旁路摘要”，不是把 logger 字符串塞进 UI，也不是把 UI 变成新业务入口。
5. `bun + Ink` 不能被直接视为既成事实，必须先通过兼容性闸门。

满足以上前提后，这份方案才是与当前仓库事实一致、且不偏离交易业务逻辑的正确方案。
