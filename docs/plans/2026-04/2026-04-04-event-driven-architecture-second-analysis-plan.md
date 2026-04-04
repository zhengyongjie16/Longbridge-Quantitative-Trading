# 事件驱动架构二次全面分析与重构计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变交易业务语义的前提下，对当前系统进行二次全面复核，明确哪些模块应增强为事件驱动、哪些模块必须保留时间驱动，并给出一条最短路径的混合架构重构计划。

**Architecture:** 当前系统不是纯事件驱动，而是“主循环控制平面 + 异步处理器 + 局部事件流 + 生命周期状态机”的混合架构。正确的重构方向不是消灭主循环，而是把市场变化、订单终态、席位状态变化等离散触发点显式化，让主循环只保留时间语义、生命周期门禁和必须的 heartbeat。

**Tech Stack:** TypeScript, Bun, Longbridge SDK, 当前 `mainProgram` 主循环、`orderMonitor` WebSocket 推送、`monitorTaskProcessor`/`buyProcessor`/`sellProcessor` 异步处理器、`dayLifecycleManager` 生命周期状态机。

---

## 0. 二次全面分析结论

### 0.1 总结论

经过对当前代码、已有架构文档、主循环链路、异步处理器链路、风险/自动换标/延迟验证链路的二次复核，结论如下：

1. 当前程序**不是纯事件驱动**，而是**混合架构**。
2. 当前真正的外层系统时钟仍然是 `src/app/runApp.ts` 中的固定节拍循环。
3. 订单推送、任务入队、延迟验证通过回调已经具备明显的事件驱动特征。
4. 风险检查、距离换标首次触发、席位变化后的清理/刷新，本质上更适合事件驱动。
5. 交易时段门禁、生命周期重建、末日保护、周期换标、延迟验证时间轴、自动寻标冷却等，**必须保留时间驱动**。
6. 正确目标不是“把系统改成纯事件驱动”，而是把当前混在市场处理链中的非市场职责拆出去，形成：
   - 时间驱动控制平面
   - 市场事件驱动数据平面
   - 订单推送事件流
   - 保留 worker / retry 的异步执行平面

### 0.2 最重要的边界判断

#### 必须保留时间驱动的职责

1. 启动 gate 与运行期交易时段门禁。
2. `dayLifecycleManager.tick(...)` 跨日清理与开盘重建。
3. 末日保护时间窗口。
4. 延迟验证的真实时间轴采样与触发。
5. 周期换标到期判断。
6. 自动寻标冷却、早盘延迟、冻结恢复。
7. 订单监控中的 timeout / retry / 改单间隔控制。
8. 成交后刷新失败重试。

#### 最适合进一步事件驱动化的职责

1. 风险任务调度入口。
2. 距离换标首次越界触发。
3. 席位变化后的任务清理与 `SEAT_REFRESH` 触发。
4. 成交后的刷新入口。
5. `orderMonitorWorker` 的触发条件收敛。
6. 订阅集合 diff 的触发源从“每拍重算”收敛到“seat/order/position 变化事件”。

### 0.3 本次重构的唯一推荐方向

唯一正确方向是：

1. **保留主循环，但收缩其职责。**
2. **明确拆出时间驱动控制平面。**
3. **把真正的市场变化响应转为事件驱动。**
4. **保留所有依赖 timeout / retry / lifecycle drain 的 worker。**
5. **不做兼容式双轨，不保留“旧轮询逻辑 + 新事件逻辑”长期并存。**

---

## 1. 当前架构的二次事实确认

### 1.1 外层系统时钟仍然是主循环

关键文件：

- `src/app/runApp.ts:215-245`
- `src/main/mainProgram/index.ts:40-312`

当前事实：

1. `runApp` 通过 `for (;;)` 固定节拍循环驱动 `mainProgram(...)`。
2. `mainProgram` 负责交易时段判断、生命周期推进、末日保护、订阅集合维护、行情读取、监控标的处理、订单监控与刷新调度。
3. 这说明当前真正的系统 orchestrator 仍是时间驱动，而不是市场事件总线。

### 1.2 订单链路已经存在局部事件驱动

关键文件：

- `src/core/trader/orderMonitor/index.ts:194-205`
- `src/core/trader/orderMonitor/eventFlow.ts`
- `src/core/trader/orderMonitor/settlementFlow.ts:245-253`
- `src/app/registerDelayedSignalHandlers.ts:27-81`
- `src/main/asyncProgram/tradeTaskQueue/index.ts:23-81`

当前事实：

1. 订单状态更新通过 WebSocket 推送进入 `orderMonitor`。
2. 延迟验证通过后以回调方式把信号推入买卖队列。
3. 任务队列 `push()` 会立即触发 `onTaskAdded` 回调，具备事件式消费特征。
4. 成交结算会把刷新请求写入 `pendingRefreshSymbols`。

### 1.3 异步处理器不是纯事件驱动，而是事件驱动消费 + worker 调度

关键文件：

- `src/main/asyncProgram/utils.ts:111-248`
- `src/main/asyncProgram/buyProcessor/index.ts`
- `src/main/asyncProgram/sellProcessor/index.ts:216-260`
- `src/main/asyncProgram/orderMonitorWorker/index.ts`
- `src/main/asyncProgram/postTradeRefresher/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/index.ts`

当前事实：

1. `buyProcessor` 基本是事件驱动消费器。
2. `sellProcessor` 在 quote 缺失时仍通过 `setTimeout` 延迟重入，属于混合驱动。
3. `orderMonitorWorker` 由主循环 schedule，但内部处理的是订单运行态推进与 quote-driven 管理。
4. `postTradeRefresher` 由成交事件触发 enqueue，但失败后仍靠 timer retry。
5. `monitorTaskProcessor` 接收事件式任务，但内部保留 retry registry 和 queue runner。

结论：

- 当前架构已经天然是“事件触发 + worker 推进”的混合模式。
- 未来重构不能误把 worker/retry 机制当成反模式整体删除。

---

## 2. 必须保留时间驱动的一级边界

### 2.1 生命周期、交易时段、开盘保护

关键文件：

- `src/main/startup/gate.ts`
- `src/app/runtime/createPreGateRuntime.ts`
- `src/main/mainProgram/index.ts:60-170`
- `src/main/lifecycle/dayLifecycleManager.ts`

这些逻辑依赖：

1. 交易日历。
2. 连续交易时段。
3. 开盘保护窗口。
4. 午夜清理与开盘重建。
5. 失败退避重试。

这些都是墙钟时间语义，不能由市场事件替代。

### 2.2 延迟验证时间轴

关键文件：

- `src/main/asyncProgram/delayedSignalVerifier/index.ts`
- `src/main/asyncProgram/delayedSignalVerifier/utils.ts`
- `src/main/asyncProgram/indicatorCache/index.ts`
- `src/main/processMonitor/indicatorPipeline.ts`

必须保持的原因：

1. 当前验证语义是 `T0 / T0+5s / T0+10s` 的真实时间点趋势判断。
2. `indicatorCache` 当前显式承担“按时间采样供延迟验证查询”的职责。
3. 若改成纯事件驱动采样，会改变验证语义并造成稀疏行情下的采样缺口。

### 2.3 周期换标与自动寻标时间门禁

关键文件：

- `src/services/autoSymbolManager/switchStateMachine.ts:840-967`
- `src/services/autoSymbolManager/autoSearch.ts`
- `src/main/processMonitor/autoSymbolTasks.ts`

必须保持的原因：

1. 周期换标基于累计交易时长，不是行情变化事件。
2. 自动寻标受冷却时间、早盘延迟、冻结状态约束。
3. 空席位在无行情变化时也必须被继续推进。

### 2.4 订单超时、成交后刷新失败重试

关键文件：

- `src/core/trader/orderMonitor/quoteFlow.ts`
- `src/main/asyncProgram/postTradeRefresher/index.ts`
- `src/main/asyncProgram/sellProcessor/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/index.ts`

必须保持的原因：

1. timeout 本质就是时间语义。
2. quote retry / refresh retry 都需要未来某个时间点再次尝试。
3. 在没有可靠 quote-ready / refresh-ready 事件源之前，timer retry 不能被纯事件替代。

---

## 3. 最适合事件驱动化的模块与优先级

## 3.1 第一优先级：风险任务调度层

关键文件：

- `src/main/processMonitor/riskTasks.ts`
- `src/main/processMonitor/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/unrealizedLoss.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/liquidationDistance.ts`

结论：

1. 这些任务的业务本质就是“价格变化后重新判断”。
2. 当前只是通过主循环先检测 `priceChanged` 再投递队列。
3. 这是最容易、收益最高、且不改变业务定义的事件驱动化入口。

目标：

- 从“每拍检测价格变化后触发”收敛到“市场数据更新事件 -> 风险任务触发器”。

## 3.2 第二优先级：距离换标首次触发

关键文件：

- `src/main/processMonitor/autoSymbolTasks.ts`
- `src/services/autoSymbolManager/switchStateMachine.ts`
- `src/core/riskController/warrantRiskChecker.ts`

结论：

1. 距离换标首次触发本质上是“距回收价越界”事件。
2. 当前只是借主循环路径顺手检查。
3. 首次触发适合事件驱动；后续状态机推进不适合纯事件化。

## 3.3 第三优先级：席位变化后的清理与刷新

关键文件：

- `src/main/processMonitor/seatSync.ts`
- `src/main/processMonitor/utils.ts`
- `src/main/asyncProgram/monitorTaskProcessor/helpers/seatSnapshot.ts`

结论：

1. 当 seat 从 ACTIVE 退化、symbol 改变、version 变化时，旧任务与旧信号必须被清理。
2. 这本质上是 seat state change 事件，不是市场处理本体。
3. 当前被混在 `processMonitor` 中执行，属于明显可拆出的事件职责。

## 3.4 第四优先级：成交后的刷新入口

关键文件：

- `src/core/trader/orderMonitor/settlementFlow.ts`
- `src/main/mainProgram/index.ts:176-184, 303-310`
- `src/main/asyncProgram/postTradeRefresher/index.ts`

结论：

1. 刷新需求已经由成交事件产生。
2. 当前只是 enqueue 入口仍依赖主循环统一排空。
3. 这部分适合收敛为更靠近 settlement event 的触发，但 refresher worker 本身保留不变。

## 3.5 第五优先级：`orderMonitorWorker` 触发条件收敛

关键文件：

- `src/main/asyncProgram/orderMonitorWorker/index.ts`
- `src/main/mainProgram/index.ts:303-307`
- `src/core/trader/orderMonitor/quoteFlow.ts`

结论：

1. 该 worker 当前由主循环每拍 schedule 一次。
2. 更合理的目标不是取消 worker，而是把 schedule 条件收敛到：
   - 存在 tracked orders
   - WS 订单状态推进
   - timeout 到期
   - 需要 quote-driven 追价检查
3. 该项收益高，但实现难度高于风险任务入口改造。

---

## 4. 不应优先事件驱动化的高风险区域

### 4.1 延迟验证器核心触发逻辑

关键文件：

- `src/main/asyncProgram/delayedSignalVerifier/index.ts`
- `src/main/asyncProgram/delayedSignalVerifier/utils.ts`

原因：

1. 会直接改变三点验证的时间语义。
2. 会破坏当前 `indicatorCache` 的设计契约。
3. 属于高风险、低必要性的错误方向。

### 4.2 周期换标主逻辑

关键文件：

- `src/services/autoSymbolManager/switchStateMachine.ts:840-967`

原因：

1. 周期换标本来就是时间到期逻辑。
2. 改成事件驱动会让语义更绕，并可能在无行情时期失效。

### 4.3 换标状态机从“轮询推进”直接改成“纯事件推进”

关键文件：

- `src/services/autoSymbolManager/switchStateMachine.ts:512-838`
- `src/main/processMonitor/autoSymbolTasks.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`

原因：

1. 状态机等待的是多种外部条件混合：撤单、成交、可用持仓、行情就绪、席位版本、回补条件。
2. 当前 `hasPendingSwitch` + 持续调度其实是一个保底推进器。
3. 纯事件化容易出现漏事件、乱序和卡死。

结论：

- 如果要动这块，只能做“事件增强 + 保底推进”，不能一步改成纯事件状态机。

---

## 5. 目标架构：混合驱动的职责收敛

## 5.1 最终架构原则

重构后的系统应明确拆成四个并列平面：

1. **Time-Driven Control Plane**
   - 负责生命周期、交易时段、开盘保护、末日保护、周期换标、延迟验证时间轴。
2. **Market-Driven Data Plane**
   - 负责行情变化触发的 monitor 处理、风险任务触发、距离换标首次触发。
3. **Order Push Event Plane**
   - 负责订单 WS 事件、成交结算、刷新请求、订单状态推进。
4. **Worker / Retry Execution Plane**
   - 负责 buy/sell/monitor/orderMonitor/postTradeRefresher 的串行消费、timeout 与 retry。

## 5.2 主循环的收缩目标

主循环未来仍应存在，但只负责：

1. 时间语义。
2. 生命周期推进。
3. 明确保留的 heartbeat。
4. worker 生命周期控制。

主循环未来不应继续承担：

1. 所有市场变化响应的统一入口。
2. 所有 seat/risk 变化检测的唯一入口。
3. 所有事件排空的总兜底入口。

## 5.3 `processMonitor` 的收缩目标

`processMonitor` 应收缩为真正的 market cycle：

1. 消费当前行情/指标输入。
2. 完成 monitor 级市场处理。
3. 触发策略与风险响应。

不应继续承载：

1. `AUTO_SYMBOL_TICK` 时间心跳。
2. 与 seat state change 强相关的全量队列治理。
3. 与成交事件强相关的刷新排空入口。

---

## 6. 文件结构与职责落点

### 6.1 需要重点修改的现有文件

- `src/app/runApp.ts`
- `src/main/mainProgram/index.ts`
- `src/main/processMonitor/index.ts`
- `src/main/processMonitor/riskTasks.ts`
- `src/main/processMonitor/autoSymbolTasks.ts`
- `src/main/processMonitor/seatSync.ts`
- `src/main/asyncProgram/orderMonitorWorker/index.ts`
- `src/main/asyncProgram/postTradeRefresher/index.ts`
- `src/core/trader/orderMonitor/settlementFlow.ts`
- `src/core/trader/orderMonitor/quoteFlow.ts`
- `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/unrealizedLoss.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/liquidationDistance.ts`
- `src/services/autoSymbolManager/switchStateMachine.ts`
- `src/services/autoSymbolManager/autoSearch.ts`

### 6.2 建议新增的边界文件

> 命名可按现有目录风格调整，但职责边界必须存在。

- `src/main/runtime/runTimeDrivenControlTick.ts`
  - 纯时间控制平面。
- `src/main/runtime/runMarketDrivenMonitorCycle.ts`
  - monitor 级市场处理平面。
- `src/app/runtime/createMarketEventDispatcher.ts`
  - 市场变化事件分发器。
- `src/app/runtime/createSeatEventDispatcher.ts`
  - seat state change 事件分发器。
- `src/app/runtime/createOrderEventDispatcher.ts`
  - 成交/终态事件分发器。
- `src/main/runtime/subscriptionSetController.ts`
  - 订阅集合维护收敛点。

### 6.3 明确不应在本轮改动业务语义的文件域

- `src/core/strategy/*`
- `src/core/signalProcessor/*`
- `src/core/riskController/*`
- `src/main/asyncProgram/delayedSignalVerifier/*`
- `src/main/lifecycle/*`
- `src/core/doomsdayProtection/*`

这些模块允许适配调度入口，但不允许改变其业务定义。

---

## 7. 分阶段重构计划

### Task 1: 冻结“必须保留时间驱动”的语义边界

**Files:**
- Modify: `tests/` 下与 lifecycle / delayed verification / periodic switch / doomsday 相关测试
- Test: `tests/main/lifecycle/**`
- Test: `tests/main/asyncProgram/delayedSignalVerifier/**`
- Test: `tests/services/autoSymbolManager/**`
- Test: `tests/core/doomsdayProtection/**`

- [ ] **Step 1: 为时间驱动边界补齐回归测试**
- [ ] **Step 2: 明确测试覆盖以下语义**
  - 延迟验证三点时间轴
  - 周期换标累计交易时长
  - 自动寻标冷却/早盘延迟/冻结
  - 生命周期跨日/开盘重建
  - 末日保护窗口
- [ ] **Step 3: 运行相关测试，确认当前语义被锁定**

Run: `bun test tests/main/lifecycle tests/main/asyncProgram/delayedSignalVerifier tests/services/autoSymbolManager tests/core/doomsdayProtection`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/main/lifecycle tests/main/asyncProgram/delayedSignalVerifier tests/services/autoSymbolManager tests/core/doomsdayProtection
git commit -m "test: freeze time-driven architecture boundaries"
```

### Task 2: 从 `mainProgram` 中拆出纯时间控制平面

**Files:**
- Modify: `src/main/mainProgram/index.ts`
- Create: `src/main/runtime/runTimeDrivenControlTick.ts`
- Create: `src/main/runtime/runMarketDrivenMonitorCycle.ts`
- Modify: `src/app/runApp.ts`
- Test: `tests/main/mainProgram/**`

- [ ] **Step 1: 写失败测试，锁定拆分前后的行为等价**
- [ ] **Step 2: 把以下职责固定留在 `runTimeDrivenControlTick`**
  - 交易日/时段判断
  - 开盘保护
  - `dayLifecycleManager.tick(...)`
  - 末日保护
  - worker 启动前置门禁
- [ ] **Step 3: 把 monitor 级市场处理提取到 `runMarketDrivenMonitorCycle`**
- [ ] **Step 4: 运行测试，确认主循环行为不变**

Run: `bun test tests/main/mainProgram`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/mainProgram/index.ts src/main/runtime/runTimeDrivenControlTick.ts src/main/runtime/runMarketDrivenMonitorCycle.ts src/app/runApp.ts tests/main/mainProgram
git commit -m "refactor: split time-driven and market-driven runtime entrypoints"
```

### Task 3: 让风险任务调度入口显式事件化

**Files:**
- Modify: `src/main/processMonitor/riskTasks.ts`
- Modify: `src/main/processMonitor/index.ts`
- Create: `src/app/runtime/createMarketEventDispatcher.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/unrealizedLoss.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/liquidationDistance.ts`
- Test: `tests/main/processMonitor/**`
- Test: `tests/main/asyncProgram/monitorTaskProcessor/**`

- [ ] **Step 1: 写失败测试，锁定价格变化 -> 风险任务触发语义**
- [ ] **Step 2: 提取价格变化事件分发器，不在 `processMonitor` 内直接承担全部调度判断**
- [ ] **Step 3: 让 `LIQUIDATION_DISTANCE_CHECK` 与 `UNREALIZED_LOSS_CHECK` 从统一 market event 入口触发**
- [ ] **Step 4: 保留 handler 内的 refreshGate / retry / lifecycle 边界**
- [ ] **Step 5: 跑测试，确认业务语义不变**

Run: `bun test tests/main/processMonitor tests/main/asyncProgram/monitorTaskProcessor`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/processMonitor/riskTasks.ts src/main/processMonitor/index.ts src/app/runtime/createMarketEventDispatcher.ts src/main/asyncProgram/monitorTaskProcessor/handlers/unrealizedLoss.ts src/main/asyncProgram/monitorTaskProcessor/handlers/liquidationDistance.ts tests/main/processMonitor tests/main/asyncProgram/monitorTaskProcessor
git commit -m "refactor: drive risk task scheduling from market events"
```

### Task 4: 把距离换标首次触发从时间路径中拆出

**Files:**
- Modify: `src/main/processMonitor/autoSymbolTasks.ts`
- Modify: `src/services/autoSymbolManager/switchStateMachine.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`
- Test: `tests/services/autoSymbolManager/**`
- Test: `tests/main/processMonitor/**`

- [ ] **Step 1: 写失败测试，锁定“价格越界 -> 首次换标触发”的语义**
- [ ] **Step 2: 保留 `AUTO_SYMBOL_TICK` 仅负责时间型任务**
  - 自动寻标心跳
  - 周期换标到期判断
- [ ] **Step 3: 把距离换标首次越界判定接到 market event 入口**
- [ ] **Step 4: 保留 `hasPendingSwitch` 的保底推进语义，不改成纯事件状态机**
- [ ] **Step 5: 跑测试，确认状态机不会卡死**

Run: `bun test tests/services/autoSymbolManager tests/main/processMonitor`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/processMonitor/autoSymbolTasks.ts src/services/autoSymbolManager/switchStateMachine.ts src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts tests/services/autoSymbolManager tests/main/processMonitor
git commit -m "refactor: separate distance switch trigger from time-driven auto-symbol tick"
```

### Task 5: 把 seat state change 触发与市场处理解耦

**Files:**
- Modify: `src/main/processMonitor/seatSync.ts`
- Modify: `src/main/processMonitor/index.ts`
- Create: `src/app/runtime/createSeatEventDispatcher.ts`
- Modify: `src/main/processMonitor/utils.ts`
- Test: `tests/main/processMonitor/**`

- [ ] **Step 1: 写失败测试，锁定 seat 变化后的任务清理与刷新行为**
- [ ] **Step 2: 提取 seat state change 事件边界**
- [ ] **Step 3: 将 queue cleanup / delayed signal cancel / `SEAT_REFRESH` 触发从 market cycle 中收口到 seat event 入口**
- [ ] **Step 4: 跑测试，确认旧 seat 任务仍被正确阻断**

Run: `bun test tests/main/processMonitor`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/processMonitor/seatSync.ts src/main/processMonitor/index.ts src/app/runtime/createSeatEventDispatcher.ts src/main/processMonitor/utils.ts tests/main/processMonitor
git commit -m "refactor: dispatch seat lifecycle changes explicitly"
```

### Task 6: 收敛成交后刷新入口与 `orderMonitorWorker` 触发条件

**Files:**
- Modify: `src/core/trader/orderMonitor/settlementFlow.ts`
- Modify: `src/main/asyncProgram/postTradeRefresher/index.ts`
- Modify: `src/main/asyncProgram/orderMonitorWorker/index.ts`
- Modify: `src/main/mainProgram/index.ts`
- Create: `src/app/runtime/createOrderEventDispatcher.ts`
- Modify: `src/core/trader/orderMonitor/quoteFlow.ts`
- Test: `tests/core/trader/orderMonitor/**`
- Test: `tests/main/asyncProgram/postTradeRefresher/**`

- [ ] **Step 1: 写失败测试，锁定成交后刷新与订单监控 schedule 的现有语义**
- [ ] **Step 2: 把 settlement event 到 refresh enqueue 的入口收口到 order event dispatcher**
- [ ] **Step 3: 让 `orderMonitorWorker` 只在有 tracked orders / timeout due / quote-driven need 时调度**
- [ ] **Step 4: 保留 quoteFlow 内的 timeout / retry / latest-wins worker 语义**
- [ ] **Step 5: 跑测试，确认 order monitor 与 refresher 行为不变**

Run: `bun test tests/core/trader/orderMonitor tests/main/asyncProgram/postTradeRefresher`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/trader/orderMonitor/settlementFlow.ts src/main/asyncProgram/postTradeRefresher/index.ts src/main/asyncProgram/orderMonitorWorker/index.ts src/main/mainProgram/index.ts src/app/runtime/createOrderEventDispatcher.ts src/core/trader/orderMonitor/quoteFlow.ts tests/core/trader/orderMonitor tests/main/asyncProgram/postTradeRefresher
git commit -m "refactor: tighten order-driven refresh and monitor scheduling"
```

### Task 7: 最终收口顶层职责并清理旧轮询痕迹

**Files:**
- Modify: `src/app/runApp.ts`
- Modify: `src/main/mainProgram/index.ts`
- Modify: `src/app/runtime/createAsyncRuntime.ts`
- Test: `tests/integration/**`

- [ ] **Step 1: 写失败测试，锁定顶层运行期行为**
- [ ] **Step 2: 确认主循环只保留时间控制平面与必要 worker 生命周期控制**
- [ ] **Step 3: 清理已被 dispatcher 替代的旧入口，不保留兼容壳**
- [ ] **Step 4: 运行集成测试与全量门禁**

Run: `bun test tests/integration && bun lint && bun type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/runApp.ts src/main/mainProgram/index.ts src/app/runtime/createAsyncRuntime.ts tests/integration
git commit -m "refactor: converge runtime orchestration to explicit hybrid architecture"
```

---

## 8. 验收标准

完成本次重构后，必须同时满足：

1. 系统外层仍保留时间驱动控制平面。
2. 生命周期、开盘保护、末日保护、周期换标、延迟验证时间轴语义完全不变。
3. 风险任务调度入口不再依赖主循环内的隐式价格变化检测。
4. 距离换标首次越界触发不再混在 `AUTO_SYMBOL_TICK` 中。
5. seat 变化后的旧任务清理与刷新触发有显式事件边界。
6. 成交后刷新入口收口到订单事件侧，而不是完全依赖主循环尾部排空。
7. `orderMonitorWorker` 仍保留 worker/timeout/retry 语义，但 schedule 条件被收敛。
8. 不存在“新 dispatcher 已接入，但旧轮询入口仍长期保留”的双轨。
9. `bun lint` 通过。
10. `bun type-check` 通过。
11. 相关单测、集成测试全部通过。

---

## 9. 风险清单与实施纪律

### 9.1 严禁的错误方向

1. 把系统目标理解为“彻底删除主循环”。
2. 把延迟验证改成纯事件触发验证。
3. 把周期换标改成市场事件驱动。
4. 把换标状态机直接改成纯事件状态机，删除保底推进。
5. 把 timeout / retry worker 一并视作“轮询坏味道”删除。
6. 为了兼容旧逻辑，长期保留双入口。

### 9.2 必须坚持的纪律

1. 先锁定时间语义，再做事件入口收敛。
2. 先改“触发入口”，再改“内部执行结构”。
3. 每一步只动一类边界，不同时推进多个高风险状态机。
4. 每个阶段完成后必须先跑回归，再继续下一阶段。

---

## 10. 最终结论

本次二次全面分析后的最终判断是：

1. 当前程序的正确定位是**混合架构**，而不是“尚未完成的纯事件驱动系统”。
2. 真正值得重构的，不是主循环本身，而是那些**已经具备离散触发条件却仍被绑在主循环里的职责**。
3. 最有价值的改造顺序应是：
   - 风险任务调度入口
   - 距离换标首次触发
   - seat 变化事件边界
   - 成交后刷新入口
   - `orderMonitorWorker` 触发收敛
4. 生命周期、延迟验证、周期换标、末日保护、timeout/retry worker 必须作为系统硬边界保留。
5. 唯一正确的目标架构是：
   - **时间驱动控制平面保留**
   - **市场变化响应事件化**
   - **订单事件入口显式化**
   - **异步 worker 与 retry 机制保留**

这条路径满足：

- 优先事件驱动设计
- 不做兼容性补丁方案
- 不过度设计
- 逻辑边界清晰
- 全链路业务语义可验证
