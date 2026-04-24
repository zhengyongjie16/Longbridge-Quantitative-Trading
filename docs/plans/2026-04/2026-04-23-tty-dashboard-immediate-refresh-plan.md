# TTY 单屏仪表盘立即刷新方案

> 状态：draft  
> 日期：2026-04-23  
> 目标：把当前终端实时显示从 `logger.info(...)` 追加式瀑布输出，改为单一 TTY screen owner 管理的固定位置仪表盘；事件到达并完成业务计算后立即请求局部刷新，不使用 Ink/React 作为高频刷新核心。

## 1. 最终结论

本方案不采用 `Ink` 作为实时行情仪表盘核心。

原因不是 Ink 不能做终端 UI，而是本系统目标是高频、单字段、固定位置刷新。Ink 的 React reconciler 与组件树刷新模型更适合低频 CLI 状态页、交互式命令和任务进度，不是本项目最短路径。

本项目应采用：

```text
业务事件完成
-> 写入 dashboard 展示态
-> 立即请求 terminal dashboard flush
-> TTY renderer 移动光标并局部覆盖 dirty 字段/dirty 行
```

实现基线：

1. 使用 Bun 优先的终端输出能力：
   - `Bun.stdout`
   - `Bun.write(Bun.stdout, chunk)`
   - ANSI 控制序列：cursor move / clear line / clear screen / alternate screen / hide cursor / show cursor
2. `node:readline` 只作为 Bun 兼容的可选辅助，不作为主路径依赖。
   - Bun 官方兼容表将 `node:readline` 标记为 fully implemented。
   - 但本项目只需要光标移动和清屏，直接写 ANSI 序列更短，也更符合 Bun 优先。
3. 首版不引入第三方库。
   - 数字字段使用固定宽度规避宽度计算问题。
   - 文本字段先采用整行清除后重绘，避免复杂截断。
   - 中文名称首版可以保留短名称或代码优先显示，不为了对齐提前引入依赖。
4. 如果真实实现遇到中文列宽或彩色文本截断问题，再按需引入极小依赖：
   - `string-width`：只解决可见列宽。
   - `strip-ansi`：只在需要计算带颜色文本宽度时引入。
   - `slice-ansi`：只在需要截断带颜色文本时引入。
5. 不引入 React/Ink、不引入 blessed、不引入 terminal-kit、不引入 web server、不引入浏览器、不解析日志文本。

## 2. 第一性原理

终端没有 DOM。固定位置刷新本质只有三件事：

1. 移动光标到目标坐标。
2. 用新内容覆盖旧内容。
3. 清除旧内容残留。

因此，“类似 web 页面”的正确抽象不是组件虚拟 DOM，而是：

```text
屏幕状态
-> 布局坐标
-> dirty 区域
-> TTY write
```

高频场景下，真正要避免的是：

1. 持续追加文本导致瀑布输出。
2. 每个事件都重绘整屏。
3. 终端写入背压反向阻塞交易业务。
4. 为 UI 建立第二套业务 truth 或解析日志恢复状态。

正确目标是：

```text
业务 owner 继续拥有业务事实
dashboard state 只保存展示事实
terminal dashboard runtime 独占 stdout 主屏
logger 继续写文件，不再作为实时主屏输出路径
```

## 3. 当前代码基线

当前工作区已经有终端显示事件驱动改造的基础：

1. `src/main/businessEventProgram/index.ts`
   - `runIndicatorPipeline(...)` 成功后，把已提交的 `monitorSnapshot` 交给 `monitorDisplayRuntime.requestRender(...)`。
2. `src/main/monitorDisplayRuntime/index.ts`
   - 已具备 per-monitor `single-flight + latest-only collapse`。
   - 当前仍调用 `marketMonitor.renderMonitorIndicators(...)`，后者继续走 `logger.info(...)`。
3. `src/main/tradingQuoteDisplayRuntime/index.ts`
   - 已监听标准化 `onQuoteUpdated(...)`。
   - 已复用 trading risk route helper，并在异步读取 monitor quote 后复核 route。
   - 当前仍调用 `renderTradingQuote(...)`，后者继续走 `logger.info(...)`。
4. `src/services/marketMonitor/index.ts`
   - 当前职责已收缩为纯格式化/渲染器。
   - 但输出目标仍是 logger，所以控制台仍会追加日志。

因此下一步不是重新设计事件 owner，而是把输出目标从：

```text
display runtime -> marketMonitor -> logger.info -> stdout/stderr append
```

改为：

```text
display runtime -> dashboard state commit -> terminal dashboard runtime -> fixed-position TTY update
```

## 4. 非目标

本方案明确不做以下事情：

1. 不保留 Ink 与 TTY renderer 双主路径。
2. 不把旧 console 文本解析成 UI state。
3. 不用固定刷新间隔轮询作为主刷新机制。
4. 不把所有业务 runtime 的状态每秒全量扫描成屏幕。
5. 不把 dashboard state 作为交易判断输入。
6. 不让 UI 渲染失败影响下单、风控、缓存、席位同步或信号生成。
7. 不为了 UI 新建第二套行情缓存、席位路由或业务 truth。
8. 不引入第三方 TUI 框架；本方案只需要固定位置覆盖刷新，框架级 widget/layout/state 抽象会增加不必要开销。

## 5. 立即刷新语义

“立即刷新”定义为：

```text
事件到达
-> 对应业务 owner 完成计算和状态提交
-> dashboardRuntime.commit(...)
-> 若 TTY 当前空闲，立即执行 dirty flush
-> 若 TTY 当前忙，只合并最新 dirty state，并在当前 flush 结束后立刻补刷最新状态
```

这不是固定 10Hz/20Hz 刷新，也不是每秒轮询。刷新由事件完成点触发。

但立即刷新必须带一个终端写入保护：

1. 同一时刻只允许一个 flush 写 stdout。
2. flush 期间新事件到达时，只标记 `pendingFlush = true`，不排队旧帧。
3. 当前 flush 结束后，如果 `pendingFlush === true`，立即用最新 dashboard state 再 flush。
4. 如果底层写入通道进入背压状态，显示 runtime 不等待业务链路；只保留最新展示态，等待 drain 或下一次安全写入窗口后补刷。
5. 每次 flush 必须先把本轮 dirty 输出拼成一个完整 `frame` 字符串，再对 `Bun.stdout` 做一次写入；禁止每个字段单独调用一次 `Bun.write(...)`。

这叫：

```text
event-driven immediate flush + single-flight + latest-only collapse
```

它满足高频显示的关键要求：事件完成后立即触发刷新，同时不把终端 I/O 变成业务阻塞点。

## 6. 模块设计

### 6.1 新增目录

```text
src/ui/
├── dashboard/
│   ├── state.ts
│   ├── types.ts
│   └── commit.ts
└── terminal/
    ├── terminalDashboardRuntime.ts
    ├── renderer.ts
    ├── layout.ts
    ├── scheduler.ts
    ├── fieldRegistry.ts
    ├── format.ts
    └── width.ts
```

### 6.2 `src/ui/dashboard/types.ts`

只定义展示态类型。

核心类型应覆盖：

1. 顶部摘要：
   - 当前香港时间
   - 程序运行状态
   - `isTradingEnabled`
   - `canTrade`
   - lifecycle 状态
   - 当日交易日/半日状态
2. 账户摘要：
   - 币种
   - 现金
   - 净资产
   - 持仓市值
3. 持仓列表：
   - 标的代码
   - 标的名称
   - 方向/账户通道
   - 数量
   - 可用数量
   - 当前价
   - 市值
   - 仓位
4. monitor 卡片：
   - monitorSymbol
   - monitor 名称
   - 最近 K 线时间
   - 监控标的价格
   - 涨跌幅
   - displayPlan 对应指标
   - 最新信号摘要
5. 席位展示：
   - `LONG` / `SHORT`
   - 当前 active symbol
   - symbolName
   - quote timestamp
   - 最新价
   - 涨跌幅
   - 距回收价
   - 持仓盈亏
   - 未平买入订单数
6. 最近事件：
   - 只保留最后 N 条业务事件/错误摘要

所有类型必须是 UI 展示态，不得被交易逻辑读取。

### 6.3 `src/ui/dashboard/state.ts`

职责：

1. 保存当前 `DashboardState`。
2. 保存 dirty 信息：
   - dirty field keys
   - dirty row keys
   - 是否需要 full repaint
3. 提供只读读取：
   - `getDashboardState()`
   - `getDirtySnapshot()`
4. 提供提交：
   - `commitDashboardPatch(patch)`
   - `markFullRepaintRequired(reason)`
5. 提供订阅仅供测试或后续扩展，不作为运行时刷新主机制。

这里不引入 React store，也不使用 `useSyncExternalStore`。

### 6.4 `src/ui/terminal/terminalDashboardRuntime.ts`

这是唯一的实时屏幕 owner。

职责：

1. 启动时进入 alternate screen。
2. 隐藏光标。
3. 注册终端 resize 监听。
4. 初始化 layout 和 field registry。
5. 暴露：
   - `start()`
   - `commit(patch)`
   - `requestImmediateFlush()`
   - `stopAndRestore()`
6. 停止时：
   - 显示光标
   - 退出 alternate screen
   - 清理监听

`start()` 之后，实时 dashboard 是 stdout 的唯一主屏输出 owner。

### 6.5 `src/ui/terminal/scheduler.ts`

职责不是按时间轮询，而是管理 immediate flush 的单飞边界。

状态：

```text
isRendering
pendingFlush
stdoutBackpressure
```

行为：

1. `requestImmediateFlush()`：
   - 若 `isRendering === false` 且无背压，立即 flush。
   - 否则只置 `pendingFlush = true`。
2. `flush()`：
   - 从 dashboard state 取 dirty snapshot。
   - 调 renderer 写入 TTY。
   - 写完后清理已消费 dirty。
   - 如果 flush 期间又有新 dirty，立即继续下一轮。
3. 遇到 stdout 背压：
   - 不阻塞业务调用栈。
   - 标记 `stdoutBackpressure = true`。
   - 在 `drain` 时立刻恢复一次 latest-only flush。

### 6.6 `src/ui/terminal/renderer.ts`

职责：

1. 初次 full render。
2. resize 后 full repaint。
3. 普通事件触发 dirty field / dirty row 更新。
4. 输出 ANSI/TTY 控制序列。
5. 把本轮所有 dirty 输出合并为单个 frame string。
6. 通过单次 `Bun.write(Bun.stdout, frame)` 写入终端。

字段刷新必须遵守：

1. 数字字段使用固定显示宽度。
2. 文本字段可以固定最大宽度并截断，也可以整行清除后重绘。
3. 任意字段变短时必须清除旧尾部残留。
4. 带颜色文本必须按可见宽度计算，不按字符串长度计算。
5. 中文名称按终端列宽计算。
6. 首版如果不引入宽度依赖，中文名称不得参与严格列对齐；代码与数字字段优先保证稳定。

推荐策略：

```text
价格 / 涨跌幅 / 盈亏 / 数量:
  固定宽度，右对齐，写满字段宽度。

标的名称 / 状态 / 最近事件:
  清除整行或局部区域后重绘。

monitor 卡片数量、持仓数量、终端尺寸变化:
  full repaint。
```

写入策略：

```text
collectDirtyCommands()
-> commands.join("")
-> Bun.write(Bun.stdout, frame)
```

禁止：

```text
for each dirty field:
  Bun.write(Bun.stdout, fieldFrame)
```

性能瓶颈优先级按以下顺序处理：

1. 降低写入次数：单次 flush 一次写入。
2. 降低写入字符量：dirty field / dirty row 优先，结构变化才 full repaint。
3. 降低计算量：数字固定宽度，文本少截断。
4. 最后才考虑第三方宽度/截断依赖。

### 6.7 `src/ui/terminal/layout.ts`

layout 负责把 `DashboardState` 映射成终端坐标。

布局不固定终端宽高，但可以在当前终端尺寸下分配稳定区域：

1. 顶部摘要区：2-3 行。
2. 账户与持仓区：固定上限行数，超出时显示汇总和截断提示。
3. monitor 区：按 monitor 配置顺序纵向排列。
4. 每个 monitor 内部：
   - monitor 指标行
   - LONG 席位行
   - SHORT 席位行
5. 底部最近事件区：固定最后 N 行。

终端宽度不足时：

1. 不做复杂多列布局。
2. 优先保留价格、涨跌幅、距回收价、持仓盈亏、信号状态。
3. 名称可截断，代码必须保留。
4. LONG/SHORT 席位不强制左右并排，直接上下两行更稳定。

## 7. 输出权责调整

### 7.1 logger

logger 继续负责文件日志和异常诊断，但不再负责实时主屏。

需要调整：

1. dashboard 模式下，`logger` 的 console stream 不应向 stdout 追加普通 info 日志。
2. `warn/error` 可以继续写文件；是否在 terminal dashboard 的最近事件区显示，由 dashboard event commit 决定。
3. 启动前、退出后可以使用普通 console 输出；dashboard start 后 stdout 归 terminal dashboard runtime 管理。

### 7.2 marketMonitor

`marketMonitor` 当前已经收缩成纯渲染器。TTY dashboard 阶段应继续收缩为纯格式化/patch 生成，不再直接 `logger.info(...)`。

目标：

```text
renderTradingQuote(...)
-> buildTradingQuoteDashboardPatch(...)
-> terminalDashboardRuntime.commit(...)
```

```text
renderMonitorIndicators(...)
-> buildMonitorIndicatorDashboardPatch(...)
-> terminalDashboardRuntime.commit(...)
```

如果保留 `marketMonitor` 名称，会造成“监控器”语义残留。后续实现时建议按实际职责改名为 `displayFormatter` 或 `dashboardPresenter`，但本方案不要求为了命名先做大范围迁移；可以在实现阶段根据触及面决定是否同步更名。

### 7.3 display runtime

`monitorDisplayRuntime` / `tradingQuoteDisplayRuntime` 的业务边界保持不变：

1. 它们仍是事件驱动显示 side effect owner。
2. 它们仍负责 async quote 补充、route gate、single-flight/latest-only。
3. 它们不直接写 stdout。
4. 它们只提交 dashboard patch。

## 8. 数据流设计

### 8.1 监控标的 K 线显示

```text
quoteClient.onCandlestickUpdated
-> businessEventProgram route
-> runIndicatorPipeline(...)
-> indicatorCache.push(...)
-> syncSignalSeatState(...)
-> monitorDisplayRuntime.requestRender(...)
-> getQuotes([monitorSymbol])
-> getCandlestickSnapshot(...)
-> buildMonitorIndicatorDashboardPatch(...)
-> terminalDashboardRuntime.commit(...)
-> immediate dirty flush
-> runSignalPipeline(...)
```

注意：

1. `businessEventProgram` 不等待 TTY flush。
2. dashboard patch 必须使用已提交 snapshot。
3. `runSignalPipeline(...)` 不作为 monitor indicator 显示的前置条件。

### 8.2 交易标的 quote 显示

```text
quoteClient.onQuoteUpdated
-> tradingQuoteDisplayRuntime route resolve
-> getQuotes([monitorSymbol])
-> route revalidate
-> buildTradingQuoteDashboardPatch(...)
-> terminalDashboardRuntime.commit(...)
-> immediate dirty flush
```

注意：

1. 哪个 trading symbol 收到 quote push，只更新该 symbol 所在席位字段。
2. 不恢复旧的双边一起输出语义。
3. 不做本地变化阈值判断。
4. route 复核必须保留，避免 async 后打印到旧席位。

### 8.3 账户/持仓显示

当前 `displayAccountAndPositions(...)` 是日志输出服务。TTY dashboard 阶段应改为：

```text
postTradeConsistency / rebuildTradingDayState / account snapshot committed
-> buildAccountAndPositionsDashboardPatch(...)
-> terminalDashboardRuntime.commit(...)
-> immediate dirty flush
```

账户/持仓的刷新频率不会像 quote 一样高，但仍应走同一个 dashboard commit 入口，避免控制台出现第二个输出 owner。

### 8.4 最近事件显示

错误、警告、交易动作、生命周期迁移可以进入最近事件区，但必须是固定行数 ring buffer：

```text
appendDashboardEvent(event)
-> dirty recent-events region
-> immediate flush
```

最近事件区不是日志替代品。完整日志仍写文件。

## 9. 字段宽度与残留处理

位数变化必须显式处理。

错误示例：

```text
旧值: 123.456
新值: 98.7
直接覆盖结果: 98.7456
```

本方案采用三类策略：

### 9.1 固定宽度字段

适用于：

1. 价格
2. 涨跌幅
3. 市值
4. 盈亏
5. 数量
6. 距回收价
7. 订单数

规则：

```text
字段宽度固定
数字右对齐
空值显示 "-"
写入时总是写满字段宽度
```

### 9.2 清空后重绘

适用于：

1. 标的名称
2. 信号状态
3. lifecycle 状态
4. 最近事件行

规则：

```text
cursorTo(rowStart)
clearLine()
write(newLine)
```

### 9.3 写尾部空格

适用于短文本字段局部更新。

规则：

```text
padding = max(0, previousVisibleWidth - nextVisibleWidth)
write(nextText + spaces(padding))
```

必须用可见宽度，不得用 JS 字符串长度。

## 10. stdout 背压与失败处理

TTY 写入是 I/O。即使主路径使用 `Bun.write(Bun.stdout, chunk)`，也必须把终端输出视为可能慢于业务事件的外部通道；如果后续实现落到兼容 stream API，也必须处理 `write(...) === false` 的背压语义。

处理原则：

1. 业务链路不等待 stdout drain。
2. 当前 flush 发现背压后停止继续写旧 dirty。
3. 保留 dashboard state 最新值。
4. drain 后立即触发一次 latest-only dirty flush。
5. 如果 renderer 抛错：
   - 记录文件日志。
   - 标记下一次 full repaint。
   - 不影响业务 owner。

这不是降级或兜底业务路径；这是显示 side effect 的 I/O 边界保护。

## 11. 生命周期与终端恢复

### 11.1 启动

启动流程：

1. 完成必要 runtime 创建。
2. 创建 `terminalDashboardRuntime`。
3. 在实时业务 runtime start 前进入 alternate screen。
4. 先 full render 一个空仪表盘骨架。
5. 后续业务事件逐步填充字段。

### 11.2 退出

退出流程必须保证终端恢复：

1. 停止接收 dashboard commit。
2. flush 最后一条退出状态，或者直接跳过最终帧。
3. 显示光标。
4. 退出 alternate screen。
5. 清理 resize/drain 监听。
6. 再允许普通 logger/console 输出退出摘要。

如果进程异常退出，`createCleanup` 与 logger 全局 hook 不应互相抢 stdout；terminal dashboard runtime 应有同步恢复方法，至少恢复光标和主屏。

## 12. 实施步骤

### Phase 1：建立 TTY dashboard 基础设施

新增：

1. `src/ui/dashboard/types.ts`
2. `src/ui/dashboard/state.ts`
3. `src/ui/dashboard/commit.ts`
4. `src/ui/terminal/terminalDashboardRuntime.ts`
5. `src/ui/terminal/renderer.ts`
6. `src/ui/terminal/layout.ts`
7. `src/ui/terminal/scheduler.ts`
8. `src/ui/terminal/fieldRegistry.ts`
9. `src/ui/terminal/format.ts`
10. `src/ui/terminal/width.ts`

验收：

1. 可以在测试中创建 dashboard runtime。
2. 可以 full render 到 mock writable stream。
3. 可以 dirty field 局部刷新。
4. 字段变短不会残留旧字符。
5. resize 会触发 full repaint。

### Phase 2：接入 monitor indicator 显示

改造：

1. `monitorDisplayRuntime` 不再调用 `marketMonitor.renderMonitorIndicators(...)` 直接打日志。
2. 改为构造 monitor indicator dashboard patch。
3. `terminalDashboardRuntime.commit(...)` 后立即请求 flush。

验收：

1. K 线事件完成后对应 monitor 区立即更新。
2. 高频 K 线事件同一 monitor 只保留最新展示态。
3. `businessEventProgram` 不等待 TTY flush。

### Phase 3：接入 trading quote 显示

改造：

1. `tradingQuoteDisplayRuntime` route 复核逻辑保持不变。
2. route 当前有效后构造 trading quote dashboard patch。
3. 只更新对应 `monitorSymbol + direction + tradingSymbol` 字段。

验收：

1. 单个交易标的 quote push 只刷新该席位。
2. 不恢复双边联动输出。
3. route 变更后旧 async render 不会写入旧席位。

### Phase 4：接入账户/持仓与最近事件

改造：

1. `displayAccountAndPositions(...)` 从日志输出改为 dashboard patch。
2. 生命周期、交易动作、错误摘要写入最近事件 ring buffer。
3. logger 保留文件输出。

验收：

1. 启动/重建后账户与持仓显示在固定区域。
2. 成交后持仓区更新，不追加瀑布日志。
3. 最近事件区固定行数滚动覆盖。

### Phase 5：关闭实时 console append

改造：

1. dashboard start 后，实时展示路径不得再调用 `logger.info(...)` 输出主屏内容。
2. logger console stream 需要按运行模式调整：
   - dashboard 模式：普通 info 不写 stdout。
   - 非 dashboard 模式：保留原 console 行为，便于测试或临时诊断。
3. 完整日志继续写文件。

验收：

1. 交易时段高频事件下，终端不再瀑布式滚动。
2. stdout 主屏只由 terminal dashboard runtime 更新。
3. warn/error 不破坏仪表盘布局，必要信息进入最近事件区或文件日志。

## 13. 测试计划

### 13.1 renderer 单元测试

覆盖：

1. 固定宽度数字字段：
   - `123.456 -> 98.7`
   - `1000000000 -> 99`
   - `-1234.56 -> -`
2. 中文宽度：
   - 标的名称截断不破坏列宽。
3. ANSI 颜色：
   - 可见宽度计算不包含控制码。
4. dirty field：
   - 只输出目标字段坐标和文本。
5. dirty row：
   - 先 clear line，再重写整行。
6. full repaint：
   - 清屏并重建 field registry。
7. frame 合并：
   - 多个 dirty 字段在一次 flush 中只产生一个 frame。
   - mock writer 只被调用一次。

### 13.2 scheduler 单元测试

覆盖：

1. 空闲状态 commit 后立即 flush。
2. flush 中 commit 只置 pending，不递归重入。
3. flush 结束后 pending 会立即补刷最新状态。
4. 底层写入通道背压时不阻塞 commit。
5. drain 后触发 latest-only flush。

### 13.3 runtime 集成测试

覆盖：

1. `monitorDisplayRuntime` 提交 monitor patch，不直接写 logger。
2. `tradingQuoteDisplayRuntime` 提交 trading quote patch，route stale 时不提交。
3. `displayAccountAndPositions` 提交账户/持仓 patch。
4. `createCleanup` 能恢复终端。

### 13.4 人工验证

在开发环境模拟高频 quote：

1. 同一价格字段从长数字变短数字，无残留。
2. 多个 symbol 高频更新时，屏幕不滚动。
3. Ctrl+C 后终端恢复正常。
4. 重定向 stdout 或非 TTY 环境下不启用 dashboard 主屏。

## 14. 验收标准

本方案完成后必须满足：

1. 实时行情和指标不再以 `logger.info(...)` 追加到控制台。
2. 终端主屏在固定区域更新。
3. quote / K 线事件完成后立即请求刷新，不依赖固定刷新间隔。
4. 高频事件只保留最新显示态，不堆积旧帧。
5. 字段位数变短不会残留旧字符。
6. 单次 flush 合并为一次 `Bun.stdout` 写入，不按字段多次写入。
7. 首版不引入第三方 TUI 框架，也不强制引入宽度处理依赖。
8. 终端 resize 后能重绘。
9. dashboard 失败不影响交易业务。
10. 文件日志仍完整保留。
11. 退出后终端光标、主屏和输出行为恢复正常。

## 15. 实现注意事项

1. 非 TTY 环境不要启用 alternate screen；优先通过 Bun/运行时能力判断当前 stdout 是否连接到终端，非 TTY 时保持文件日志与必要 console 输出。
2. 不要从 dashboard state 反向读取任何交易判断。
3. 不要在业务 owner 内直接调用 `Bun.write(Bun.stdout, ...)`、`process.stdout.write(...)` 或任何等价 TTY 写入。
4. 不要在 display runtime 中等待 TTY drain。
5. 不要把 dirty queue 做成旧帧队列；只保留最新 state。
6. 不要为了对齐手写固定整屏宽高；只在字段级使用固定宽度。
7. 不要让 warn/error 直接打破 dashboard；进入文件日志和最近事件区。
8. 不要恢复旧的本地变化检测、双边联动输出或轮询显示语义。
9. 不要按字段逐个 `Bun.write(...)`；renderer 必须在一次 flush 中合并 frame 后一次性写入。
10. 不要在首版为了中文/颜色截断提前引入第三方库；先用固定数字宽度和整行重绘完成主路径。

## 16. 推荐实现顺序

最短路径是先把 TTY renderer 做成可测试的纯输出层，再接入业务显示 runtime：

```text
renderer/layout/scheduler
-> dashboard state
-> monitorDisplayRuntime patch
-> tradingQuoteDisplayRuntime patch
-> account/positions patch
-> logger console append 收口
```

不要先改 logger。否则在 dashboard runtime 还没接住所有实时展示字段前，会丢失可见性。

也不要先把所有业务状态都搬进 dashboard。只从已经存在的显示完成点开始接入：

1. monitor indicator
2. trading quote
3. account/positions
4. recent events

这样不引入新的业务 owner，也不会扩大重构范围。
