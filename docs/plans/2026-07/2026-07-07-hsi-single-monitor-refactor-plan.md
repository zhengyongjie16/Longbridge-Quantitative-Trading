# HSI Single Monitor Refactor Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `typescript-project-specifications` before writing or refactoring TypeScript code. Use subagent-driven review for independent domains when implementing this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前支持多个监控标的并行实时分析和交易的程序，重构为仅支持一个配置化 HSI 监控标的的精简版本，移除所有多监控标的外层维度。

**Architecture:** 目标架构保留事件驱动交易链路，但把系统根模型从 `monitors[] + monitorContexts Map` 收缩为单 `monitor + monitorContext`。监控标的仍从配置读取，默认业务目标为 HSI，不在代码中硬编码；LONG/SHORT 方向、席位版本、牛熊证风险、订单归属、清仓冷却等方向级边界必须保留。

**Tech Stack:** Bun, TypeScript, Longbridge OpenAPI SDK, 现有事件驱动 runtime, 现有业务测试体系。

---

## 背景

当前程序的多标的支持不是单一配置功能，而是贯穿配置、启动装配、实时行情事件、信号处理、任务队列、订单归属、风险状态、生命周期重建、测试和文档的系统级外层维度。

用户目标是重构为单监控标的版本，用于针对恒生指数 HSI 做更深入的业务扩展。该目标不要求把监控标的写死为 HSI，而是要求配置面板只表达一个监控标的，不再出现 `_1`、`_2`、`MONITOR_SYMBOL_N`、多标的连续索引、多 monitor 并行 route、多 monitor 隔离测试等旧契约。

本计划遵循以下约束：

- 使用第一性原理审查，不把推断列为已确认缺陷。
- 优先事件驱动设计，保留 K 线事件、quote 事件、延迟验证、time wakeup、订单事件的显式推进边界。
- fail-fast，不提供旧 `_1` 配置兼容读取，不引入 fallback 或降级业务逻辑。
- 完成后必须清理生产代码、测试、文档和内部路径中的残留引用。

## 已确认的当前耦合点

### 配置与环境

- `src/types/config.ts` 中 `MultiMonitorTradingConfig.monitors` 是根配置数组契约，`MonitorConfig.originalIndex` 明确对应 `_1` / `_2` 后缀。
- `src/config/trading/index.ts` 的 `createMultiMonitorTradingConfig` 扫描 `MONITOR_SYMBOL_1..N`，并强制索引连续。
- `src/config/trading/utils.ts` 的 `parseMonitorConfig(env, index)` 通过 `const suffix = \`_${index}\`` 读取所有 monitor 级字段。
- `src/config/validator/index.ts` / `src/config/validator/utils.ts` 仍按 index 生成字段名，校验 monitor index continuity、跨 monitor alias 冲突和跨 monitor 交易标的重复。
- `.env.example` 与 `README.md` 明确要求即使只有一个监控标的也必须使用 `_1`。

### 启动与运行时装配

- `src/app/runtime/createPostGateRuntime.ts` 创建 `monitorContexts = new Map<string, MonitorContext>()`，并用 `tradingConfig.monitors.map(...)` 初始化 `lastState.monitorStates`。
- `src/app/context/createMonitorContexts.ts` 遍历 `preGateRuntime.tradingConfig.monitors`，为每个 monitor 创建策略、风控、延迟验证器和自动寻标管理器。
- `src/app/runtime/createAsyncRuntime.ts` 向异步处理器注入 `getMonitorContext(monitorSymbol)`，允许任务按任意 monitorSymbol 查找不同上下文。

### 实时事件链路

- `src/main/businessEventProgram/index.ts` 使用 `routeStates: Map<string, BusinessEventRouteState>` 建立 per-monitor K 线 route。
- `src/main/asyncProgram/indicatorCache/index.ts` 使用 `queues: Map<string, _SampleQueue>` 按 monitorSymbol 隔离延迟验证样本。
- `src/main/quoteSubscriptionRuntime/index.ts` 从 `tradingConfig.monitors` 投影 `MONITOR_BASE` 与 `SEAT_BOUND` 订阅集合。
- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts` 通过 `monitorContexts.get(event.symbol)` 命中 monitor，并维护 symbol 到多 monitor wakeup 的索引。
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts` route key 包含 `monitorSymbol + direction + seatVersion`。
- `src/main/monitorDisplayRuntime/index.ts` 按 monitorSymbol 建显示 route。

### 交易状态、订单和风控

- `src/services/autoSymbolManager/utils.ts` 的 `createSymbolRegistry` 按 `monitors` 建 `Map<monitorSymbol, SymbolSeatEntry>`。
- `src/core/orderRecorder/orderOwnershipParser.ts` 的 `resolveOrderOwnership` 遍历多个 monitor alias，返回 `monitorSymbol + direction`。
- `src/core/riskController/dailyLossTracker.ts` 以 `Map<monitorSymbol, { long, short }>` 分账日内亏损。
- `src/services/liquidationCooldown/tradeLogHydrator.ts` 从 `tradingConfig.monitors` 构造 monitorConfigMap 并按 monitor 过滤交易日志。
- `src/core/trader/orderExecutor/index.ts` 先通过 signal symbol 反查 monitor，再从 `monitors` 中查配置。
- `src/core/trader/orderMonitor/recoveryFlow.ts` 用 `tradingConfig.monitors` 解析恢复期订单归属。
- `src/main/tradingRiskEventRuntime/routingIndex.ts` 遍历 `monitorContexts` 构建多 route 风险索引。
- `src/main/lifecycle/rebuildTradingDayState.ts`、`src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`、`src/main/lifecycle/cacheDomains/seatDomain.ts`、`src/main/lifecycle/cacheDomains/riskDomain.ts` 均按所有 monitor 循环重建或清理。

### 测试与文档残留

- `mock/factories/configFactory.ts` 默认返回 `monitors: [createMonitorConfig()]`。
- `tests/config/tradingConfig.failfast.business.test.ts` 覆盖 `_1/_3` 缺 `_2`、cross-monitor alias conflict、重复交易标的等多 monitor 行为。
- `tests/app/context/createMonitorContexts.business.test.ts` 验证 HSI 与 HSCEI 两个 monitor 独立装配。
- `tests/app/startup/runtimeValidation.test.ts` 期望输出 “监控标的 1 / 做多席位标的 1 / 做空席位标的 1”。
- `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` 验证多个 monitor K 线订阅。
- `tests/integration/liquidation-cooldown-recovery.integration.test.ts` 验证 cooldown by monitor symbol 隔离。
- `tests/main/tradingRiskEventRuntime/tradingRiskEventRuntime.business.test.ts` 验证同一 trading symbol 被多个 monitor 拥有时抛重复归属。
- `tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts` 验证 multiple monitors do not conflict。
- `tests/main/asyncProgram/monitorTaskQueue/business.test.ts` 仍用多个 `monitorSymbol` 验证不同 dedupe key 的 FIFO 与清理行为。
- `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts` 是席位退场时清理延迟验证、买卖任务和 monitor task 的核心 helper，按 `monitorSymbol + direction` 过滤运行态任务。

## 目标状态

### 根配置

将根配置收缩为单 monitor：

```ts
export type TradingConfig = {
  readonly monitor: MonitorConfig;
  readonly global: GlobalConfig;
};
```

`MonitorConfig` 删除 `originalIndex`。monitor 级环境变量全部去后缀：

```env
MONITOR_SYMBOL=HSI.HK
LONG_SYMBOL=55131.HK
SHORT_SYMBOL=56614.HK
ORDER_OWNERSHIP_MAPPING=HSI
TARGET_NOTIONAL=10000
MAX_POSITION_NOTIONAL=100000
MAX_UNREALIZED_LOSS_PER_SYMBOL=3000
BUY_INTERVAL_SECONDS=60
SIGNAL_BUYCALL=(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-20)
SIGNAL_SELLCALL=(RSI:6>75,MFI>80,D>75,J>100)/3|(J>110)
SIGNAL_BUYPUT=(RSI:6>75,MFI>80,D>75,J>100)/3|(J>120)
SIGNAL_SELLPUT=(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-15)
```

旧字段必须 fail-fast：

- `MONITOR_SYMBOL_1`
- `MONITOR_SYMBOL_2`
- `LONG_SYMBOL_1`
- `SHORT_SYMBOL_1`
- `SIGNAL_BUYCALL_1`
- 所有 monitor 级 `*_1` / `*_2` / `*_N` 配置键

### 运行时上下文

将以下模型收缩：

- `monitorContexts: Map<string, MonitorContext>` 改为 `monitorContext: MonitorContext`
- `lastState.monitorStates: Map<string, MonitorState>` 改为 `lastState.monitorState: MonitorState`
- `createMonitorContexts` 改为 `createMonitorContext`
- `getMonitorContext(monitorSymbol)` 改为直接注入 `monitorContext`，对任务中携带的 monitorSymbol 做唯一配置校验

### 事件驱动链路

保留事件驱动，不保留多 monitor route：

- K 线事件只接受 `event.symbol === tradingConfig.monitor.monitorSymbol`
- business event route 改为单 route state
- indicator cache 改为单队列
- monitor display 改为单显示 route
- quote subscription runtime 仍维护动态 symbol set，但 monitor base 和 seat-bound 只来自唯一 monitor
- monitor quote event runtime 保留 HSI quote route 与交易标的 wakeup，但不再有 symbol 到多个 monitor 的 Set
- switch wakeup route key 收缩为 `direction + seatVersion`

### 唯一 monitor 输入校验语义

单 monitor 不是把所有输入都映射到唯一 context。不同来源的非唯一 `monitorSymbol` 必须按来源区分：

- 外部行情噪声：K 线、quote push、无关交易标的事件若不属于唯一 monitor 或当前 LONG/SHORT 席位，直接丢弃或忽略，不进入业务链路。
- stale 快照：`seatVersion`、`symbol`、`lastSeatActivatedAt` 等快照与当前席位事实不一致时，按失效任务或失效信号显式跳过。
- 内部不变量错误：task 顶层 `monitorSymbol`、task data `monitorSymbol`、delayed verifier entry、verified callback、switch handoff 参数、tracked order / settlement 归属、protective episode、protective completion log 若携带非唯一 `monitorSymbol`，或同一对象内部 monitorSymbol 不一致，必须 fail-fast 或进入对应 async fatal 通道，不得静默跳过、不得映射到唯一 context。
- 恢复事实无法唯一归属：启动、开盘重建、订单恢复、trade log hydration 中涉及订单、日志或保护性清仓事实无法解析到唯一 monitor + LONG/SHORT 时，必须阻断恢复，不得 fallback 到唯一 monitor。

### 方向级边界

以下边界必须保留：

- LONG/SHORT 席位状态
- `seatVersion`
- ACTIVE / EMPTY / SEARCHING / SWITCHING / ACTIVATING 状态机
- 牛证/熊证风险缓存
- LONG/SHORT 订单记录、成本、可卖订单和 pending sell 占用
- LONG/SHORT 日内亏损偏移
- LONG/SHORT 保护性清仓 episode
- LONG/SHORT 清仓后买入冷却
- 自动寻标、距离换标、周期换标的方向级状态

不允许把 LONG/SHORT 合并为一个全局状态，否则会破坏做多和做空两条交易事实链。

## 非目标

- 不重写策略指标算法。
- 不改变普通信号、延迟验证、买入风控、卖出智能平仓、末日保护的业务口径。
- 不删除自动寻标和自动换标功能，只移除多 monitor 外层维度。
- 不把 HSI 写死在代码中。
- 不兼容读取旧 `_1` 配置。
- 不引入 fallback、降级标的、代理盘口或替代 monitor 数据源。

## 实施任务

### Task 1: 配置根类型与解析入口

**Files:**

- Modify: `src/types/config.ts`
- Modify: `src/config/trading/index.ts`
- Modify: `src/config/trading/utils.ts`
- Modify: `src/config/validator/index.ts`
- Modify: `src/config/validator/utils.ts`
- Modify: `src/config/validator/types.ts`
- Modify: `src/constants/index.ts`
- Test: `tests/config/tradingConfig.failfast.business.test.ts`
- Test: `tests/config/*Config.business.test.ts`

- [ ] 将 `MultiMonitorTradingConfig` 改为 `TradingConfig`，根字段为 `monitor` 和 `global`。
- [ ] 删除 `MonitorConfig.originalIndex`。
- [ ] 将 `createMultiMonitorTradingConfig` 重命名为单配置解析入口。
- [ ] 将 `parseMonitorConfig(env, index)` 改为无 index 的单 monitor parser。
- [ ] 删除 `validateMonitorSymbolIndexContinuity`。
- [ ] 删除跨 monitor alias conflict 校验，以及跨 monitor duplicate trading symbol 校验。
- [ ] 删除或改写 `DuplicateSymbol`、`recordTradingSymbolUsage`、`previousIndex` 等只服务跨 monitor 重复标的诊断的类型与 helper，避免留下死类型或旧索引语义。
- [ ] 新增或保留唯一 monitor 内 `LONG_SYMBOL` 与 `SHORT_SYMBOL` 不得相同的配置级 fail-fast 校验；不得只依赖运行时 routing fatal。
- [ ] 增加旧 `_1` / `_2` 配置键 fail-fast 校验。
- [ ] 删除 `TRADING.MAX_MONITOR_SCAN_RANGE`。
- [ ] 更新配置测试，保留关键数值 fail-fast，删除 index gap 和跨 monitor 用例，并新增单 HSI 下 `LONG_SYMBOL === SHORT_SYMBOL` fail-fast 用例。

### Task 2: app 装配与运行时状态

**Files:**

- Modify: `src/app/runtime/createPreGateRuntime.ts`
- Modify: `src/app/runtime/createPostGateRuntime.ts`
- Modify: `src/app/context/createMonitorContexts.ts`
- Modify: `src/app/runtime/createAsyncRuntime.ts`
- Modify: `src/main/asyncProgram/buyProcessor/index.ts`
- Modify: `src/main/asyncProgram/buyProcessor/types.ts`
- Modify: `src/main/asyncProgram/sellProcessor/index.ts`
- Modify: `src/main/asyncProgram/sellProcessor/types.ts`
- Modify: `src/app/lifecycle/createLifecycleRuntime.ts`
- Modify: `src/app/lifecycle/rebuild.ts`
- Modify: `src/app/startup/startupSnapshot.ts`
- Modify: `src/app/runApp.ts`
- Modify: `src/app/startup/runtimeValidation.ts`
- Modify: `src/types/state.ts`
- Modify: `src/app/types.ts`
- Test: `tests/app/context/createMonitorContexts.business.test.ts`
- Test: `tests/app/startup/runtimeValidation.test.ts`
- Test: `tests/app/runtime/createAsyncRuntime.wiring.test.ts`
- Test: `tests/main/asyncProgram/buyProcessor/*.test.ts`
- Test: `tests/main/asyncProgram/sellProcessor/*.test.ts`
- Test: `tests/app/runApp.business.test.ts`

- [ ] 将 pre-gate 和 post-gate runtime 的 `tradingConfig.monitors` 调用改为 `tradingConfig.monitor`。
- [ ] 将 `monitorContexts` Map 改为单 `monitorContext`。
- [ ] 将 `lastState.monitorStates` 改为单 `monitorState`。
- [ ] 将 `createMonitorContexts` 改为单上下文装配函数。
- [ ] async processors 不再通过 Map 查上下文，改为直接接收唯一 context。
- [ ] buy/sell processor 不再接收 `getMonitorContext(monitorSymbol)` 分发函数，改为持有唯一 `monitorContext`。
- [ ] `monitorTaskProcessor` 不再由 `createAsyncRuntime` 注入 `getMonitorContext(monitorSymbol)`；改为接收唯一 `monitorContext` / 唯一 `MonitorTaskContext`，并在 task monitorSymbol 不变量错误时进入明确错误路径。
- [ ] 任务处理入口校验 task.monitorSymbol 等于唯一配置 monitorSymbol。
- [ ] buy/sell processor 入口必须校验 `task.monitorSymbol === tradingConfig.monitor.monitorSymbol`；不匹配属于内部队列不变量错误，必须 fail-fast 或进入 async fatal，不得按普通失效信号拒绝，也不得 warn 后 return。
- [ ] buy/sell processor 中 `seatVersion`、席位 `symbol/status`、触发时间等运行态快照不匹配才属于 stale signal，可按现有显式跳过语义处理。
- [ ] runtime validation 改为读取唯一 `tradingConfig.monitor`，删除 `originalIndex` 依赖，输出去掉 “监控标的 1” 这类编号。
- [ ] 启动校验中的持仓、在途订单、LONG/SHORT 席位标的去重逻辑保留，但不再通过 monitor 数组循环实现。

### Task 3: K 线业务事件与延迟验证缓存

**Files:**

- Modify: `src/main/businessEventProgram/index.ts`
- Modify: `src/main/businessEventProgram/types.ts`
- Modify: `src/main/businessEventProgram/indicatorPipeline.ts`
- Modify: `src/main/businessEventProgram/signalPipeline.ts`
- Modify: `src/main/asyncProgram/indicatorCache/index.ts`
- Modify: `src/main/asyncProgram/indicatorCache/types.ts`
- Modify: `src/main/asyncProgram/delayedSignalVerifier/index.ts`
- Modify: `src/main/asyncProgram/delayedSignalVerifier/types.ts`
- Modify: `src/main/asyncProgram/delayedSignalVerifier/utils.ts`
- Modify: `src/app/wiring/registerDelayedSignalHandlers.ts`
- Test: `tests/main/businessEventProgram/*.test.ts`
- Test: `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
- Test: `tests/main/asyncProgram/indicatorCache/*.test.ts`
- Test: `tests/app/wiring/registerDelayedSignalHandlers.business.test.ts`

- [ ] 将 `routeStates: Map<string, ...>` 改为单 route state。
- [ ] K 线事件只在 symbol 等于唯一 monitorSymbol 时触发。
- [ ] indicator cache 改为单队列。
- [ ] indicator cache 的 `push/getClosest` API 必须二选一收敛：要么删除 monitorSymbol 参数，要么在 cache 内注入唯一 monitorSymbol 并在 `push/getClosest` 入口校验相等；不得保留接收任意 monitorSymbol 但实际读写同一队列的隐性兼容。
- [ ] delayed signal verifier 可保留 signal 的 monitorSymbol 字段，但缓存读取不再按 monitorSymbol 分片。
- [ ] delayed signal verifier 在 `addSignal`、定时 `executeVerification` 和 `performVerification` 读取缓存前必须校验 signal / entry 的 monitorSymbol 等于唯一配置 monitorSymbol；不满足属于内部不变量错误，必须 fail-fast 或进入 async fatal，不得按普通失效信号静默丢弃，也不得读取唯一缓存队列。
- [ ] delayed signal verified 回流接线改为唯一 `monitorContext`，不得继续通过 `monitorContexts.get(signalMonitorSymbol)` 分发。
- [ ] verified 回流时校验 signal.monitorSymbol / callback monitorSymbol 等于唯一配置 monitorSymbol；不满足属于内部不变量错误，必须 fail-fast 或进入 async fatal，不引入兼容路由。
- [ ] 保留 latest-only collapse 和 single-flight 语义。
- [ ] 增加非 HSI K 线事件不推进信号链路的测试。
- [ ] 增加 indicator cache / delayed verifier 负向测试：非唯一 monitorSymbol 的样本或待验证信号不得命中唯一 monitor 的缓存样本。

### Task 4: quote 订阅、quote 事件和显示

**Files:**

- Modify: `src/main/quoteSubscriptionRuntime/index.ts`
- Modify: `src/main/quoteSubscriptionRuntime/types.ts`
- Modify: `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
- Modify: `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
- Modify: `src/main/monitorQuoteEventRuntime/types.ts`
- Modify: `src/main/monitorDisplayRuntime/index.ts`
- Modify: `src/main/monitorDisplayRuntime/types.ts`
- Test: `tests/main/quoteSubscriptionRuntime/quoteSubscriptionRuntime.business.test.ts`
- Test: `tests/main/monitorQuoteEventRuntime/*.test.ts`
- Test: `tests/main/monitorDisplayRuntime/business.test.ts`

- [ ] `MONITOR_BASE` 只保留唯一 monitorSymbol。
- [ ] `SEAT_BOUND` 只从唯一 monitor 的 LONG/SHORT 席位投影。
- [ ] 保留 POSITION_HOLD 和 ORDER_HOLD retain。
- [ ] monitor quote event runtime 改为唯一 monitor route。
- [ ] static liquidation 和 switch wakeup 可按交易标的 symbol 唤醒唯一 monitor。
- [ ] switch route key 改为 `direction + seatVersion`。
- [ ] `SwitchWakeupRuntime.handoffPendingSwitch` 必须校验 `params.monitorSymbol === tradingConfig.monitor.monitorSymbol` 且 `params.monitorContext` 是唯一 monitorContext；monitorSymbol 不匹配或 context identity mismatch 属于内部不变量错误，不得沿用缺 context 即 `return` 的静默路径。
- [ ] monitor display 改为单 route。

### Task 5: 席位注册表、自动寻标与换标

**Files:**

- Modify: `src/services/autoSymbolManager/utils.ts`
- Modify: `src/services/autoSymbolManager/index.ts`
- Modify: `src/services/autoSymbolManager/autoSearch.ts`
- Modify: `src/services/autoSymbolManager/switchStateMachine.ts`
- Modify: `src/services/autoSymbolManager/seatStateManager.ts`
- Modify: `src/main/autoSearchWakeupRuntime/index.ts`
- Modify: `src/main/autoSearchWakeupRuntime/types.ts`
- Modify: `src/main/periodicSwitchWakeupRuntime/index.ts`
- Modify: `src/main/periodicSwitchWakeupRuntime/types.ts`
- Modify: `src/main/seatActivationDispatcher/index.ts`
- Modify: `src/main/seatActivationDispatcher/types.ts`
- Modify: `src/main/seatRuntimeCleanupDispatcher/index.ts`
- Modify: `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts`
- Modify: `src/main/seatRuntimeCleanupDispatcher/types.ts`
- Modify: `src/main/asyncProgram/monitorTaskQueue/index.ts`
- Modify: `src/main/asyncProgram/monitorTaskQueue/types.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/types.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`
- Modify: `src/types/seat.ts`
- Test: `tests/services/autoSymbolManager/*.test.ts`
- Test: `tests/main/autoSearchWakeupRuntime/*.test.ts`
- Test: `tests/main/periodicSwitchWakeupRuntime/business.test.ts`
- Test: `tests/main/seatActivationDispatcher/*.test.ts`
- Test: `tests/main/seatRuntimeCleanupDispatcher/*.test.ts`
- Test: `tests/main/asyncProgram/monitorTaskQueue/*.test.ts`
- Test: `tests/main/asyncProgram/monitorTaskProcessor/*.test.ts`

- [ ] 将 `SymbolRegistry` 内部状态收缩为单 monitor 的 LONG/SHORT store。
- [ ] 公开 API 可继续接收 monitorSymbol，但必须校验等于唯一配置值。
- [ ] `resolveSeatBySymbol` 只检查 LONG/SHORT 两个席位。
- [ ] 自动寻标、距离换标、周期换标保留方向级状态。
- [ ] `autoSearchWakeupRuntime` route key 收缩为 `direction + seatVersion`，seed、seat event、gate event、timer due 均只读取唯一 monitor；这些内部运行态输入携带非唯一 monitorSymbol 时属于不变量错误，必须 fail-fast 或进入 async fatal，不得因为唯一 monitor 存在而继续处理。
- [ ] `periodicSwitchWakeupRuntime` route key 收缩为 `direction`，baseline 继续保留 `symbol + seatVersion + lastSeatActivatedAt` 作快照隔离；seed、seat truth、gate、waiting-empty redispatch 均只读唯一 monitor。
- [ ] `SeatActivationRouteKey` 收缩为 `direction`；`PendingSeatActivation` 继续保留 `seatVersion + oldSymbol`，用于 ACTIVATING 到 `SEAT_REFRESH` 调度时做快照隔离。
- [ ] `AUTO_SYMBOL_TICK` 生产侧 dedupe key 收缩为 `AUTO_SYMBOL_TICK:${direction}`；`SEAT_REFRESH` 生产侧 dedupe key 收缩为 `SEAT_REFRESH:${direction}`。`seatVersion`、`symbol`、`lastSeatActivatedAt` 留在 task data / baseline 中做失效隔离，不再用 monitorSymbol 表达 ownership。
- [ ] `SeatActivationDispatcher.dispatchCurrentActivatingSeats()` 只扫描唯一 monitor 的 LONG/SHORT；启动或开盘重建补调度 `SEAT_REFRESH` 时使用同一 `SEAT_REFRESH:${direction}` dedupe key，若补调度输入出现非唯一 monitorSymbol 或 registry 不变量异常，必须 fail-fast 或进入 async fatal。
- [ ] 删除跨 monitor freeze、跨 monitor route 和多 monitor wakeup 测试。
- [ ] 增加 autoSearch / periodicSwitch 测试：LONG/SHORT 独立路由互不覆盖、旧 seatVersion timer 到期不推进、非唯一 monitorSymbol 的 seat/gate/task 输入不会被静默路由。
- [ ] 删除或改写 monitor task queue 中以多个 `monitorSymbol` 表达多 monitor 并行的测试；保留单 HSI 下不同 `direction + seatVersion` / `dedupeKey` 的 latest-only、FIFO、removeTasks 与 clearAll 语义。
- [ ] 保留方向级 seatVersion 作废测试。
- [ ] monitor task processor 入口必须校验 `task.monitorSymbol === task.data.monitorSymbol === tradingConfig.monitor.monitorSymbol`；`task.monitorSymbol !== task.data.monitorSymbol` 或任一 monitorSymbol 非唯一配置值均为内部不变量错误，必须 fail-fast 或进入 async fatal，不得通过 `getContextOrSkip` 静默跳过。
- [ ] `seatVersion`、`nextSymbol`、`lastSeatActivatedAt` 与当前席位事实不一致才属于 stale task，可显式跳过；生命周期门禁关闭属于 blocked/skipped，不属于 monitorSymbol 不变量错误。
- [ ] `SEAT_REFRESH` 激活入口改为唯一 monitor 校验，保留 `direction + seatVersion` 快照失效门禁。
- [ ] 席位激活刷新仍按 LONG/SHORT 刷新订单记录、daily loss、牛熊证风险和浮亏缓存，成功后才推进到 ACTIVE。
- [ ] 席位退场清理仍通过 `queueCleanup.ts` 按唯一 monitor + LONG/SHORT 方向清理 delayed/buy/sell task 与可取消 monitor task（例如 `AUTO_SYMBOL_TICK`）；`SEAT_REFRESH` 由激活 owner 持有并保留，靠 `seatVersion + symbol` 快照门禁失效，不得在 cleanup 中误删。

### Task 6: 订单归属、订单执行与订单监控恢复

**Files:**

- Modify: `src/core/orderRecorder/orderOwnershipParser.ts`
- Modify: `src/core/orderRecorder/index.ts`
- Modify: `src/core/trader/index.ts`
- Modify: `src/core/trader/orderExecutor/index.ts`
- Modify: `src/core/trader/orderExecutor/submitFlow.ts`
- Modify: `src/core/trader/orderExecutor/types.ts`
- Modify: `src/core/trader/orderExecutor/utils.ts`
- Modify: `src/core/trader/orderExecutor/buyThrottle.ts`
- Modify: `src/core/trader/orderMonitor/recoveryFlow.ts`
- Modify: `src/core/trader/orderMonitor/orderOps.ts`
- Modify: `src/core/trader/orderMonitor/eventFlow.ts`
- Modify: `src/core/trader/orderMonitor/settlementFlow.ts`
- Modify: `src/core/trader/orderMonitor/routingIndex.ts`
- Modify: `src/core/trader/orderMonitor/routeRuntime.ts`
- Modify: `src/core/trader/types.ts`
- Modify: `src/core/signalProcessor/types.ts`
- Modify: `src/core/signalProcessor/riskCheckPipeline.ts`
- Test: `tests/core/orderRecorder/*.test.ts`
- Test: `tests/core/trader/orderMonitor/*.test.ts`
- Test: `tests/core/trader/index.business.test.ts`

- [ ] `resolveOrderOwnership` 改为接收唯一 monitorConfig。
- [ ] 方向仍由 RC/RP、Bull/Bear、Call/Put 标记解析。
- [ ] 交易执行直接使用唯一 monitorConfig，并校验信号 symbol 属于 LONG/SHORT 当前席位。
- [ ] order executor 提交链路的 `monitorConfig` 必须为唯一 monitor 的必填依赖；`submitFlow`、`trackOrder` 和订单状态事件不得再以缺少 monitorConfig 降级为 `monitorSymbol: null`。
- [ ] `orderExecutor/buyThrottle` 的买入频率限制 key 收缩为方向级 key。`riskCheckPipeline` 的 10 秒风险检查冷却当前按交易标的 + 买入方向限流，不属于同一节流语义；是否收缩必须单独决策，本计划不改变其业务口径。
- [ ] `trackOrder`、`FinalizeOrderSettlementParams`、`OrderStateChangedEvent`、follow-up sell handoff 中携带的 monitorSymbol 必须为唯一配置 monitor；非唯一或需要成交归因时为 null 属于不变量错误，不得静默跳过 daily loss、protective episode、pending sell 占用或 order state changed 副作用。
- [ ] 增加提交链路负向测试：缺少唯一 `monitorConfig`、下单成功后 `trackOrder` 本地同步失败、或成交归因事件出现 `monitorSymbol: null` 时必须 fail-fast / async fatal。
- [ ] 订单监控恢复仍要求卖单可归属且与当前席位匹配。
- [ ] 保留卖单无法归属或席位不匹配时阻断恢复的 fail-fast 行为。
- [ ] pending buy 恢复同样不得 fallback 到唯一 monitor；无法归属或席位不匹配时只能按现有严格路径尝试撤单并等待权威终态，若无法确认安全收口必须阻断恢复。
- [ ] 增加订单恢复负向测试：pending sell 缺少 RC/RP 或 mapping 不匹配时阻断恢复，不允许 fallback 到唯一 monitor。
- [ ] 增加订单恢复负向测试：pending sell 归属方向与当前席位 symbol 不匹配时阻断恢复；断言 runtime 回到 `STOPPED`，且 tracked orders 与 pending sell 占用被清理。
- [ ] 增加订单恢复负向测试：pending buy 缺少 RC/RP、mapping 不匹配、归属方向与当前席位 symbol 不匹配、撤单请求后无法确认终态时均不得归到唯一 monitor，必须阻断恢复。

### Task 7: 风控、亏损、清仓冷却与保护性清仓

**Files:**

- Modify: `src/core/riskController/dailyLossTracker.ts`
- Modify: `src/core/riskController/unrealizedLossMonitor.ts`
- Modify: `src/core/riskController/utils.ts`
- Modify: `src/types/risk.ts`
- Modify: `src/services/liquidationCooldown/index.ts`
- Modify: `src/services/liquidationCooldown/tradeLogHydrator.ts`
- Modify: `src/services/liquidationCooldown/utils.ts`
- Modify: `src/services/liquidationCooldown/types.ts`
- Modify: `src/core/trader/protectiveLiquidationEpisodeTracker/index.ts`
- Modify: `src/core/trader/protectiveLiquidationEpisodeTracker/types.ts`
- Modify: `src/app/runtime/createPostTradeConsistencyRuntime.ts`
- Modify: `src/app/types.ts`
- Modify: `src/main/tradingRiskEventRuntime/routingIndex.ts`
- Modify: `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`
- Modify: `src/main/tradingRiskEventRuntime/types.ts`
- Modify: `src/main/tradingRiskEventRuntime/routeValidation.ts`
- Modify: `src/main/tradingRiskEventRuntime/unrealizedLossExecutor.ts`
- Test: `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`
- Test: `tests/core/riskController/*.test.ts`
- Test: `tests/services/liquidationCooldown/*.test.ts`
- Test: `tests/main/tradingRiskEventRuntime/*.test.ts`

- [ ] `DailyLossTracker` 内部从 monitor Map 改为单 `{ long, short }` 状态。
- [ ] `DailyLossTracker` 公开契约同步从 `monitors[]` 收缩为唯一 `monitorConfig` 或绑定唯一 monitor 的依赖；`recalculateFromAllOrders`、`DailyLossTrackerDeps.resolveOrderOwnership` 不得继续暴露多 monitor 数组。
- [ ] 保护性边界 key 收缩为方向级 key。
- [ ] 清仓冷却保留 LONG/SHORT 两条记录。
- [ ] 保留当前清仓冷却买入拦截业务语义：冷却记录、触发计数和 episode 按 LONG/SHORT 独立维护，但买入前清仓冷却门禁按唯一 monitor 的 LONG/SHORT 双方向共同检查，并使用剩余冷却时间最大值拦截；不得在本重构中改为“只拦截当前买入方向”。
- [ ] trade log hydrator 只接受唯一 monitorConfig。
- [ ] trade log hydrator 读取到已存在但 JSON 解析失败、顶层结构非法或记录结构无法判断是否为保护性清仓完成事实的日志文件时，必须 fail-fast 并阻断启动/重建；不存在的日志文件才可视为无恢复事实。
- [ ] trade log hydrator 遇到保护性清仓完成日志缺少 monitorSymbol、monitorSymbol 非唯一配置、action 无法解析 LONG/SHORT、executedAt / executedAtMs 无效时必须 fail-fast 并阻断启动/重建，不得 `continue` 跳过。
- [ ] post-trade consistency business deps 改为唯一 monitorContext，不再构建多 monitor symbol -> context Map。
- [ ] post-trade consistency 扫描 in-progress protective episode 时必须校验 `episode.monitorSymbol === tradingConfig.monitor.monitorSymbol`；不匹配属于恢复/运行态不变量错误，必须 fail-fast，不得 `continue` 或映射到唯一 context。
- [ ] 成交后保护性清仓完成判定仍按方向推进 daily loss episode 与 liquidation cooldown。
- [ ] trading risk routing index 输入改为唯一 monitorContext；`TradingRiskEventRuntimeDeps` 不再接收 `monitorContexts` Map。
- [ ] `TradingRiskRouteKey` 收缩为方向级 key；`buildTradingRiskRoutingIndex` 只投影唯一 monitor 的 LONG/SHORT，`routeValidation` 按方向 route + `seatVersion` 校验当前性，不得继续用 `monitorSymbol:direction` 表达 route ownership。
- [ ] 保护性清仓执行中，远端下单已成功但本地 `trackOrder`、pending protective sell、成交归因或结算同步失败时，必须抛出并进入 async fatal；只有未触发清仓、行情无效、无可用持仓或数量为零这类业务无动作可返回 false。
- [ ] 保留 LONG/SHORT 绑定同一 trading symbol 时 fail-fast，防止方向归属冲突。

### Task 8: 生命周期、启动快照与开盘重建

**Files:**

- Modify: `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
- Modify: `src/main/lifecycle/rebuildTradingDayState.ts`
- Modify: `src/main/lifecycle/tradingCalendarPrewarmer.ts`
- Modify: `src/main/lifecycle/cacheDomains/seatDomain.ts`
- Modify: `src/main/lifecycle/cacheDomains/riskDomain.ts`
- Modify: `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
- Modify: `src/main/lifecycle/cacheDomains/globalStateDomain.ts`
- Modify: `src/main/lifecycle/cacheDomains/types.ts`
- Modify: `src/main/recovery/seatPreparation.ts`
- Modify: `src/main/recovery/types.ts`
- Modify: `src/main/utils.ts`
- Modify: `src/main/lifecycle/types.ts`
- Modify: `src/main/lifecycle/seatActivationCarryover.ts`
- Test: `tests/main/lifecycle/*.test.ts`
- Test: `tests/main/lifecycle/cacheDomains/*.test.ts`
- Test: `tests/main/recovery/seatPreparation.business.test.ts`

- [ ] 启动快照只订阅唯一 monitor 的 K 线。
- [ ] 运行时 quote symbols 从唯一 monitor、LONG/SHORT 席位、持仓、订单持有集合汇总。
- [ ] 开盘重建只同步唯一 monitorContext。
- [ ] 订单记录、牛熊证风险、浮亏缓存仍覆盖 LONG/SHORT。
- [ ] 午夜清理只清理唯一 monitor 的方向级状态。
- [ ] 交易日历预热仍基于当前未平仓买单窗口，不按多 monitor 分组。
- [ ] 启动快照与开盘重建恢复保护性清仓边界、进行中 episode、pending protective sell 时，相关订单或日志必须能解析到唯一 monitor + LONG/SHORT 方向；缺少 RC/RP、mapping 不匹配、解析出非唯一 monitor 或方向与当前席位不匹配，均必须阻断恢复。
- [ ] 启动快照与开盘重建读取到已存在但损坏、非数组或结构非法的交易日志文件时，必须阻断恢复，不得按空日志继续放行交易。
- [ ] 启动快照与开盘重建恢复保护性清仓完成日志时，缺少 monitorSymbol、monitorSymbol 非唯一配置、action 无法解析 LONG/SHORT、executedAt / executedAtMs 无效，均必须阻断恢复，不得跳过后继续放行交易。
- [ ] 保护性清仓恢复不得 fallback 到唯一 monitor，也不得跳过无法归属的保护性清仓订单后继续放行交易；该类跳过会破坏冷却、亏损分段与 pending protective order 判定。

### Task 9: 系统级时间、末日保护、展示与收尾入口

**Files:**

- Modify: `src/main/timeWakeupEvaluationProgram/index.ts`
- Modify: `src/main/timeWakeupEvaluationProgram/types.ts`
- Modify: `src/core/doomsdayProtection/index.ts`
- Modify: `src/core/doomsdayProtection/types.ts`
- Modify: `src/main/tradingQuoteDisplayRuntime/index.ts`
- Modify: `src/main/tradingQuoteDisplayRuntime/types.ts`
- Modify: `src/app/shutdown/createCleanup.ts`
- Modify: `tests/app/shutdown/utils.ts`（如测试辅助仍暴露多 monitor 结构）
- Test: `tests/main/timeWakeupEvaluationProgram/business.test.ts`
- Test: `tests/main/timeWakeupRuntime/business.test.ts`
- Test: `tests/main/timeWakeupPlanner/business.test.ts`
- Test: `tests/integration/doomsday.integration.test.ts`
- Test: `tests/main/tradingQuoteDisplayRuntime/business.test.ts`
- Test: `tests/app/shutdown/createCleanup.business.test.ts`

- [ ] time wakeup evaluation 改为操作唯一 `monitorContext`，取消普通延迟验证时不再遍历 monitor Map。
- [ ] 末日保护撤买与清仓入口改为唯一 monitorConfig + monitorContext，仍保留 LONG/SHORT 分别清仓。
- [ ] trading quote display routing 改为唯一 monitorContext 的 LONG/SHORT route，不再从 monitorContexts Map 构建多 monitor 索引。
- [ ] cleanup 销毁唯一 delayedSignalVerifier、清空唯一 monitorState 快照，不再遍历 monitorContexts / monitorStates。
- [ ] 这些系统级入口不得新增旧 monitor 数组兼容，也不得把不存在的 monitorSymbol 静默路由到唯一 context。

### Task 10: 测试、文档和残留清理

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: 当前入口文档中仍作为目标态引用多 monitor 的内容（至少 `README.md`、`.env.example`、当前计划文档）
- Mark historical: 历史归档文档中仍描述旧 per-monitor / multi-monitor 目标态的内容
- Modify: `mock/factories/configFactory.ts`
- Modify: `tests/helpers/testDoubles.ts`
- Modify: 多 monitor 相关测试文件
- Test: `tests/app/runtime/*.test.ts`
- Test: `tests/app/lifecycle/*.test.ts`
- Test: `tests/app/startup/*.test.ts`
- Test: `tests/app/wiring/*.test.ts`
- Test: `tests/app/shutdown/*.test.ts`
- Test: `tests/main/timeWakeupEvaluationProgram/*.test.ts`
- Test: `tests/main/tradingQuoteDisplayRuntime/*.test.ts`
- Test: `tests/integration/*.test.ts`

- [ ] `.env.example` 改为单 HSI monitor 配置示例。
- [ ] README 删除多标的配置规则和 `_1/_2/_N` 示例。
- [ ] 测试工厂改为 `TradingConfig { monitor, global }`。
- [ ] 额外检查并更新测试辅助：`tests/**/utils.ts`、`tests/helpers/**`、`mock/**` 中不得继续暴露 `monitors[]`、`monitorContexts Map`、`monitorStates Map` 或多 monitor 默认样例。
- [ ] 删除 index gap、cross-monitor、multiple monitors do not conflict 测试。
- [ ] 保留并强化 LONG/SHORT 方向隔离测试。
- [ ] 当前入口文档必须改写为单 HSI monitor 目标；至少包含根 `README.md`、`.env.example`、`docs/README.md` 与当前计划文档。
- [ ] 额外检查当前协作/规则入口：`CLAUDE.md`、`AGENTS.md`、`.agents/**`、`.codex/**` 中若仍描述当前目标态为多 monitor，必须更新或明确标记为历史/技能上下文，不得与本计划冲突。
- [ ] 历史归档文档若保留旧 per-monitor / multi-monitor 描述，必须归入 `historical allowed docs`，不得作为当前目标态引用；典型范围包括 `docs/plans/**`、`docs/issues/**`、`docs/superpowers/**` 中的历史方案或问题记录。
- [ ] 对残留搜索命中的文档按 `current active docs` / `historical allowed docs` 分类复核并记录，最终说明必须列出保留原因、路径范围与是否仍可能误导当前实现。

## 必须保留的业务验证

- HSI K 线事件推进指标计算和信号生成。
- 开盘保护期间普通信号短路。
- 延迟验证样本写入与回流验证。
- 买入前风险顺序不变：频率、冷却、买入价格、末日拒买、牛熊证风险、账户持仓、基础风控、记录买入尝试。
- 卖出不走买入风控，仍等待成交后 freshness。
- 成交后 post-trade consistency 仍先刷新账户/持仓事实，再推进保护性清仓完成、亏损分段、清仓冷却和浮亏缓存刷新。
- 席位激活刷新仍在行情准入、订单记录、daily loss、牛熊证风险、浮亏缓存完成后才将席位推进 ACTIVE。
- 智能平仓三阶段不变。
- 保护性清仓完成后才推进冷却与亏损分段。
- 清仓冷却记录按 LONG/SHORT 独立，但买入拦截仍按同一 monitor 的 LONG/SHORT 双方向共同门禁。
- 末日清仓接管窗口仍阻断普通链路。
- 订单恢复中卖单无法归属或与席位不匹配仍阻断恢复。
- 启动/重建恢复保护性清仓事实时，无法唯一归属到当前 monitor + direction 必须阻断恢复。

## 删除或改写的测试契约

必须删除或改写：

- `_1/_3` 缺 `_2` 的配置断档测试。
- 多 monitor alias conflict 测试。
- 多 monitor duplicate trading symbol 测试。
- 多 monitor context 装配测试。
- 多 monitor K 线订阅测试。
- monitor task queue 中以 `A/B/C` 等多个 `monitorSymbol` 表达多 monitor 并行的测试。
- cooldown by monitor symbol 隔离测试。
- trading risk duplicate ownership across monitors 测试。
- switch wakeup multiple monitors do not conflict 测试。
- trading quote display multiple monitor route 测试。
- post-trade consistency duplicate ownership across monitors 测试。
- doomsday protection multi monitor iteration 测试。

必须新增或保留：

- 无下标配置解析成功。
- 旧 `_1` 配置 fail-fast。
- 多余 `MONITOR_SYMBOL_2` fail-fast。
- 单 HSI 下 LONG/SHORT 席位独立。
- 单 HSI 下 LONG/SHORT 清仓冷却独立。
- 单 HSI 下 LONG 清仓冷却激活时，SHORT 买入也被清仓冷却门禁拦截；SHORT 反向同理，用于锁定当前双方向共同买入门禁语义。
- 单 HSI 下 LONG/SHORT 绑定同一 trading symbol fail-fast。
- 单 HSI 下 monitor task queue 保留按不同 `direction + seatVersion` / `dedupeKey` 的 latest-only、FIFO 和清理语义。
- 单 HSI 下 `AUTO_SYMBOL_TICK` 与 `SEAT_REFRESH` 的 `task.monitorSymbol`、`task.data.monitorSymbol`、配置 monitorSymbol 不一致时，不会被静默跳过或路由到唯一 context。
- 单 HSI 下席位退场清理 delayed/buy/sell/monitor task 时只清理对应 LONG/SHORT 方向。
- 单 HSI 下 pending sell 无法解析归属或与当前席位不匹配时阻断订单恢复。
- 单 HSI 下保护性清仓恢复遇到缺少 RC/RP、mapping 不匹配、非唯一 monitorSymbol 或方向与当前席位不匹配时阻断启动/开盘重建。
- 非 HSI K 线事件不推进普通信号链路。
- 非 HSI delayed verifier 样本或待验证信号不读取唯一 HSI indicator cache。
- HSI 配置启动到 K 线信号入队的集成测试。
- 单 HSI 下 verified delayed signal 回流进入正确买卖队列。
- 单 HSI 下 `SEAT_REFRESH` 完成订单、daily loss、风险缓存与 ACTIVE 激活。
- 单 HSI 下 post-trade consistency 完成保护性清仓后推进冷却与亏损分段。
- 单 HSI 下 post-trade consistency 遇到非唯一 monitorSymbol 的 in-progress protective episode 时 fail-fast。
- 单 HSI 下末日保护仍分别处理 LONG/SHORT 持仓。

## 残留搜索清单

重构完成前必须执行以下搜索，并逐项确认生产代码、测试、文档是否仍有残留：

```powershell
rg -n "(MONITOR_SYMBOL|LONG_SYMBOL|SHORT_SYMBOL|ORDER_OWNERSHIP_MAPPING|TARGET_NOTIONAL|MAX_POSITION_NOTIONAL|MAX_UNREALIZED_LOSS_PER_SYMBOL|BUY_INTERVAL_SECONDS|AUTO_SEARCH_[A-Z_]+|SWITCH_[A-Z_]+|LIQUIDATION_(COOLDOWN_MINUTES|TRIGGER_LIMIT)|SMART_CLOSE_[A-Z_]+|SIGNAL_[A-Z]+|VERIFICATION_[A-Z_]+|STRATEGY_[A-Z_]+)_[0-9N]" src tests mock docs README.md .env.example
rg -n "createMultiMonitorTradingConfig|MultiMonitorTradingConfig|MultiMonitor" src tests mock docs README.md .env.example
rg -n "tradingConfig\\.monitors|monitorContexts|monitorContexts\\.get|monitorContexts\\.set|monitorContexts\\.has|monitorContexts\\.values|getMonitorContext|monitors\\.map|monitors\\.forEach|monitors\\[[0-9]+\\]|\\.monitors\\[|monitors:\\s*\\[|Pick<.*'monitors'>|for \\(const monitor" src tests mock docs
rg -n "originalIndex|监控标的 [0-9]|做多席位标的 [0-9]|做空席位标的 [0-9]" src tests mock docs README.md .env.example
rg -n "per-monitor|cross-monitor|multi-monitor|multiple monitors|同时监控多个|多个监控标的|多标的|每个监控标的|监控标的 2" src tests mock docs README.md .env.example
rg -n "HSCEI\\.HK|HHI\\.HK|TECH\\.HK|0981\\.HK|9988\\.HK" tests mock docs README.md .env.example src
rg -n "重复归属|ownership alias conflicts across monitors|owned by multiple monitors|multiple monitors do not conflict|multi-monitor-concurrency" tests docs src
Get-ChildItem -Recurse tests -Filter utils.ts
rg -n "tradingConfig\\.monitors|monitorContexts|monitorStates|lastState\\.monitorStates|MultiMonitor|monitors:\\s*\\[" tests/helpers tests mock .agents .codex docs/README.md CLAUDE.md AGENTS.md
```

允许保留的情况必须在最终说明中逐项列明，例如历史归档文档中明确标记为旧方案的引用。生产代码和当前测试目标不应再依赖多 monitor 契约。

## 验证命令

分阶段验证：

```powershell
bun test tests/config/tradingConfig.failfast.business.test.ts
bun test tests/app/runtime tests/app/lifecycle tests/app/startup tests/app/context/createMonitorContexts.business.test.ts tests/app/wiring tests/app/shutdown
bun test tests/main/businessEventProgram tests/main/asyncProgram/buyProcessor tests/main/asyncProgram/sellProcessor tests/main/asyncProgram/delayedSignalVerifier tests/main/asyncProgram/indicatorCache tests/main/asyncProgram/monitorTaskQueue tests/main/asyncProgram/monitorTaskProcessor
bun test tests/main/quoteSubscriptionRuntime tests/main/monitorQuoteEventRuntime tests/main/monitorDisplayRuntime tests/main/tradingQuoteDisplayRuntime
bun test tests/main/autoSearchWakeupRuntime tests/main/periodicSwitchWakeupRuntime tests/main/seatActivationDispatcher tests/main/seatRuntimeCleanupDispatcher
bun test tests/main/timeWakeupEvaluationProgram tests/main/timeWakeupRuntime tests/main/timeWakeupPlanner
bun test tests/core/signalProcessor tests/core/orderRecorder tests/core/trader tests/core/riskController tests/services/liquidationCooldown
bun test tests/main/lifecycle tests/main/recovery tests/main/tradingRiskEventRuntime tests/integration
```

最终验证：

```powershell
bun type-check
bun lint
bun test
bun run build
```

收尾验证：

```powershell
Get-Process | Where-Object { $_.ProcessName -match '^(bun|node|tsc|eslint)$' } | Select-Object Id,ProcessName,Path,StartTime
rg -n "test\\.only|describe\\.only|it\\.only" tests src
git status --short --branch
```

## 风险与控制

- 配置层风险：如果保留旧 `_1` 读取，会形成隐性兼容路径，后续面板仍可能继续输出多标的字段。控制方式是旧键 fail-fast。
- 配置层风险：如果把当前 duplicate trading symbol 校验整体删除，会同时误删唯一 monitor 内 LONG/SHORT 同标的 fail-fast。控制方式是删除跨 monitor 重复校验时，显式保留单 monitor 内 LONG/SHORT 不得相同的配置级校验。
- 事件链路风险：如果只把 `monitors[0]` 包装为唯一 monitor，per-monitor route Map 仍会保留多标的能力。控制方式是删除外层 Map。
- 队列清理风险：如果只改 dispatcher 外壳而遗漏 `monitorTaskQueue` 与 `queueCleanup.ts`，旧的多 monitor 测试契约或非唯一 monitorSymbol 路由仍可能残留。控制方式是把 monitor task queue 与席位退场队列清理纳入任务与验证。
- 缓存风险：如果 indicator cache 表面改成单队列但 API 仍接收任意 monitorSymbol 且不校验，会让非 HSI delayed signal 读取 HSI 样本。控制方式是删除 monitorSymbol 参数或在 cache/verifier 双入口做唯一 monitor 校验。
- 唤醒路由风险：autoSearch / periodicSwitch 若只从 `tradingConfig.monitors[0]` seed，却保留 `monitorSymbol` route key 与找不到 context 即跳过的路径，会残留多 monitor 分发和静默吞错。控制方式是 route key 收缩到方向级并对外部事件 monitorSymbol fail-fast。
- 风控风险：如果把 monitor 维度和方向维度一起删除，会导致 LONG/SHORT 亏损、冷却、保护性清仓互相污染。控制方式是明确保留方向级状态。
- 风控风险：如果误把清仓冷却买入拦截改成只查当前方向，会改变现有“同 monitor 双方向共同门禁”的业务语义。控制方式是计划和测试同时锁定记录独立、买入拦截共享。
- 恢复风险：订单归属改造若过度简化，会导致恢复期卖单不能安全匹配席位。控制方式是保留无法归属或席位不匹配即阻断恢复。
- 恢复风险：保护性清仓恢复若跳过无法归属订单，会遗漏 pending protective sell、冷却边界或亏损分段边界。控制方式是保护性清仓订单/日志恢复必须唯一归属失败即阻断。
- 系统入口风险：time wakeup、末日保护、post-trade consistency、seat refresh、cleanup 若保留 `monitorContexts` Map，会形成隐藏多 monitor 分发核心。控制方式是把这些入口纳入任务清单并改为唯一 context + 显式 monitorSymbol 校验。
- 文档风险：历史计划若继续描述 per-monitor 目标态，后续实现会被旧文档误导。控制方式是把当前方案作为新的目标态；当前入口文档必须改写，历史归档文档必须标记为历史方案或列入允许保留清单。

## 完成标准

- 配置面板无 `_1`、`_2`、`_N`。
- 根配置无 `monitors[]`。
- 运行时无 `monitorContexts Map` 作为业务分发核心。
- 启动校验、延迟验证回流、post-trade consistency、SEAT_REFRESH、time wakeup、末日保护、trading quote display 和 cleanup 均不再通过 monitor 数组或 monitorContexts Map 分发。
- K 线业务链路只处理唯一配置 monitor。
- autoSearch、periodicSwitch、monitor task、indicator cache、delayed verifier 对非唯一 monitorSymbol 均无静默路由或缓存命中。
- quote 订阅仍能覆盖 HSI、LONG/SHORT 交易标的、持仓和在途订单。
- LONG/SHORT 方向级风险、订单和冷却边界全部保留。
- 清仓冷却买入拦截保留同 monitor 双方向共同门禁语义。
- 保护性清仓启动/重建恢复无法唯一归属时阻断恢复，不 fallback 到唯一 monitor。
- 旧多 monitor 测试已删除或改写为单 HSI + 方向隔离测试。
- 测试辅助不再暴露 `monitorContexts` / `monitorStates` 旧根结构。
- 残留搜索清单通过复核。
- `bun type-check`、`bun lint`、`bun test`、`bun run build` 通过。
- 收尾无无关测试或构建进程残留。
