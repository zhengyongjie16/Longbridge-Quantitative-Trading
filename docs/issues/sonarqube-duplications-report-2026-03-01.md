# SonarQube 重复项报告

**生成时间**: 2026-03-01  
**命令**: `bun sonarqube:duplications`  
**统计**: 涉及文件数 39，重复块组数 84

---

## 一、概览

本报告记录 SonarQube 检测到的所有代码重复（Duplications），按来源分为：

| 类别 | 说明 | 组数 |
|------|------|------|
| **生产代码 (src/)** | 业务逻辑重复，优先修复 | 5 组 |
| **测试代码 (tests/)** | 测试用例间重复，可抽公共 helper | 多数 |
| **Mock/工厂** | 配置构造重复 | 1 组 |
| **工具脚本 (tools/)** | 脚本内重复 | 1 组 |

---

## 二、生产代码重复（高优先级）

### 组 43 — buyProcessor / sellProcessor 逻辑重复

| 位置 | 行范围 | 行数 |
|------|--------|------|
| `src/main/asyncProgram/buyProcessor/index.ts` | 173-197 | 25 |
| `src/main/asyncProgram/sellProcessor/index.ts` | 135-159 | 25 |

**说明**: 买处理器与卖处理器中存在 25 行相似逻辑，多为「构建/提交任务」或「状态更新」类代码。建议抽成共享函数（如 `submitTaskAndUpdateState`）或共用工具模块，避免双端逻辑漂移。

---

### 组 44 — 交易时间 / 生命周期工具重复

| 位置 | 行范围 | 行数 |
|------|--------|------|
| `src/utils/tradingTime/index.ts` | 243-255 | 13 |
| `src/main/lifecycle/utils.ts` | 46-56 | 11 |

**说明**: 交易时间判断或「是否在交易时段」的逻辑在 `tradingTime` 与 `lifecycle/utils` 中重复。应统一由 `tradingTime` 提供单一来源，`lifecycle/utils` 仅做封装调用。

---

### 组 47 — 监控处理器 handler 重复

| 位置 | 行范围 | 行数 |
|------|--------|------|
| `src/main/asyncProgram/monitorTaskProcessor/handlers/liquidationDistance.ts` | 59-79 | 21 |
| `src/main/asyncProgram/monitorTaskProcessor/handlers/unrealizedLoss.ts` | 49-72 | 24 |

**说明**: 强平距离与浮亏两个 handler 内部存在约 20 行相似结构（如读取持仓、计算阈值、决定是否告警）。可抽公共的「监控项检查」基逻辑或共享 `runMonitorCheck`，两 handler 只填差异参数。

---

### 组 69 — 类型/服务定义与 orderRecorder 类型重复

| 位置 | 行范围 | 行数 |
|------|--------|------|
| `src/types/services.ts` | 367-389 | 23 |
| `src/core/orderRecorder/types.ts` | 157-182 | 26 |

**说明**: 服务类型与订单记录相关类型存在字段或结构重复。建议用 `extends` 或共用基础类型/接口，避免两处手写相同形状。

---

## 三、测试代码重复 — 按模块分类

### 3.1 Chaos / Regression 测试

#### 组 1 — API 混沌与订单监控回归

- `tests/chaos/api-flaky-recovery.test.ts` 53-84 (32 行)
- `tests/regression/order-monitor-regression.test.ts` 32-64 (33 行)

**说明**: 两处均为「搭建环境 + 模拟不稳定/监控场景」的初始化代码，可抽成 `createChaosOrRegressionEnv()` 或共用的 `setupFlakyOrMonitorScenario()`。

#### 组 2 — 三文件共享 25 行

- `tests/chaos/api-flaky-recovery.test.ts` 55-79
- `tests/chaos/websocket-out-of-order.test.ts` 27-51
- `tests/regression/order-monitor-regression.test.ts` 34-59

**说明**: 混沌测试与回归测试共享一段「mock/订阅/等待」逻辑，适合放到 `tests/helpers` 下的 `chaosOrRegressionHelpers.ts`。

#### 组 3 — API 混沌与 postTradeRefresher

- `tests/chaos/api-flaky-recovery.test.ts` 173-205 (33 行)
- `tests/main/asyncProgram/postTradeRefresher/business.test.ts` 53-85 (33 行)

**说明**: 同为「刷新/重试」或「事后校验」类测试步骤，可抽象为 `runPostTradeRefreshScenario()` 供两处复用。

---

### 3.2 集成测试 — auto-symbol-switch

#### 组 4

- `tests/integration/auto-symbol-switch.integration.test.ts` 33-77 与 206-250（各 45 行）

**说明**: 同一文件内两段「自动换标的」流程完全一致，建议抽成 `runAutoSymbolSwitchScenario(opts)` 并调用两次。

#### 组 5

- 同文件 114-151 与 313-350（各 38 行）

**说明**: 另一段 38 行场景重复，同样适合参数化函数。

#### 组 6、组 7

- 与 `full-business-simulation`、`periodic-auto-symbol-chain` 等共享 15–17 行

**说明**: 多集成测试共享「等待/断言/状态校验」小片段，可提到 `tests/helpers/integrationAssertions.ts` 或 `waitForAutoSwitchState()`。

---

### 3.3 集成测试 — buy-flow / sell-flow

#### 组 28、29、30 — buy-flow 自重复及与 sell-flow 交叉

- `tests/integration/buy-flow.integration.test.ts` 多处 29 行、23 行重复
- `tests/integration/sell-flow.integration.test.ts` 87-109、219-241、334-356 等 23 行与 buy-flow 相似

**说明**: 买卖流程测试中「下单 → 等成交 → 查持仓」的模式重复，可抽 `runOrderAndWaitFilled(side, opts)` 与 `assertPositionAfterFill()`，buy-flow 与 sell-flow 共用。

#### 组 63–68 — sell-flow 内部重复

- 同文件内多段 14–51 行重复（如 39-67 与 167-195，78-120 与 210-252 等）

**说明**: 卖流程不同用例共享「建仓 → 发卖单 → 校验」结构，建议参数化场景（如 `runSellScenario({ quantity, expectPartial } )`）。

---

### 3.4 集成测试 — full-business-simulation

#### 组 35–42

- 同文件内 37 行、17 行、37 行、19 行、18 行、28 行、33 行、21 行等多段重复，涉及 140-176 与 693-729、250-266 与 791-807、268-304 与 809-844 等

**说明**: 全业务仿真里「启动/重置/多轮运行」的步骤高度相似，建议按阶段抽成：`startSimulation()`、`runOneBusinessRound()`、`assertSimulationState()` 等，用参数区分不同用例。

---

### 3.5 集成测试 — periodic-auto-symbol-chain

#### 组 52、53、54

- 89-214 与 274-399（126 行）、200-219 与 406-425（20 行）、222-252 与 427-457（31 行）

**说明**: 周期自动换链测试存在大块重复（126 行），明显可抽成「运行一条链」的公共函数，通过参数区分链 A/链 B 或不同周期。

---

### 3.6 集成测试 — 其他

#### 组 34 — doomsday 与 processMonitor

- `tests/integration/doomsday.integration.test.ts` 81-105
- `tests/main/processMonitor/index.business.test.ts` 103-127

**说明**: 末日保护与主流程监控的「准备 + 触发」逻辑相似，可共用 `setupDoomsdayOrProcessMonitorTest()`。

#### 组 49、50、51 — main-program-strict 与 multi-monitor-concurrency

- 29 行、20 行、21 行交叉重复

**说明**: 主程序严格模式与多监控并发测试共享「启动/并发/断言」模式，适合在 `tests/helpers` 中提供统一编排函数。

---

### 3.7 asyncProgram 业务测试 — buyProcessor / sellProcessor / monitorTaskProcessor

#### 组 12–15

- `sellProcessor/business.test.ts` 47-137（91 行）与 `buyProcessor/business.test.ts` 40-130（91 行）
- 52 行、28 行、31 行子块还与 `monitorTaskProcessor/business.test.ts`、`processMonitor/index.business.test.ts` 重复

**说明**: 买/卖/监控处理器测试的「造数据 → 调处理器 → 断言」结构高度一致，强烈建议抽成 `runProcessorTest({ processor, input, expected })` 或按「给定持仓/订单 → 期望结果」的表格驱动测试。

#### 组 16、17、18、19

- sellProcessor 内部 266-286 与 314-334；buyProcessor 内部 191-223 与 236-268；monitorTaskProcessor 内部多段 28–32 行重复

**说明**: 各处理器测试文件内部多组「不同输入、相同结构」的用例，适合用 `describe.each` 或共享 `buildProcessorTestCase()`。

---

### 3.8 services — cleanup / autoSymbolManager

#### 组 20–27 — cleanup business.test

- `tests/services/cleanup/business.test.ts` 内 44 行、38 行、46 行、54 行、48 行、30 行、50 行、45 行等多组重复（84-127、157-200、247-290 等）

**说明**: 清理服务测试中「准备数据 → 执行清理 → 断言结果」重复多次，应抽成 `runCleanupTestCase({ before, after, options })` 或数据驱动的 `it.each`。

#### 组 8–11 — autoSearch / switchStateMachine

- `autoSearch.business.test.ts` 与 `switchStateMachine.business.test.ts` 20–30 行交叉重复；autoSearch 内部 22-44 与 105-127、46-75 与 129-158、140-168 与 215-243

**说明**: 自动搜索与切换状态机测试共享「状态准备 + 触发 + 断言」模式，可抽公共 `runAutoSearchOrSwitchTestCase()`；同文件内重复用参数化用例收敛。

#### 组 55–60、70–84 — periodicSwitch / switchStateMachine

- `periodicSwitch.business.test.ts` 与 `switchStateMachine.business.test.ts` 多段 12–31 行重复；switchStateMachine 内部 26 行、21 行、24 行、45 行、31 行、28 行、50 行、41 行、43 行、39 行、78 行、61 行、48 行等大量重复

**说明**: 状态机与周期切换测试存在大量「状态 + 事件 → 期望状态」的重复，非常适合用状态机测试框架或 `it.each([...statesAndEvents])` 统一描述，避免手写多段相似代码。

---

### 3.9 lifecycle / startup / processMonitor

#### 组 32、33 — dayLifecycleManager

- `dayLifecycleManager.test.ts` 84-97 与 `integration.test.ts` 63-76（14 行）；同文件 220-240 与 263-283（21 行）

**说明**: 日生命周期单元与集成测试共享「日期/状态准备」；单元内两用例步骤一致，可参数化。

#### 组 48 — loadTradingDayRuntimeSnapshot

- 同文件 76-94 与 117-135（19 行）

**说明**: 两处加载/恢复快照的测试步骤相同，抽成 `runLoadSnapshotScenario(opts)`。

#### 组 61 — seat.business.test

- 94-127 与 161-194（34 行）

**说明**: 座位/席位测试两段 34 行重复，可抽象为「以某配置启动席位并断言」的公共函数。

#### 组 62 — seatSync.business.test

- 119-146 与 211-238（28 行）

**说明**: 座位同步两用例共享 28 行，建议抽 `runSeatSyncScenario()`。

---

### 3.10 core 测试

#### 组 45、46 — orderRecorder / resolveSellQuantityBySmartClose / testDoubles

- `tests/core/orderRecorder/integration.test.ts` 39-58/39-55
- `tests/core/signalProcessor/resolveSellQuantityBySmartClose.test.ts` 37-56/37-53
- `tests/helpers/testDoubles.ts` 69-85（17 行）

**说明**: 订单记录与智能平仓数量解析测试共享「造单/造持仓」的 17–20 行；testDoubles 中也有类似构造。建议在 testDoubles 或 testHelpers 中提供 `createOrderRecorderFixtures()` / `createSmartCloseFixtures()`，两处测试共用。

---

## 四、Mock / 工厂与类型重复

### 组 31 — configFactory 与 testDoubles

| 位置 | 行范围 | 行数 |
|------|--------|------|
| `mock/factories/configFactory.ts` | 13-40 | 28 |
| `tests/helpers/testDoubles.ts` | 368-394 | 27 |

**说明**: 配置工厂与测试替身中构造「配置对象」的逻辑重复。应只保留一处（建议 `configFactory`）为单一来源，testDoubles 通过 `configFactory.build()` 或类似 API 复用。

---

## 五、工具脚本重复

### 组 84 — dailyIndicatorAnalysis utils

- `tools/dailyIndicatorAnalysis/utils.ts` 148-165 与 174-191（各 18 行）

**说明**: 同一工具模块内两段 18 行逻辑重复，多为「解析/聚合指标」的相似分支。可抽成 `processIndicatorBlock(type)` 或通过配置驱动不同分支。

---

## 六、修复建议优先级

| 优先级 | 对象 | 建议 |
|--------|------|------|
| **P0** | 组 43、44、47、69 | 生产代码重复，影响可维护性与一致性，优先抽公共函数或类型。 |
| **P1** | 组 31、84 | 单点事实：配置构造与工具脚本统一到单一实现。 |
| **P2** | 组 12–15、20–27、52、60、70–84 | 测试中大批量重复（尤其是 switchStateMachine、cleanup、full-business-simulation、periodic-auto-symbol-chain），用参数化或共享 helper 大幅减少行数。 |
| **P3** | 其余测试组 | 按需抽公共「场景函数」或断言 helper，降低重复度。 |

---

## 七、链接

- **Dashboard**: http://localhost:9000/dashboard?id=longbridge-option-quant  
- **Duplications**: http://localhost:9000/project/duplications?id=longbridge-option-quant  

---

*本报告由 `bun sonarqube:duplications` 输出整理生成，共 84 组重复块。*
