# SonarQube 重复项报告

**生成时间**: 2026-03-01  
**命令**: `bun sonarqube:duplications`  
**统计**: 涉及文件数 39，重复块组数 84

---

## 修复进度与当前状态（2026-03-01 更新）

### 已完成的修复

| 优先级 | 组号 | 内容 | 状态 |
|--------|------|------|------|
| **P0** | 43、44、47、69 | 生产代码重复（buyProcessor/sellProcessor、tradingTime/lifecycle、monitorTaskProcessor handlers、OrderRecorder 类型） | ✅ 已修复 |
| **P1** | 31、84 | configFactory 单一来源、dailyIndicatorAnalysis utils 内重复 | ✅ 已修复 |
| **P2** | 12–15、20–27、8–11 | 测试重复（asyncProgram、cleanup、autoSymbolManager 抽 utils/helper） | ✅ 已部分修复 |
| **补充** | 29–30、64 | processMonitor 测试复用 asyncProgram 的 createMonitorContext；tests/main/asyncProgram/utils 内 createMonitorContext/createMonitorTaskContext 抽 buildMonitorContextBase | ✅ 已修复 |

**重新执行 `bun sonarqube` 后再运行 `bun sonarqube:duplications`**（2026-03-01 校验）：**涉及文件数 27、重复块组数 60**。组 29–30、64 已从报告中消失（processMonitor 复用 createMonitorContext、tests/main/asyncProgram/utils 内 buildMonitorContextBase 生效）。**所有必要性修复已完成**：无生产代码（src/）、无 Mock/工具脚本重复；剩余 60 组均为测试代码重复（可选修复）。

### 分析结论：修复遗漏 vs 文档遗漏

- **非文档遗漏**：原报告中的 84 组在文档中均有对应（按「生产 / 测试 / Mock / 工具」分类）。当前仍出现的重复组与文档中的「三、测试代码重复」各节一致，属同一批问题的不同运行结果（行号可能因修复略有偏移）。
- **修复遗漏**：P0、P1 已全部修复；P2/P3 仅完成了部分（如 asyncProgram、cleanup、autoSymbolManager 的 utils 抽取），其余测试组（chaos/regression、integration、lifecycle、startup、core、switchStateMachine/periodicSwitch 等）尚未系统性抽取，因此仍会出现在重复报告中。
- **与生产代码的交叉重复（组 29–30）**：报告曾显示 `tests/main/processMonitor/index.business.test.ts` 与 `src/main/asyncProgram/utils.ts` 的块相似。实质是测试内「构造 MonitorContext」与测试 utils 中「构造 MonitorContext」及生产代码中「processQueue/scheduleNextProcess」的**结构/长度相似**（非同一逻辑）。已通过 processMonitor 复用 `tests/main/asyncProgram/utils` 的 `createMonitorContext` 消除测试侧重复。

### 剩余重复是否有必要继续修复

| 类型 | 建议 | 说明 |
|------|------|------|
| **测试用例间重复（同文件或跨文件）** | 可选、按需 | 可维护性有益：抽 `run*`/`assert*`/`it.each` 可减少重复；不影响功能。优先处理跨文件、行数多的组（如 integration 大块、switchStateMachine 多段）。 |
| **单文件内多用例同结构** | 低优先级 | 用 `it.each` 或参数化场景函数即可收敛，需改动测试结构。 |
| **chaos/regression/helpers 交叉** | 中优先级 | 文档 3.1 节已建议抽到 `tests/helpers`，修复后可减少 3 组以上。 |

结论：**无必须修复项**；继续修复仅为降低重复度、提升可维护性，可按排期择组处理。

---

## 一、概览

本报告记录 SonarQube 检测到的所有代码重复（Duplications），按来源分为：

| 类别                  | 说明                            | 组数 |
| --------------------- | ------------------------------- | ---- |
| **生产代码 (src/)**   | 业务逻辑重复，优先修复          | 5 组 |
| **测试代码 (tests/)** | 测试用例间重复，可抽公共 helper | 多数 |
| **Mock/工厂**         | 配置构造重复                    | 1 组 |
| **工具脚本 (tools/)** | 脚本内重复                      | 1 组 |

### 修复时须遵守的代码组织规范（必须使用typescript-project-specifications skill）

所有修复方案必须符合项目 TypeScript 规范，尤其是代码组织：

- **类型**：类型定义放在 `types.ts` 中；**跨模块共享类型**放在「使用它的多个模块的最近共同父级」的 `types.ts`，不得在多个子模块重复定义等价类型；私有类型仅放在本模块 `types.ts`；禁止 re-export，使用处从定义处（源模块）直接 `import type`。
- **工具函数**：纯工具函数放在 `utils.ts` 中；**跨模块共享工具**放在「使用它的多个模块的最近共同父级」的 `utils.ts`；纯函数命名**不得使用 `create` 开头**；禁止在多个文件中重复实现相同工具函数；禁止 re-export，使用处从源模块直接 `import`。
- **常量**：常量统一放在 `src/constants` 下，禁止在业务或测试中重复定义相同常量。
- **测试**：单元测试目录 `tests/` 与 `src/` 目录结构一一对应（如 `src/core/trader` 对应 `tests/core/trader`）；跨多个测试模块共用的 helper 放在 `tests/helpers`，仅单模块使用的放在该模块对应的 `tests/...` 下；测试内从 helper 或工厂**直接引用**，禁止 re-export。
- **单一来源**：配置、Schema、类型、工具均保持单一来源，修改一处即可影响所有使用处。

---

## 二、生产代码重复（高优先级）

### 组 43 — buyProcessor / sellProcessor 逻辑重复

| 位置                                           | 行范围  | 行数 |
| ---------------------------------------------- | ------- | ---- |
| `src/main/asyncProgram/buyProcessor/index.ts`  | 173-197 | 25   |
| `src/main/asyncProgram/sellProcessor/index.ts` | 135-159 | 25   |

**说明**：买处理器与卖处理器中存在 25 行相似逻辑（构建/提交任务或状态更新）。  
**建议的修复**：将共享逻辑抽成**纯工具函数**，放在 buyProcessor 与 sellProcessor 的**最近共同父级** `src/main/asyncProgram/utils.ts` 中；函数命名不得使用 `create` 开头（如 `submitTaskAndUpdateState` 或 `applyTaskResultToState` 等）；`buyProcessor/index.ts` 与 `sellProcessor/index.ts` 从 `../utils` 直接 `import` 使用，禁止 re-export。

---

### 组 44 — 交易时间 / 生命周期工具重复

| 位置                             | 行范围  | 行数 |
| -------------------------------- | ------- | ---- |
| `src/utils/tradingTime/index.ts` | 243-255 | 13   |
| `src/main/lifecycle/utils.ts`    | 46-56   | 11   |

**说明**：交易时间判断（是否在交易时段）在两处重复。  
**建议的修复**：以 `src/utils/tradingTime/index.ts` 为**单一来源**，将「是否在交易时段」等逻辑保留或集中到该模块；`src/main/lifecycle/utils.ts` 仅做薄封装时，改为从 `src/utils/tradingTime/index` 直接 `import` 并调用，删除重复实现，禁止在 lifecycle 中 re-export tradingTime。

---

### 组 47 — 监控处理器 handler 重复

| 位置                                                                         | 行范围 | 行数 |
| ---------------------------------------------------------------------------- | ------ | ---- |
| `src/main/asyncProgram/monitorTaskProcessor/handlers/liquidationDistance.ts` | 59-79  | 21   |
| `src/main/asyncProgram/monitorTaskProcessor/handlers/unrealizedLoss.ts`      | 49-72  | 24   |

**说明**：强平距离与浮亏两个 handler 内「读取持仓、计算阈值、决定是否告警」等结构相似。  
**建议的修复**：将公共的「监控项检查」逻辑抽成工具函数，放在两 handler 的**最近共同父级**，即 `src/main/asyncProgram/monitorTaskProcessor/utils.ts`（若不存在则新建）；纯函数命名不用 `create` 开头（如 `evaluateMonitorThreshold`）；`liquidationDistance.ts` 与 `unrealizedLoss.ts` 从 `../utils` 直接 `import` 使用，禁止 re-export。

---

### 组 69 — 类型/服务定义与 orderRecorder 类型重复

| 位置                              | 行范围  | 行数 |
| --------------------------------- | ------- | ---- |
| `src/types/services.ts`           | 367-389 | 23   |
| `src/core/orderRecorder/types.ts` | 157-182 | 26   |

**说明**：服务类型与订单记录相关类型存在相同形状或字段重复。  
**建议的修复**：在「使用两者的最近共同父级」的 `types.ts` 中定义**一份**共享类型（若仅被 `src/types` 与 `src/core/orderRecorder` 使用，需评估共同父级是 `src` 还是更合适的一层）；两处从该 `types.ts` 直接 `import type` 使用，或 orderRecorder 的 type `extends` 该公共类型，禁止在两处手写等价类型、禁止 re-export。

---

## 三、测试代码重复 — 按模块分类

测试侧修复须遵守：**`tests/` 与 `src/` 目录结构对应**；跨多个测试模块共用的 helper 放在 `tests/helpers`，仅单模块使用的放在对应 `tests/...` 下；各测试文件从 helper 或工厂**直接 import**，禁止 re-export。测试用工厂函数（造环境、造 fixture）可用 `create` 前缀；纯断言/执行场景函数建议用 `run*`、`assert*` 等命名。

### 3.1 Chaos / Regression 测试

#### 组 1 — API 混沌与订单监控回归

- `tests/chaos/api-flaky-recovery.test.ts` 53-84 (32 行)
- `tests/regression/order-monitor-regression.test.ts` 32-64 (33 行)

**说明**：两处均为「搭建环境 + 模拟不稳定/监控场景」的初始化代码。  
**建议的修复**：抽成工厂函数（如 `createChaosOrRegressionEnv()`）或场景函数（如 `runFlakyOrMonitorScenario()`），因被 chaos 与 regression 两目录共用，放在 **`tests/helpers`** 下独立模块（如 `tests/helpers/chaosRegressionEnv.ts`）；两处测试从该模块直接 `import`，禁止 re-export。

#### 组 2 — 三文件共享 25 行

- `tests/chaos/api-flaky-recovery.test.ts` 55-79
- `tests/chaos/websocket-out-of-order.test.ts` 27-51
- `tests/regression/order-monitor-regression.test.ts` 34-59

**说明**：混沌与回归测试共享「mock/订阅/等待」逻辑。  
**建议的修复**：将该逻辑抽到 **`tests/helpers`** 下（如 `tests/helpers/chaosRegressionEnv.ts` 或 `tests/helpers/subscribeAndWait.ts`），三处测试从该模块直接 `import` 使用。

#### 组 3 — API 混沌与 postTradeRefresher

- `tests/chaos/api-flaky-recovery.test.ts` 173-205 (33 行)
- `tests/main/asyncProgram/postTradeRefresher/business.test.ts` 53-85 (33 行)

**说明**：同为「刷新/重试」或「事后校验」类测试步骤。  
**建议的修复**：抽象为场景函数（如 `runPostTradeRefreshScenario()`），放在 **`tests/helpers`**（跨 chaos 与 main/asyncProgram 共用）或 postTradeRefresher 专用则放在 `tests/main/asyncProgram/postTradeRefresher/` 下；两处从定义处直接 `import`，禁止 re-export。

---

### 3.2 集成测试 — auto-symbol-switch

#### 组 4

- `tests/integration/auto-symbol-switch.integration.test.ts` 33-77 与 206-250（各 45 行）

**说明**：同一文件内两段「自动换标的」流程完全一致。  
**建议的修复**：抽成场景函数（如 `runAutoSymbolSwitchScenario(opts)`），放在**本测试文件同目录** `tests/integration/` 下的 `utils.ts` 或本文件内私有函数；若后续被其他 integration 复用，再提升到 `tests/helpers`，从定义处直接 `import`。

#### 组 5

- 同文件 114-151 与 313-350（各 38 行）

**说明**：另一段 38 行场景重复。  
**建议的修复**：同上，参数化场景函数，放在 `tests/integration/` 或 `tests/helpers`，直接引用。

#### 组 6、组 7

- 与 `full-business-simulation`、`periodic-auto-symbol-chain` 等共享 15–17 行

**说明**：多集成测试共享「等待/断言/状态校验」小片段。  
**建议的修复**：抽成工具或场景函数（如 `waitForAutoSwitchState()`），因被多 integration 文件共用，放在 **`tests/helpers`**（如 `tests/helpers/integrationAssertions.ts` 或 `tests/helpers/autoSwitchState.ts`），各测试从该模块直接 `import`，禁止 re-export。

---

### 3.3 集成测试 — buy-flow / sell-flow

#### 组 28、29、30 — buy-flow 自重复及与 sell-flow 交叉

- `tests/integration/buy-flow.integration.test.ts` 多处 29 行、23 行重复
- `tests/integration/sell-flow.integration.test.ts` 87-109、219-241、334-356 等 23 行与 buy-flow 相似

**说明**：买卖流程测试中「下单 → 等成交 → 查持仓」模式重复。  
**建议的修复**：抽成场景/断言函数（如 `runOrderAndWaitFilled(side, opts)`、`assertPositionAfterFill()`），因被 buy-flow 与 sell-flow 共用，放在 **`tests/helpers`** 或 **`tests/integration/utils.ts`**；两处测试从定义处直接 `import`，禁止 re-export。

#### 组 63–68 — sell-flow 内部重复

- 同文件内多段 14–51 行重复（如 39-67 与 167-195，78-120 与 210-252 等）

**说明**：卖流程不同用例共享「建仓 → 发卖单 → 校验」结构。  
**建议的修复**：参数化场景函数（如 `runSellScenario({ quantity, expectPartial })`），放在 `tests/integration/` 下 utils 或本文件内，从定义处直接引用。

---

### 3.4 集成测试 — full-business-simulation

#### 组 35–42

- 同文件内 37 行、17 行、37 行、19 行、18 行、28 行、33 行、21 行等多段重复，涉及 140-176 与 693-729、250-266 与 791-807、268-304 与 809-844 等

**说明**：全业务仿真里「启动/重置/多轮运行」步骤高度相似。  
**建议的修复**：按阶段抽成场景函数（如 `runSimulationStart()`、`runOneBusinessRound()`、`assertSimulationState()`），放在 **`tests/integration/`** 下 utils 或 **`tests/helpers`**（若被其他 integration 复用）；本测试从定义处直接 `import`，禁止 re-export。

---

### 3.5 集成测试 — periodic-auto-symbol-chain

#### 组 52、53、54

- 89-214 与 274-399（126 行）、200-219 与 406-425（20 行）、222-252 与 427-457（31 行）

**说明**：周期自动换链测试存在大块重复（126 行）。  
**建议的修复**：抽成「运行一条链」的公共场景函数，通过参数区分链或周期；放在 `tests/integration/` 下或 `tests/helpers`，从定义处直接 `import`，禁止 re-export。

---

### 3.6 集成测试 — 其他

#### 组 34 — doomsday 与 processMonitor

- `tests/integration/doomsday.integration.test.ts` 81-105
- `tests/main/processMonitor/index.business.test.ts` 103-127

**说明**：末日保护与主流程监控的「准备 + 触发」逻辑相似。  
**建议的修复**：共用场景/工厂函数（如 `runDoomsdayOrProcessMonitorSetup()`），因跨 integration 与 main/processMonitor，放在 **`tests/helpers`**，两处从该模块直接 `import`，禁止 re-export。

#### 组 49、50、51 — main-program-strict 与 multi-monitor-concurrency

- 29 行、20 行、21 行交叉重复

**说明**：主程序严格模式与多监控并发测试共享「启动/并发/断言」模式。  
**建议的修复**：在 **`tests/helpers`** 中提供统一编排函数，两处测试从该模块直接 `import`，禁止 re-export。

---

### 3.7 asyncProgram 业务测试 — buyProcessor / sellProcessor / monitorTaskProcessor

#### 组 12–15

- `tests/main/asyncProgram/sellProcessor/business.test.ts` 47-137（91 行）与 `tests/main/asyncProgram/buyProcessor/business.test.ts` 40-130（91 行）
- 52 行、28 行、31 行子块还与 `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`、`tests/main/processMonitor/index.business.test.ts` 重复

**说明**：买/卖/监控处理器测试的「造数据 → 调处理器 → 断言」结构高度一致。  
**建议的修复**：抽成场景函数（如 `runProcessorTest({ processor, input, expected })`）或表格驱动用例；因被 **`tests/main/asyncProgram`** 下多子模块与 **`tests/main/processMonitor`** 共用，放在**最近共同父级**即 **`tests/main/asyncProgram/utils.ts`** 或 **`tests/main/utils.ts`**（与 `src/main` 对应），各测试从该 utils 直接 `import`，禁止 re-export。

#### 组 16、17、18、19

- sellProcessor 内部 266-286 与 314-334；buyProcessor 内部 191-223 与 236-268；monitorTaskProcessor 内部多段 28–32 行重复

**说明**：各处理器测试文件内部多组「不同输入、相同结构」的用例。  
**建议的修复**：用 `describe.each` 或共享的 `buildProcessorTestCase()`；若 `buildProcessorTestCase` 仅本文件用则保留在本文件，若多文件共用则放在 `tests/main/asyncProgram/utils.ts` 等对应位置，直接引用。

---

### 3.8 services — cleanup / autoSymbolManager

#### 组 20–27 — cleanup business.test

- `tests/services/cleanup/business.test.ts` 内 44 行、38 行、46 行、54 行、48 行、30 行、50 行、45 行等多组重复（84-127、157-200、247-290 等）

**说明**：清理服务测试中「准备数据 → 执行清理 → 断言结果」重复多次。  
**建议的修复**：抽成 `runCleanupTestCase({ before, after, options })` 或 `it.each` 数据驱动；该函数仅被 cleanup 测试使用则放在 **`tests/services/cleanup/utils.ts`**（与 `src/services/cleanup` 对应），从本测试文件直接 `import`，禁止 re-export。

#### 组 8–11 — autoSearch / switchStateMachine

- `tests/services/autoSymbolManager/autoSearch.business.test.ts` 与 `tests/services/autoSymbolManager/switchStateMachine.business.test.ts` 20–30 行交叉重复；autoSearch 内部 22-44 与 105-127、46-75 与 129-158、140-168 与 215-243

**说明**：自动搜索与切换状态机测试共享「状态准备 + 触发 + 断言」模式。  
**建议的修复**：公共场景函数（如 `runAutoSearchOrSwitchTestCase()`）放在 **`tests/services/autoSymbolManager/utils.ts`**（两测试文件的最近共同父级，与 `src/services/autoSymbolManager` 对应）；同文件内重复用参数化用例；两处测试从该 utils 直接 `import`，禁止 re-export。

#### 组 55–60、70–84 — periodicSwitch / switchStateMachine

- `tests/services/autoSymbolManager/periodicSwitch.business.test.ts` 与 `switchStateMachine.business.test.ts` 多段重复；switchStateMachine 内部大量重复

**说明**：状态机与周期切换测试存在大量「状态 + 事件 → 期望状态」重复。  
**建议的修复**：用 `it.each([...statesAndEvents])` 或共享场景函数，放在 **`tests/services/autoSymbolManager/utils.ts`** 或类型放在 **`tests/services/autoSymbolManager/types.ts`**（若需共享测试用类型）；各测试从定义处直接 `import`，禁止 re-export。

---

### 3.9 lifecycle / startup / processMonitor

#### 组 32、33 — dayLifecycleManager

- `tests/main/lifecycle/dayLifecycleManager.test.ts` 84-97 与 `tests/main/lifecycle/integration.test.ts` 63-76（14 行）；同文件 220-240 与 263-283（21 行）

**说明**：日生命周期单元与集成测试共享「日期/状态准备」；单元内两用例步骤一致。  
**建议的修复**：共享准备逻辑放在 **`tests/main/lifecycle/utils.ts`**（与 `src/main/lifecycle` 对应）；单元内重复用 `describe.each` 或参数化；两测试文件从该 utils 直接 `import`，禁止 re-export。

#### 组 48 — loadTradingDayRuntimeSnapshot

- `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` 76-94 与 117-135（19 行）

**说明**：两处加载/恢复快照的测试步骤相同。  
**建议的修复**：抽成 `runLoadSnapshotScenario(opts)`，放在本文件内或 **`tests/main/lifecycle/utils.ts`**，从定义处直接引用。

#### 组 61 — seat.business.test

- `tests/main/startup/seat.business.test.ts` 94-127 与 161-194（34 行）

**说明**：座位/席位测试两段 34 行重复。  
**建议的修复**：抽象为「以某配置启动席位并断言」的公共函数，放在 **`tests/main/startup/utils.ts`**（与 `src/main/startup` 对应），本测试从该 utils 直接 `import`，禁止 re-export。

#### 组 62 — seatSync.business.test

- `tests/main/processMonitor/seatSync.business.test.ts` 119-146 与 211-238（28 行）

**说明**：座位同步两用例共享 28 行。  
**建议的修复**：抽成 `runSeatSyncScenario()`，放在 **`tests/main/processMonitor/utils.ts`** 或本文件内，从定义处直接引用，禁止 re-export。

---

### 3.10 core 测试

#### 组 45、46 — orderRecorder / resolveSellQuantityBySmartClose / testDoubles

- `tests/core/orderRecorder/integration.test.ts` 39-58/39-55
- `tests/core/signalProcessor/resolveSellQuantityBySmartClose.test.ts` 37-56/37-53
- `tests/helpers/testDoubles.ts` 69-85（17 行）

**说明**：订单记录与智能平仓数量解析测试共享「造单/造持仓」的 17–20 行；testDoubles 中也有类似构造。  
**建议的修复**：以**单一来源**提供 fixture 工厂（如 `createOrderRecorderFixtures()`、`createSmartCloseFixtures()`）。若放在 **`tests/helpers/testDoubles.ts`** 则 orderRecorder 与 signalProcessor 测试从该文件直接 `import`；若放在 **`tests/core/`** 下共用则需评估最近共同父级（orderRecorder 与 signalProcessor 的共同父级是 `tests/core`），可放在 **`tests/core/utils.ts`** 或 **`tests/helpers`**。禁止在两处重复实现相同构造逻辑，禁止 re-export。

---

## 四、Mock / 工厂与类型重复

### 组 31 — configFactory 与 testDoubles

| 位置                              | 行范围  | 行数 |
| --------------------------------- | ------- | ---- |
| `mock/factories/configFactory.ts` | 13-40   | 28   |
| `tests/helpers/testDoubles.ts`    | 368-394 | 27   |

**说明**：配置工厂与测试替身中构造「配置对象」的逻辑重复。  
**建议的修复**：以 **`mock/factories/configFactory.ts`** 为**单一来源**；`tests/helpers/testDoubles.ts` 删除重复实现，改为从 **`mock/factories/configFactory`** 直接 `import` 并使用其工厂函数（如 `build()` 或已有导出），禁止在 testDoubles 中 re-export configFactory，仅在使用处按需从 configFactory 直接引用。

---

## 五、工具脚本重复

### 组 84 — dailyIndicatorAnalysis utils

- `tools/dailyIndicatorAnalysis/utils.ts` 148-165 与 174-191（各 18 行）

**说明**：同一工具模块内两段 18 行逻辑重复，多为「解析/聚合指标」的相似分支。  
**建议的修复**：将重复逻辑抽成**纯工具函数**，放在同模块 **`tools/dailyIndicatorAnalysis/utils.ts`** 中；函数命名**不得使用 `create` 开头**（如 `processIndicatorBlock(type)` 或 `aggregateIndicatorByType(type)`）；原两处调用改为从本文件内该函数直接引用，保持单一实现。

---

## 六、修复建议优先级

所有修复须符合 **TypeScript 项目规范**（类型入 `types.ts`、工具入 `utils.ts`、常量入 `src/constants`、测试与 `src/` 对应、禁止 re-export、纯函数不用 `create` 开头等），见本文「一、概览」中的代码组织规范。

| 优先级 | 对象                           | 建议                                                                                                                                                 |
| ------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | 组 43、44、47、69              | 生产代码重复：公共逻辑入**最近共同父级**的 `utils.ts`，公共类型入 `types.ts`，单一来源，使用处直接 `import`，禁止 re-export。                        |
| **P1** | 组 31、84                      | 单一来源：配置以 `mock/factories/configFactory` 为准，testDoubles 直接引用；工具脚本重复逻辑抽到同模块 `utils.ts`，纯函数命名不用 `create` 开头。    |
| **P2** | 组 12–15、20–27、52、60、70–84 | 测试重复：抽到对应 **`tests/...` 下 utils 或 `tests/helpers`**，与 `src/` 结构对应；参数化或 `it.each` 收敛，从定义处直接 `import`，禁止 re-export。 |
| **P3** | 其余测试组                     | 按需抽场景/断言函数到对应 `tests/.../utils.ts` 或 `tests/helpers`，直接引用。                                                                        |

---

## 七、当前仍存在的重复（可选修复）

以下为执行 `bun sonarqube` 后运行 `bun sonarqube:duplications` 得到的** 60 组**重复（均为**测试代码**，27 个文件）。可按需择组收敛。

| 组号 | 位置概要 | 建议 |
|------|----------|------|
| 1–3 | chaos / regression / postTradeRefresher | 抽到 `tests/helpers`（如 chaosRegressionEnv、subscribeAndWait、runPostTradeRefreshScenario） |
| 4–7 | auto-symbol-switch、full-business-simulation、periodic-auto-symbol-chain 同文件内多段 | 参数化场景函数（runAutoSymbolSwitchScenario、runOneBusinessRound 等） |
| 8–9 | autoSearch.business.test 内部 | it.each 或 buildAutoSearchTestCase |
| 10–13 | sellProcessor/buyProcessor/monitorTaskProcessor business.test 内部 | describe.each 或 buildProcessorTestCase |
| 14 | cleanup/business.test 内部 | 已部分收敛，可继续用 runCleanupTestCase/it.each |
| 15–19 | buy-flow integration、lifecycle（dayLifecycleManager） | runOrderAndWaitFilled 等入 tests/helpers；lifecycle 入 tests/main/lifecycle/utils.ts |
| 20–27 | full-business-simulation、main-loop-latency 多段 | runSimulationStart、runOneBusinessRound、assertSimulationState 等 |
| 28–29 | orderRecorder / resolveSellQuantityBySmartClose / testDoubles | tests/helpers 或 tests/core/utils 单一 fixture 工厂 |
| 30 | loadTradingDayRuntimeSnapshot 同文件内 | tests/main/lifecycle/utils.ts 场景函数 |
| 31–33 | main-program-strict / multi-monitor-concurrency | tests/helpers 统一编排函数 |
| 34–36 | periodic-auto-symbol-chain 大块（含 126 行） | 运行一条链的公共场景函数，参数区分链/周期 |
| 37–42 | autoSymbolManager periodicSwitch / switchStateMachine | it.each 或 tests/services/autoSymbolManager/utils 场景函数 |
| 43–44 | startup/seat、processMonitor/seatSync | tests/main/startup/utils、processMonitor/utils 场景函数 |
| 45–50 | sell-flow.integration.test 多段 | runOrderAndWaitFilled、assertPositionAfterFill 等 |
| 51–60 | switchStateMachine.business.test 内部多段 | 表格驱动 / it.each 收敛 |

---

## 八、链接

- **Dashboard**: http://localhost:9000/dashboard?id=longbridge-option-quant
- **Duplications**: http://localhost:9000/project/duplications?id=longbridge-option-quant

---

_本报告由 `bun sonarqube:duplications` 输出整理生成，共 84 组重复块。修复方案须符合项目 **TypeScript 项目规范**（`.agents/skills/typescript-project-specifications`），重点遵守代码组织：类型入 `types.ts`、工具入 `utils.ts`、常量入 `src/constants`、测试目录与 `src/` 对应、禁止 re-export、纯函数命名不用 `create` 开头。_
