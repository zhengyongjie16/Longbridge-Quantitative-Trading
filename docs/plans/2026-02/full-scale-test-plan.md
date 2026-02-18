# 全规模业务逻辑测试最终实施方案（合并版）

> 文档版本：v3（合并 `full-scale-test-plan.md` + `2026-02-16-full-scale-test-implementation-plan.md`）
> 适用仓库：`D:/code/Longbridge-Quantitative-Trading`
> 测试框架：`bun:test`
> 输出范围：`tests/` + 根目录 `mock/`
> 文档目标：作为唯一执行基线，指导后续全规模测试代码落地

---

## 1. 执行目标与约束

### 1.1 总目标

1. 在 `tests/` 下建立业务逻辑驱动的全规模测试体系，而不是仅做函数级单元测试。
2. 通过 `mock/` 构建 LongPort API 仿真环境，覆盖运行中真实交互行为（行情推送、订单推送、API 查询、失败恢复）。
3. 覆盖程序全链路：
- 行情与指标
- 信号生成与分流
- 延迟验证
- 买入/卖出异步处理
- 风险检查与保护性清仓
- 自动寻标/换标
- 订单监控
- 交易后刷新
- 跨日生命周期
4. 确保测试断言围绕业务规则与运行态一致性，不停留在“返回值正确”。

### 1.2 已确认决策（本方案强制采用）

1. **可测性改造策略**：尽量不对 `src/` 做注入改造。
2. **覆盖率目标**：全局覆盖率下限为 `85%`。
3. **执行组织**：采用多子代理并行协同（14 个 Agent）。
4. **规则冲突处理**：源码优先；若业务文档与源码冲突，测试以源码行为为准并记录差异。

### 1.3 真值优先级

1. 当前 `src/` 源码行为（最高优先级）。
2. `skills/core-program-business-logic/SKILL.md` 业务规则。
3. README 与历史计划文档。

---

## 2. 源码基线（测试必须对齐）

### 2.1 常量与阈值基线

| 主题 | 源码常量 | 实际值 | 测试要求 |
|---|---|---:|---|
| 牛证买入最小安全距离 | `BULL_WARRANT_MIN_DISTANCE_PERCENT` | `0.35` | 覆盖边界值：0.35 上下邻域 |
| 熊证买入最大安全距离 | `BEAR_WARRANT_MAX_DISTANCE_PERCENT` | `-0.35` | 覆盖边界值：-0.35 上下邻域 |
| 牛证清仓距离阈值 | `BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT` | `0.3` | 覆盖触发/不触发边界 |
| 熊证清仓距离阈值 | `BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT` | `-0.3` | 覆盖触发/不触发边界 |
| 监控标的最小有效价 | `MIN_MONITOR_PRICE_THRESHOLD` | `1` | 覆盖 `<1` 拒绝、`=1` 通过 |
| 风险检查冷却秒数 | `VERIFIED_SIGNAL_COOLDOWN_SECONDS` | `10` | 覆盖 0~10 秒行为 |
| Trade API 最小间隔 | `API.MIN_CALL_INTERVAL_MS` | `30ms` | 覆盖并发节流与串行 |
| Trade API 窗口限制 | `rateLimiter default` | 30秒≤30次 | 覆盖窗口边界 |
| 自动寻标候选缓存 TTL | `AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS` | `3000ms` | 覆盖过期与复用 |
| 自动寻标冷却 | `AUTO_SYMBOL_SEARCH_COOLDOWN_MS` | `600000ms` | 覆盖 10 分钟冷却 |

### 2.2 买入风险流水线真实顺序

`riskCheckPipeline` 测试必须按以下顺序验证：

1. 前置冷却过滤（进入检查前拦截）。
2. 存在买入信号时批量 API 拉取 `account + positions`。
3. 逐信号处理并写入冷却时间戳。
4. 交易频率检查 `_canTradeNow`。
5. 清仓冷却检查 `liquidationCooldownTracker.getRemainingMs`。
6. 频率通过后立即 `_markBuyAttempt` 预占时间槽。
7. 买入价格限制。
8. 末日保护拒买。
9. 牛熊证风险检查。
10. 基础风险检查 `checkBeforeOrder`。

### 2.3 冷却键规则

1. 冷却键按交易标的 `signal.symbol` 计算。
2. `BUYCALL` 与 `BUYPUT` 共享 `${symbol}_BUY`。
3. `SELLCALL` 与 `SELLPUT` 共享 `${symbol}_SELL`。

### 2.4 卖出链路真实行为

1. 主卖出链路由 `sellProcessor` 执行，不走 `applyRiskChecks`。
2. 卖出处理前必须 `refreshGate.waitForFresh()`。
3. 卖出数量由 `processSellSignals` 计算。
4. 卖出超时为“撤单后转市价单（MO）”。
5. 改单限制生效：
- `NON_REPLACEABLE_ORDER_STATUSES`（如 WaitToReplace/PendingReplace）
- `NON_REPLACEABLE_ORDER_TYPES`（MO 不可改）

---

## 3. 全链路测试总体架构

### 3.1 分层模型

| 层级 | 目标 | 关注点 | 目录 |
|---|---|---|---|
| L0 Mock 合同层 | 验证 mock 与 SDK 合同一致 | 接口签名、字段结构、事件语义 | `tests/mock-contract/` |
| L1 业务规则层 | 验证单模块业务规则 | 规则正确性、边界值、拒绝路径 | `tests/core/`, `tests/services/` |
| L2 协同流程层 | 验证模块协作与时序 | 门禁、队列、缓存一致性 | `tests/main/` |
| L3 端到端层 | 验证交易日真实流程 | 全链路状态迁移与不变量 | `tests/integration/` |
| L4 回归/混沌层 | 验证异常恢复与稳定性 | 失败注入、并发竞态、乱序推送 | `tests/regression/`, `tests/chaos/` |

### 3.2 测试设计原则

1. 每条关键规则至少包含：
- 正向路径
- 拒绝路径
- 边界路径
- 并发/竞态路径
2. 每个流程测试必须包含：
- 前置状态
- 输入事件序列
- 期望状态迁移
- 终态不变量
3. 关键路径断言必须覆盖“结果 + 副作用”：
- 结果：是否下单/是否拦截
- 副作用：队列变化、缓存更新、对象释放、日志标签、冷却记录
4. 先验证 mock 合同，再进入业务测试，避免“假 mock 误导真业务”。

---

## 4. 目录规划（目标）

### 4.1 根目录 `mock/`

```text
mock/
├── longport/
│   ├── quoteContextMock.ts
│   ├── tradeContextMock.ts
│   ├── eventBus.ts
│   ├── decimal.ts
│   └── contracts.ts
├── factories/
│   ├── quoteFactory.ts
│   ├── tradeFactory.ts
│   ├── signalFactory.ts
│   ├── configFactory.ts
│   └── lifecycleFactory.ts
├── scenario/
│   ├── clock.ts
│   ├── scheduler.ts
│   ├── scenarioBuilder.ts
│   └── assertions.ts
├── fixtures/
│   ├── normal-day.json
│   ├── half-day.json
│   ├── doomsday-window.json
│   └── auto-switch-boundary.json
└── index.ts
```

### 4.2 `tests/` 目标结构

```text
tests/
├── mock-contract/
│   ├── quoteContext.contract.test.ts
│   ├── tradeContext.contract.test.ts
│   └── decimal.contract.test.ts
├── core/
│   ├── strategy/
│   ├── signalProcessor/
│   ├── riskController/
│   ├── orderRecorder/
│   ├── trader/
│   └── doomsdayProtection/
├── services/
│   ├── quoteClient/
│   ├── marketMonitor/
│   ├── monitorContext/
│   ├── liquidationCooldown/
│   └── cleanup/
├── main/
│   ├── processMonitor/
│   ├── asyncProgram/
│   │   ├── buyProcessor/
│   │   ├── sellProcessor/
│   │   ├── delayedSignalVerifier/
│   │   ├── monitorTaskQueue/
│   │   ├── monitorTaskProcessor/
│   │   ├── orderMonitorWorker/
│   │   └── postTradeRefresher/
│   └── lifecycle/
├── integration/
│   ├── buy-flow.integration.test.ts
│   ├── sell-flow.integration.test.ts
│   ├── protective-liquidation.integration.test.ts
│   ├── doomsday.integration.test.ts
│   ├── auto-symbol-switch.integration.test.ts
│   ├── lifecycle-crossday.integration.test.ts
│   └── multi-monitor-concurrency.integration.test.ts
├── regression/
│   ├── risk-pipeline-regression.test.ts
│   └── order-monitor-regression.test.ts
└── chaos/
    ├── api-flaky-recovery.test.ts
    └── websocket-out-of-order.test.ts
```

---

## 5. LongPort API Mock 设计（按 SDK 文档）

### 5.1 QuoteContext Mock 接口合同

必须实现并可编程控制：

1. `quote(symbols)`
2. `staticInfo(symbols)`
3. `subscribe(symbols, subTypes)`
4. `unsubscribe(symbols, subTypes)`
5. `subscribeCandlesticks(symbol, period, tradeSessions)`
6. `unsubscribeCandlesticks(symbol, period)`
7. `realtimeCandlesticks(symbol, period, count)`
8. `tradingDays(market, begin, end)`
9. `warrantQuote(symbols)`
10. `warrantList(symbol, sortBy, sortOrder, types)`
11. `setOnQuote(callback)`
12. `setOnCandlestick(callback)`

### 5.2 TradeContext Mock 接口合同

必须实现并可编程控制：

1. `submitOrder(options)`
2. `cancelOrder(orderId)`
3. `replaceOrder(options)`
4. `todayOrders(options?)`
5. `historyOrders(options?)`
6. `todayExecutions(options?)`
7. `accountBalance(currency?)`
8. `stockPositions(symbols?)`
9. `setOnOrderChanged(callback)`
10. `subscribe(topics)`
11. `unsubscribe(topics)`

### 5.3 Mock 约束（必须满足）

1. 价格/金额字段保留 Decimal 语义。
2. 推送事件支持可控时间戳与乱序注入。
3. 记录每次调用参数、时间、返回、异常。
4. 故障注入支持：
- 第 N 次失败
- 条件失败（按 symbol/action）
- 窗口限流失败
5. 并发请求可由调度器确定性重放。

---

## 6. 场景驱动器设计

### 6.1 核心组件

1. `clock`：统一时间源，驱动所有“秒级主循环 + 定时器验证”。
2. `scheduler`：按时间片注入行情推送、订单推送、API 响应变化。
3. `scenarioBuilder`：声明式定义场景。
4. `assertions`：封装业务断言模板。

### 6.2 场景定义模板

每个场景必须包含：

1. `Given`：初始持仓、订单、席位、缓存状态。
2. `When`：事件序列（行情变化、信号触发、API 成功/失败、推送乱序）。
3. `Then`：
- 业务结果（下单/拒单/清仓/换标）
- 状态结果（队列、缓存、冷却、版本号）
- 运行态不变量（无重复卖出、无旧版本信号穿透）

---

## 7. 模块级业务测试方案

## 7.1 `core/strategy` + `main/processMonitor/signalPipeline`

1. 组内最少命中数、组间 OR 规则。
2. 卖出信号前置条件（无买单不生成卖信号）。
3. 立即/延迟分流。
4. 席位状态/版本/symbol 校验。
5. 行情未就绪时买入丢弃、卖出可继续尝试。

## 7.2 `main/asyncProgram/delayedSignalVerifier`

1. T0/T0+5/T0+10 三点趋势验证。
2. 四种 action 趋势方向分别验证。
3. 时间容忍度 ±5 秒。
4. 缺点数据拒绝路径。
5. 验证通过入队、失败释放对象。
6. 退出连续交易时段和标的切换时待验证清理。

## 7.3 `core/signalProcessor/riskCheckPipeline`

1. 冷却前置过滤（避免无效 API 调用）。
2. 冷却键共享机制（BUY/SELL 分组）。
3. 批量 API 拉取与失败统一拒绝。
4. 交易频率 + 预占时间槽。
5. 清仓冷却、买入价格限制、末日保护。
6. 牛熊证阈值与监控价阈值边界。
7. 基础风险检查。

## 7.4 `core/riskController`

1. `checkBeforeOrder` 的买入/卖出分支。
2. 持仓市值上限、现金不足、浮亏超限。
3. `warrantRiskChecker` 初始化、回收价检查、距离阈值。
4. 距回收价触发清仓边界。

## 7.5 `core/orderRecorder`

1. 过滤算法：按时间序与低价优先整笔消除。
2. M0 订单无条件保留。
3. 待成交卖出登记/部分成交/完全成交/撤单迁移。
4. 智能平仓可卖单防重。

## 7.6 `core/trader`

### 7.6.1 `rateLimiter`

1. 30 秒窗口 ≤30 次。
2. 相邻调用间隔 ≥30ms。
3. 并发调用串行化。

### 7.6.2 `orderExecutor`

1. 买入量按金额+lotSize 计算。
2. 卖出量不超过可用持仓。
3. 卖单合并：`REPLACE`/`CANCEL_AND_SUBMIT`/`SUBMIT`/`SKIP`。
4. 改单限制遵守状态与类型规则。

### 7.6.3 `orderMonitor`

1. Filled/PartialFilled/Canceled/Rejected 事件链。
2. 买入超时只撤单。
3. 卖出超时撤单后转市价单。
4. 门禁关闭阻断超时转市价单二次提交。
5. 成交后刷新标记与待刷新符号收集。

## 7.7 `core/doomsdayProtection`

1. 收盘前 15 分钟拒买与撤买单。
2. 收盘前 5 分钟清仓。
3. 正常日/半日市时间窗差异。

## 7.8 `services/quoteClient`

1. 订阅后初始化缓存与静态信息缓存。
2. 未订阅 symbol 调用 `getQuotes` 抛错。
3. 订阅但无推送返回 null 分支。
4. 退订后缓存清理。
5. K线订阅去重。
6. 交易日缓存 TTL 与回源。
7. 运行时重置订阅与缓存 `resetRuntimeSubscriptionsAndCaches`。

## 7.9 `services/marketMonitor`

1. 价格变化阈值。
2. 指标变化阈值（EMA/RSI/PSY/MFI/KDJ/MACD）。
3. 对象池回收/替换正确性。
4. 距回收价展示信息格式正确。

## 7.10 `services/monitorContext`

1. seat 初始装配与 quote 注入。
2. RSI/EMA/PSY 周期提取默认值与组合逻辑。

## 7.11 `services/liquidationCooldown` + `tradeLogHydrator`

1. 冷却模式：minutes/half-day/one-day。
2. 冷却剩余时长计算与过期清理。
3. 启动日志回填仅恢复“席位相关 + 保护性清仓 + 最新记录”。
4. 日志损坏/缺失容错。

## 7.12 `services/cleanup`

1. 退出时 stopAndDrain 顺序。
2. delayed verifier 销毁。
3. indicator cache 清理。
4. monitor snapshot 释放。

## 7.13 `main/processMonitor`

1. `seatSync`：席位变化清理队列与触发 seat refresh。
2. `riskTasks`：风险任务调度条件。
3. `autoSymbolTasks`：自动寻标任务调度条件。
4. `signalPipeline`：分流规则与席位校验。

## 7.14 `main/asyncProgram`

1. `monitorTaskQueue` 去重替换策略。
2. `monitorTaskProcessor` 五类任务分发与状态回调。
3. handlers 的快照校验、刷新门禁协作、失败恢复。
4. `buyProcessor` 与 `sellProcessor` 的门禁、席位、执行路径。
5. `postTradeRefresher` 合并刷新与重试逻辑。
6. `orderMonitorWorker` 最新覆盖执行策略。

## 7.15 `main/lifecycle`

1. 午夜清理 6 域顺序。
2. 开盘重建流程完整性。
3. 重建失败指数退避与门禁策略。
4. 跨日后关键状态重置。

---

## 8. 关键端到端场景集

### 8.1 买入全链路

1. 指标触发买入信号。
2. 立即/延迟两条路径。
3. 风控通过后下单。
4. 成交后刷新账户/持仓/浮亏。

### 8.2 卖出全链路

1. 智能平仓（全卖/部分卖/HOLD）三路径。
2. 卖出超时转市价单路径。
3. 待成交防重与关联买入订单释放。

### 8.3 保护性清仓全链路

1. 浮亏触发清仓。
2. 距回收价触发清仓（静态模式）。
3. 清仓后冷却阻断买入。

### 8.4 自动寻标/换标全链路

1. 空席位寻标。
2. 距回收价越界触发换标。
3. 预寻标、日内抑制、失败冻结。
4. 版本号阻断旧信号与旧任务。

### 8.5 生命周期全链路

1. 日内 -> 收盘 -> 午夜清理 -> 开盘重建。
2. 重建失败重试与恢复。
3. 重建后运行状态一致性。

### 8.6 并发/混沌全链路

1. 多监控标的并发。
2. API 短暂失败后恢复。
3. WebSocket 推送乱序与重复事件。

---

## 9. 子代理协同分工（14 Agent）

| Agent | 负责范围 | 关键交付物 | 依赖 |
|---|---|---|---|
| Agent-1 | Mock 基础设施总控 | `mock/longport/*`, `mock/factories/*`, 合同测试 | 无 |
| Agent-2 | 信号策略+延迟验证 | `tests/core/strategy/*`, `tests/main/asyncProgram/delayedSignalVerifier/*` | Agent-1 |
| Agent-3 | 买入风控流水线 | `tests/core/signalProcessor/riskCheckPipeline*`, `tests/core/riskController/*` | Agent-1 |
| Agent-4 | 卖出策略+订单记录 | `tests/core/signalProcessor/*sell*`, `tests/core/orderRecorder/*` | Agent-1 |
| Agent-5 | 下单执行+限流 | `tests/core/trader/orderExecutor*`, `tests/core/trader/rateLimiter*` | Agent-1 |
| Agent-6 | 订单监控+超时转市价 | `tests/core/trader/orderMonitor*`, `tests/main/asyncProgram/orderMonitorWorker/*` | Agent-1 |
| Agent-7 | processMonitor 调度 | `tests/main/processMonitor/seatSync*`, `riskTasks*`, `autoSymbolTasks*` | Agent-1 |
| Agent-8 | monitorTaskQueue/Processor | `tests/main/asyncProgram/monitorTaskQueue/*`, `monitorTaskProcessor/*` | Agent-1 |
| Agent-9 | postTradeRefresher | `tests/main/asyncProgram/postTradeRefresher/*` | Agent-1 |
| Agent-10 | 服务层模块 | `tests/services/quoteClient/*`, `marketMonitor/*`, `monitorContext/*`, `cleanup/*` | Agent-1 |
| Agent-11 | 自动寻标/换标状态机 | `tests/services/autoSymbol*/*`, `tests/integration/auto-symbol-switch*` | Agent-1, Agent-7 |
| Agent-12 | 生命周期 | `tests/main/lifecycle/*`, `tests/integration/lifecycle-crossday*` | Agent-1 |
| Agent-13 | 端到端整合 | `tests/integration/*` | Agent-2~12 |
| Agent-14 | 回归与混沌 | `tests/regression/*`, `tests/chaos/*` | Agent-13 |

---

## 10. 实施阶段与里程碑

### Phase-0 方案冻结（当前）

1. 固化规则优先级（源码优先）。
2. 固化不改造注入策略（默认不改 src）。
3. 固化 14 Agent 并行拆分。

### Phase-1 Mock 合同层（3-4 天）

1. 完成 `mock/` 基础设施。
2. 完成 Quote/Trade/Decimal 合同测试。
3. 提供场景驱动器。

### Phase-2 业务规则层（5-7 天）

1. Core 与 Services 并行落地。
2. 每条规则包含正向+拒绝+边界+异常。

### Phase-3 协同流程层（4-6 天）

1. main/asyncProgram/processMonitor/lifecycle。
2. 验证门禁、队列、缓存、版本号协同。

### Phase-4 端到端+混沌（4-6 天）

1. 日内和跨日端到端场景。
2. 异常恢复与并发稳定性。
3. 消除 flaky 用例。

### 里程碑验收

| 里程碑 | 验收条件 |
|---|---|
| M1 | Mock 合同测试全部通过 |
| M2 | 关键业务规则测试通过（风险+订单+换标） |
| M3 | 端到端全链路通过 |
| M4 | 回归与混沌连续3轮稳定通过 |

---

## 11. 覆盖率与质量门槛

### 11.1 覆盖率门槛

| 范围 | 行覆盖率 | 分支覆盖率 |
|---|---:|---:|
| 全项目 | >= 85% | >= 80% |
| `core/signalProcessor` | >= 95% | >= 92% |
| `core/riskController` | >= 95% | >= 92% |
| `core/trader` | >= 92% | >= 88% |
| `main/asyncProgram` | >= 90% | >= 85% |

### 11.2 规则覆盖门槛（必须100%）

1. 买入风险流水线全步骤。
2. `_markBuyAttempt` 预占时间槽。
3. 卖出超时转市价与不可改单限制。
4. 自动寻标失败冻结与日内抑制。
5. 席位版本号阻断旧信号/旧任务。
6. 跨日清理与开盘重建。

### 11.3 稳定性门槛

1. 全量测试连续 3 次通过。
2. 禁止真实网络调用 LongPort。
3. 禁止依赖真实时间漂移。

---

## 12. 风险与应对

| 风险 | 影响 | 应对策略 |
|---|---|---|
| Mock 与 SDK 合同偏差 | 误报/漏报 | 先做 `tests/mock-contract`，逐项对齐 reference |
| 时间场景 flaky | CI 不稳定 | 统一 clock/scheduler，消除裸定时依赖 |
| 生命周期与换标状态复杂 | 覆盖不足 | 采用状态机转移表驱动用例 |
| 无改造注入限制导致可测性不足 | 场景构造受限 | 先用 black-box 场景法；若必要再单点申请改造确认 |

---

## 13. 不改造注入策略（落地细则）

### 13.1 默认策略

1. 优先使用现有工厂函数与依赖注入入口测试，不修改 `src/`。
2. 优先采用“黑盒场景驱动 + mock 依赖替换”方式覆盖。

### 13.2 允许触发确认的例外

仅在以下条件同时满足时，才可提“最小改造申请”：

1. 该规则属于 P0 关键规则。
2. 通过 black-box 无法稳定构造。
3. 改造范围可限制在单个模块且不影响生产行为。

触发后必须先向你确认，未确认不改造。

---

## 14. 交付物清单（本方案对应）

1. 根目录 `mock/` 完整实现。
2. `tests/` 全分层测试实现。
3. 覆盖率与稳定性报告。
4. 规则追踪矩阵：业务规则 -> 测试文件 -> 用例 ID。
5. 差异说明：业务文档与源码冲突项列表。

---

## 15. 规则追踪矩阵模板（执行时使用）

| Rule ID | 规则描述 | 源码位置 | 测试文件 | 场景 ID |
|---|---|---|---|---|
| BR-RISK-001 | 风险检查冷却10秒 | `src/core/signalProcessor/riskCheckPipeline.ts` | `tests/core/signalProcessor/riskCheckPipeline.test.ts` | `SCN-RISK-COOLDOWN-01` |
| BR-RISK-002 | 频率通过后预占时间槽 | `src/core/signalProcessor/riskCheckPipeline.ts` | `tests/core/signalProcessor/riskCheckPipeline.test.ts` | `SCN-RISK-MARK-01` |
| BR-ORDER-001 | 卖出超时转市价单 | `src/core/trader/orderMonitor.ts` | `tests/core/trader/orderMonitor.timeout.test.ts` | `SCN-ORDER-TO-MO-01` |
| BR-AUTO-001 | 寻标失败冻结 | `src/services/autoSymbolManager/*` | `tests/services/autoSymbol/*` | `SCN-AUTO-FREEZE-01` |
| BR-LIFE-001 | 午夜清理与开盘重建 | `src/main/lifecycle/*` | `tests/main/lifecycle/*` | `SCN-LIFE-CROSSDAY-01` |

执行时按此模板持续补全至全量规则覆盖。

---

## 16. 运行命令（统一）

```bash
# 全量测试
bun test

# 分层运行
bun test tests/mock-contract
bun test tests/core
bun test tests/services
bun test tests/main
bun test tests/integration
bun test tests/regression
bun test tests/chaos

# 覆盖率（如采用 bun 覆盖）
bun test --coverage
```

---

## 17. 结论

本合并版文档即唯一执行基线，已满足以下要求：

1. 足够详细且完整。
2. 全链路业务逻辑导向，而非仅单元测试。
3. 明确 `mock/` API 仿真与场景驱动设计。
4. 明确 14 子代理并行协同。
5. 固化你确认的四项决策：
- 尽量不注入改造
- 全局覆盖率 85
- 多子代理并行
- 源码优先
