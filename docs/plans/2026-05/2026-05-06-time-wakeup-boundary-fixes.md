# 系统级时间唤醒 owner 边界与长 timer 修复复盘

## 背景

本次重构围绕系统级时间唤醒、局部业务 timer owner、自动寻标与周期换标的边界进行收敛。中断恢复后，团队复核和直接取证结论表明，真实必须修复的问题集中在以下几类：

- 系统级固定 recovery retry 会把 API 边界错误转化成运行时层面的无限恢复循环。
- 非法时间计划会导致系统级时间唤醒静默停摆。
- 超长 timer delay 可能触发平台 `TimeoutOverflowWarning`，并被运行时钳制为立即触发。
- 周期换标 runtime 自身已有测试，但缺少真实 wiring 组合测试。
- 自动寻标、周期 due、开盘延迟相关命名和注释存在语义债。
- 初始 time wakeup fatal 与 cleanup 交互存在启动期错误传播漏洞。

## 发现的问题

### 1. 系统级固定 recovery retry 违反 owner 边界

原行为中，`TimeWakeupRuntime` 持有通用 `recoveryRetryDelayMs`。当 `evaluate()` 抛错时，runtime 会按固定间隔重新安排系统级 retry。

问题：

- API 调用失败属于 API client 边界，应由 `quoteClient.withRetry()` 负责有限重试。
- 系统级时间 owner 不应制造通用恢复候选，否则会掩盖真实失败来源。
- retry 耗尽后继续在 runtime 层固定重试，会把 fail-fast 语义变成保护性停摆。

### 2. 交易日 API 失败被转换为 RECOVERY_RETRY

`timeWakeupEvaluationProgram` 曾 catch `marketDataClient.isTradingDay` 失败，并制造 `RECOVERY_RETRY` candidate。

问题：

- 交易日状态是时间评估的权威输入，失败后不能继续构造“不确定但可恢复”的业务计划。
- `RECOVERY_RETRY` 来源把 API 边界和系统级时间规划混在一起。
- 这会让调用方以为系统仍在正常规划，而实际交易日事实未知。

### 3. 非法 nextWakeupAtMs 静默停摆

当评估返回非有限 `nextWakeupAtMs` 时，runtime 旧逻辑只停止系统级时间唤醒。

问题：

- 非法计划是系统级错误，应可观测、可传播。
- 静默停止会让 `runApp` 继续运行，但时间唤醒 owner 已失效。

### 4. 超长 timer delay 未做平台边界保护

多个局部 owner 使用原生 `setTimeout(callback, atMs - nowMs)`。

受影响 owner：

- `TimeWakeupRuntime`
- `orderMonitor/routeRuntime`
- `periodicSwitchWakeupRuntime`
- `autoSearchWakeupRuntime`

问题：

- JavaScript runtime 对超过最大安全 timer delay 的值会钳制或溢出。
- 超长业务 due 可能被立即触发，破坏 due 语义。
- 不能用业务轮询替代，否则会引入新的 owner 语义偏移。

### 5. runApp 初始 fatal 与 cleanup 传播不完整

复核阶段额外发现两个启动期问题：

- `timeWakeupRuntime.start()` 初始评估进入 fatal 时，`runApp` 可能继续启动 `businessEventProgram`。
- `Promise.race` 收到 time wakeup fatal 后，如果 `cleanup.execute()` 也抛错，cleanup 错误会覆盖原始 fatal。

问题：

- 初始 fatal 必须阻止后续普通业务 runtime 启动。
- cleanup 是退出清理动作，不应覆盖导致退出的根因。

### 6. 命名和注释语义债

部分命名仍把 due-event 语义描述成 tick/interval，自动寻标开盘延迟也容易被误读为全局开盘保护。

问题：

- 周期换标实际由 due timer owner 推进，不是固定 interval 轮询。
- 自动寻标开盘延迟只限制自动寻标，不等同于普通信号开盘保护。
- 旧命名会误导后续维护者把边界重新做回轮询或保护性兜底。

## 修复方案

### 1. 严格系统级 owner 边界

修复方向：

- 移除 `TimeWakeupRuntimeDeps.recoveryRetryDelayMs`。
- `TimeWakeupRuntime` 不再对 `evaluate()` 异常安排固定 retry。
- `evaluate()` 异常进入 fatal 状态。
- 非法 `nextWakeupAtMs` 进入 fatal 状态。
- 新增 `drainFatalError(): Promise<never>`，供 app 层观测 fatal。

结果：

- 系统级时间 owner 只负责 explicit business candidate 的 one-shot 唤醒。
- API 失败不会被 runtime 层二次 retry。
- fatal 可被 `runApp` 感知并向上抛出。

### 2. 交易日 API 失败向上抛出

修复方向：

- 删除 `TimeWakeupCandidateSource` 中的 `RECOVERY_RETRY`。
- 删除 `timeWakeupEvaluationProgram` 内部对 `marketDataClient.isTradingDay` 的 catch。
- 交易日 API 失败由 API client 边界有限 retry；耗尽后向上抛出。

结果：

- `timeWakeupEvaluationProgram` 不再制造系统级 recovery candidate。
- 交易日状态未知时 fail-fast。
- 时间唤醒 runtime 将该错误转为 fatal，交给 app 生命周期处理。

### 3. runApp fatal 可观测与 cleanup 后重抛

修复方向：

- `runApp` 使用 `Promise.race([timeWakeupRuntime.start(), timeWakeupRuntime.drainFatalError()])` 等待初始 time wakeup。
- 初始 fatal 发生时阻止 `businessEventProgram.start()`。
- 稳态运行也继续 race shutdown 与 `drainFatalError()`。
- 捕获运行期原始错误后执行 cleanup。
- cleanup 失败时记录 cleanup 错误，但优先重抛原始 fatal。

结果：

- 初始评估 fatal 不再继续启动普通 K 线业务事件。
- cleanup 不会覆盖导致退出的根因。
- shutdown 正常路径仍执行 cleanup。

### 4. bounded one-shot timer 统一边界

新增 `src/utils/timer`：

- `scheduleBoundedOneShotAt()` 接收目标 epoch 毫秒时间。
- 若目标时间非法，直接 fail-fast 抛错。
- 若目标已到，注册 `0ms` one-shot，避免同步重入。
- 若目标超过平台最大 timer delay，只注册最大安全分段。
- 分段回调只重新判断时间是否到达 due。
- 未到 due 时继续安排下一段；到 due 时调用 `onDue`。
- `cancel()` 清理当前分段 timer。

应用到：

- `TimeWakeupRuntime`
- `orderMonitor/routeRuntime`
- `periodicSwitchWakeupRuntime`
- `autoSearchWakeupRuntime`

约束：

- 分段只处理平台 timer 上限。
- 不做业务轮询。
- 每次 due 回调仍由对应 owner 重新读取权威状态。

### 5. 周期换标真实 wiring 覆盖

补充测试覆盖真实 `calculateTradingDurationDueAtMs` wiring：

- 从 seat `lastSeatActivatedAt` 出发。
- 使用交易日历快照计算交易时长 due。
- 验证午休等非连续交易时段被跳过。
- 验证 runtime 按真实 due 注册 timer。

结果：

- 周期换标 runtime 不只验证 fake `calculateDueAtMs`。
- app wiring 的真实交易时长语义有测试保护。

### 6. 末日保护 action 级测试

补充测试覆盖：

- 买入截止窗口调用 `cancelPendingBuyOrders`。
- 清仓接管窗口调用 `executeClearance`。
- `executeClearance` 返回 `nextRetryAtMs` 时规划 `DOOMSDAY_RETRY`。
- 清仓执行路径触发 position hold reconcile 回调。

结果：

- 不只验证窗口入口 candidate。
- 末日保护 action 行为有直接测试约束。

### 7. 命名和注释同步

修复方向：

- 将周期换标相关测试变量从 `intervalCalls` 调整为 `periodicDueCalls`。
- 将错误文案从 `periodic tick failed` 调整为 `periodic due failed`。
- 自动寻标依赖命名使用 `isWithinMorningAutoSearchOpenDelay`，表达自动寻标自身延迟语义。
- 通用时间工具中将早盘窗口函数调整为 `isWithinMorningOpenWindow`，避免把所有调用都绑定到“保护”语义。
- 保留 `AUTO_SYMBOL_TICK` 任务枚举，不在本次扩大为全量任务类型改名。

结果：

- 减少 interval/tick 误导。
- 自动寻标开盘延迟与普通开盘保护边界更清晰。
- 避免为了命名债扩大风险面。

## 测试补充

新增或增强的关键测试包括：

- API retry 耗尽后 time wakeup fatal，而不是 `RECOVERY_RETRY`。
- 非法 `nextWakeupAtMs` 触发 fatal。
- 系统级候选 → timer → gate state 变化组合测试。
- `TimeWakeupRuntime` 超长 timer 分段测试。
- `routeRuntime` 超长 route timer 分段测试。
- `autoSearchWakeupRuntime` 自动寻标开盘延迟超长 timer 分段测试。
- `periodicSwitchWakeupRuntime` 超长 due timer 分段测试。
- 周期换标真实 `calculateTradingDurationDueAtMs` wiring 测试。
- 末日保护买入截止 action 测试。
- 末日保护清仓接管 action 与 retry 规划测试。
- `runApp` 初始 time wakeup fatal 阻止 ordinary business event 测试。
- `runApp` cleanup 失败不覆盖原始 fatal 测试。

## 验证结果

最终验证命令和结果：

```bash
bun format
bun lint
bun type-check
bun test tests/main/timeWakeupRuntime/business.test.ts tests/main/timeWakeupEvaluationProgram/business.test.ts tests/utils/timer.business.test.ts tests/core/trader/orderMonitor/routeRuntime.business.test.ts tests/main/periodicSwitchWakeupRuntime/business.test.ts tests/main/autoSearchWakeupRuntime/autoSearchWakeupRuntime.business.test.ts tests/app/runApp.business.test.ts tests/app/runtime/createAsyncRuntime.wiring.test.ts tests/main/asyncProgram/monitorTaskProcessor/business.test.ts tests/services/autoSymbolManager/autoSearch.business.test.ts tests/integration/auto-search-policy-consistency.integration.test.ts
bun test
```

最终观测结果：

- `bun lint` 通过。
- `bun type-check` 通过。
- 目标测试集合：`126 pass / 0 fail`。
- 全量测试：`903 pass / 0 fail`，`3002 expect()`，共 `122` 个测试文件。

## 复核结论

复核中发现并已修复的关键问题：

- 初始 `timeWakeupRuntime` fatal 后仍可能启动 `businessEventProgram`。
- cleanup 失败可能覆盖原始 time wakeup fatal。

修复后再次复核：

- 无 Critical 问题。
- 无 Important 问题。
- 两个 runApp fatal/cleanup 问题已关闭。

复核中未纳入本次 scope 的建议：

- `autoSearchWakeupRuntime` 的异步处理失败目前不升级为 app fatal。
- `orderMonitor/routeRuntime` 的 route 处理失败仍按既有 owner 策略在 shutdown 暴露。

原因：

- 本次目标是系统级 time wakeup owner 边界与长 timer 平台边界。
- auto search 和 order route 的运行期错误策略属于独立 owner 设计，不应在本次修复中扩大 scope。

## 当前设计原则

本次修复后应保持以下原则：

1. 系统级时间唤醒只处理 explicit business candidate，不做通用 recovery retry。
2. API 失败只在 API client 边界有限 retry；耗尽后向上抛出。
3. 非法时间计划 fail-fast，并进入可观测 fatal。
4. 超长 timer 只做平台安全分段，不做业务轮询。
5. 局部 timer owner 到 due 时必须重新读取权威状态。
6. cleanup 不能覆盖导致退出的原始 fatal。
7. 自动寻标开盘延迟不是普通信号开盘保护。
8. 周期换标是 due-event owner，不是固定 interval polling。
