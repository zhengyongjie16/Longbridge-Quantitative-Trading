# seat phase + activation barrier 全链路重构方案

## 1. 文档目标

本文档用于收敛并落地这次 seat 激活语义重构，目标是消除以下两类时序错位：

1. 新切换 seat 在 quote 还未 admission 时就被下游消费，触发 `未订阅，请先订阅`。
2. 新切换 seat 在风险缓存尚未初始化完成时就进入风控或执行链路，触发 `浮亏数据未初始化` 或同类半状态问题。

本次修复不是在调用点补兜底，也不是放宽 `quoteClient.getQuotes()` 的严格契约，而是重建一条单一真相、时序闭合的 seat 激活链路：

- 绑定 symbol
- quote admission
- 订单 / 风险缓存初始化
- seat 进入最终可消费状态

只有完成整条链路的 seat，才允许被信号、风控、买卖执行和盯单链路消费。

---

## 2. 问题背景

旧实现把 `READY` 同时用作两种语义：

1. seat 已绑定了一个 symbol；
2. seat 已可被主循环和下游业务消费。

这导致以下时序混叠：

1. `switchStateMachine` 在换标主链结束后直接把 seat 写成 `READY`；
2. `resolveMonitorContextRuntimeSnapshot()`、`signalPipeline`、`riskTasks`、`buyProcessor`、`sellProcessor` 等统一把 `READY` 当成可消费态；
3. `SEAT_REFRESH` 只是事后补刷新，而不是进入可消费态前的前置屏障；
4. 启动恢复 / 开盘重建路径里，只要 seat 有 symbol，也会被旧语义提前暴露给下游。

因此，旧实现中存在一种错误的半状态：

- seat 已对外可见；
- 但 quote 不一定可读；
- order / unrealized loss / warrant 等缓存不一定已完成初始化。

这正是本次 bug 的根因。

---

## 3. 复核范围与方法

### 3.1 复核范围

本次重构覆盖以下边界：

1. seat 状态定义与状态判定：
   - `src/types/seat.ts`
   - `src/services/autoSymbolManager/utils.ts`
   - `src/utils/utils.ts`
2. 自动寻标与换标完成态：
   - `src/services/autoSymbolManager/autoSearch.ts`
   - `src/services/autoSymbolManager/switchStateMachine.ts`
   - `src/services/autoSymbolManager/seatStateManager.ts`
3. 激活任务与调度：
   - `src/main/processMonitor/seatSync.ts`
   - `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`
4. 可消费门禁：
   - `src/main/processMonitor/signalPipeline.ts`
   - `src/main/processMonitor/riskTasks.ts`
   - `src/main/asyncProgram/buyProcessor/index.ts`
   - `src/main/asyncProgram/sellProcessor/index.ts`
   - `src/core/doomsdayProtection/index.ts`
   - `src/main/asyncProgram/postTradeRefresher/index.ts`
   - `src/core/trader/orderMonitor/recoveryFlow.ts`
   - `src/main/asyncProgram/monitorTaskProcessor/utils.ts`
5. 生命周期恢复与重建：
   - `src/main/recovery/seatPreparation.ts`
   - `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
   - `src/main/lifecycle/rebuildTradingDayState.ts`
   - `src/main/lifecycle/tradingCalendarPrewarmer.ts`

### 3.2 复核方法

本次重构按以下顺序推进：

1. 先用测试把新语义钉住：
   - runtime snapshot 只暴露 `ACTIVE`
   - switch 完成后先落 `ACTIVATING`
   - `SEAT_REFRESH` 成功后才推进 `ACTIVE`
2. 再把类型和状态机切到新 phase。
3. 再把消费门禁统一收口到 `ACTIVE`。
4. 最后对齐启动 / 开盘重建路径。

---

## 4. 根因结论

### 4.1 根因一：seat 可用语义被错误折叠

旧模型中：

- `READY` 既表示“seat 已绑定 symbol”；
- 也表示“seat 已可消费”。

但这两个语义并不等价。

### 4.2 根因二：`SEAT_REFRESH` 只是补偿，而不是屏障

旧实现中，换标主链结束后 seat 已经对外暴露；随后才异步做：

- `getQuotes()`
- 订单刷新
- daily loss 重算
- 账户 / 持仓缓存刷新
- unrealized loss 初始化
- warrant 初始化

这意味着 seat 暴露先于初始化完成。

### 4.3 根因三：runtime snapshot 直接把“绑定态”暴露给可消费链路

`resolveMonitorContextRuntimeSnapshot()` 旧逻辑按 `READY` 派生 symbol 和 quote。下游再把这些 symbol/quote 直接用于：

- signal generation
n- risk scheduling
- buy / sell execution
- 部分恢复与展示链路

从而把“绑定新 symbol”直接误当成“可安全消费”。

### 4.4 根因四：启动 / 重建与盘中切换没有统一激活语义

启动恢复、开盘重建、盘中换标三条路径都在写 seat 状态，但旧实现没有统一使用同一条 activation barrier，所以会出现：

- 盘中切换先暴露后补缓存；
- 启动 / 重建恢复出 symbol 后也可能提前被当成就绪 seat。

---

## 5. 修复目标

本次重构后的系统必须满足以下不变量：

1. `ACTIVE` 是唯一允许被业务消费的 seat 状态。
2. `ACTIVATING` 表示 seat 已绑定 symbol，但 quote admission 与风险缓存初始化尚未完成，不可消费。
3. `quoteClient.getQuotes()` 的严格契约保持不变：未 admission 依旧抛错。
4. 启动恢复、开盘重建、盘中换标统一复用同一套激活语义。
5. 激活失败必须回 `EMPTY` 并 bump `seatVersion`，不允许保留半状态继续运行。

---

## 6. 不采用的方案

本次明确不采用以下方案：

1. 保留 `READY` 并在各调用点加额外 if 判断。
2. 在 `quoteClient.getQuotes()` 内自动订阅或降级返回空值。
3. 只提高主循环 admission 频率或增加二次订阅 pass。
4. 仅依赖失败重试掩盖时序错位。
5. 新增一套覆盖 `subscribedSymbols` 的 admission 布尔缓存，制造双真相。

---

## 7. 详细方案

### 7.1 新的 seat phase 语义

seat 状态统一改为：

- `EMPTY`
- `SEARCHING`
- `SWITCHING`
- `ACTIVATING`
- `ACTIVE`

其中：

- `ACTIVATING`：已确定并绑定新 symbol，但还没通过激活屏障；
- `ACTIVE`：唯一可被业务消费的最终态。

同时新增两个判定函数：

- `isSeatActive()`：只用于“可消费”判断；
- `hasSeatSymbol()`：只用于“seat 已绑定 symbol”的内部流程判断，例如启动恢复与重建。

这两个语义明确分离后，避免再次把“已绑定”误当成“可消费”。

### 7.2 runtime snapshot 只暴露 ACTIVE seat

`resolveMonitorContextSeatSnapshot()` / `resolveMonitorContextRuntimeSnapshot()` 只为 `ACTIVE` seat 派生：

- `longSymbol`
- `shortSymbol`
- `longQuote`
- `shortQuote`
- symbolName

这样即使 seat 已处于 `ACTIVATING`，下游也拿不到可消费 symbol，自然无法误入信号、风控和执行链路。

### 7.3 自动寻标 / 换标完成后统一先落 `ACTIVATING`

以下路径统一不再直接落可消费态：

1. 自动寻标成功
2. 距离换标完成
3. 周期换标完成
4. 启动恢复恢复出 symbol

这些路径现在统一把 seat 写成：

- `status: 'ACTIVATING'`
- `symbol: 已绑定 symbol`
- `lastSeatActivatedAt: null`

也就是说，seat 只是“绑定成功”，还没有被放行给下游消费。

### 7.4 `SEAT_REFRESH` 升级为 activation barrier

`SEAT_REFRESH` 现在不再是“READY 之后补缓存”，而是“进入 ACTIVE 之前必须完成”的激活屏障。

固定顺序为：

1. `marketDataClient.subscribeSymbols()` 对 `nextSymbol`（以及必要时的 `previousSymbol`）做 admission；
2. `getQuotes()` 读取执行时 quote；
3. 刷新订单记录；
4. 重算 daily loss；
5. 刷新账户 / 持仓缓存；
6. 初始化 unrealized loss；
7. 初始化 warrant 信息；
8. 清理旧 symbol 残留缓存；
9. 成功后把当前 seat 从 `ACTIVATING` 推进到 `ACTIVE`。

失败策略：

- 清 warrant 缓存；
- bump `seatVersion`；
- seat 回 `EMPTY`；
- 清理相关方向队列；
- 不保留半激活状态。

### 7.5 `seatSync` 的职责重定位

`seatSync` 现在做两件事：

1. 当 seat 从 `ACTIVE` 退化为非 `ACTIVE` 时，清理该方向相关队列；
2. 当 seat 进入 `ACTIVATING` 时，调度 `SEAT_REFRESH`。

调度不再依赖 runtime snapshot 中的可消费 symbol，而是直接使用 seat 自身当前绑定的 `symbol`。

这样可以保证：

- `ACTIVATING` 虽然对下游不可见；
- 但 seat activation task 仍然能被正确调度执行。

### 7.6 可消费门禁统一收口到 `ACTIVE`

以下路径统一改为只接受 `ACTIVE` seat：

- `signalPipeline`
- `riskTasks`
- `buyProcessor`
- `sellProcessor`
- `doomsdayProtection`
- `postTradeRefresher`
- `orderMonitor` 恢复席位匹配
- `monitorTaskProcessor` 风险任务快照解析

结果是：

- 非 `ACTIVE` seat 不再视为异常，而是正常跳过；
- 风控、信号、执行链路不会看到半初始化 seat；
- 原有 seatVersion / seatSymbol 一致性校验仍保留。

### 7.7 启动恢复 / 开盘重建对齐同一激活语义

启动恢复和开盘重建路径现在区分两层语义：

1. `hasSeatSymbol()`：表示 seat 已绑定 symbol，可参与订单 / 风险缓存重建；
2. `ACTIVE`：表示重建完成后可被主循环消费。

具体做法：

- `seatPreparation` 恢复出的 symbol 先写成 `ACTIVATING`；
- `rebuildTradingDayState` 用 `hasSeatSymbol()` 重建订单、warrant、unrealized loss；
- 全部成功后统一把这些 seat 推进到 `ACTIVE`，并刷新一次 MonitorContext runtime snapshot。

这样启动 / 开盘重建和盘中 activation 的终态语义保持一致。

---

## 8. 验证与验收

### 8.1 已补关键验证点

本次已补并通过的关键定向测试包括：

1. runtime snapshot 仅暴露 `ACTIVE` seat。
2. switch 完成态不再直接进入可消费态，而是落 `ACTIVATING`。
3. `SEAT_REFRESH` 成功后 seat 才推进到 `ACTIVE`。
4. `seatSync` 基于 `ACTIVATING` 调度 `SEAT_REFRESH`。

### 8.2 验收标准

验收时必须满足：

1. 盘中换标后，风险任务不再在 quote 未 admission 时读到新 seat。
2. `SEAT_REFRESH` 失败时 seat 回 `EMPTY`，并 bump `seatVersion` 阻断旧任务。
3. 启动 / 开盘重建前，不会提前把半初始化 seat 暴露为可消费。
4. 运行日志顺序收敛为：
   - 绑定 symbol
   - `ACTIVATING`
   - quote admission
   - 缓存初始化
   - `ACTIVE`
5. 不再出现：
   - `[行情获取] 标的 xxx 未订阅，请先订阅`
   - `[浮亏监控] xxx 浮亏数据未初始化，跳过检查`

### 8.3 本次实现后的直接验证结果

已完成以下工程验证：

- seat 激活相关定向测试通过：
  - `tests/utils/utils.business.test.ts`
  - `tests/main/processMonitor/seatSync.business.test.ts`
  - `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`
  - `tests/services/autoSymbolManager/switchStateMachine.business.test.ts`
- `bun type-check` 通过

后续仍应继续执行与本方案直接相关的集成测试组，确认在真实主循环与生命周期场景下语义完全闭合。
