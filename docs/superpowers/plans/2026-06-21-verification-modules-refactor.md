# Verification Modules Refactor Implementation Plan

> **执行要求：** 实施本计划时必须使用 `typescript-project-specifications` 与 `core-program-business-logic` skill。按任务顺序执行，使用复选框记录进度。除非用户明确要求，否则不创建 Git commit。

**Goal:** 按 `docs/plans/2026-06/2026-06-17-verification-modules-refactor-plan.md` 完成趋势验证与多档订单簿验证的原子重构：Strategy 只生成候选信号，Signal Pipeline 成为 `none / trend / orderBook` 唯一分流 owner，`signalVerificationRuntime` 成为 pending verification 与 verified delivery 的唯一生命周期 owner，`marketDataSubscriptionRuntime` 成为 Quote / Candlestick / Depth / Brokers mutation 与服务端事实确认的唯一串行 owner。

**Architecture:** 使用事件驱动链路和 fail-fast 边界。纯算法模块不拥有 timer、订阅和业务队列；共享 runtime 负责 generation、pending、drain、delivery 和 fatal error。Depth 与 Brokers 独立进入有界缓存，不做跨流配对。配置、静态 board 准入、订阅 committed truth 和非法 payload 分别在各自信任边界失败，不提供旧配置兼容、数据降档、指标跳过或代理盘口 fallback。

**Tech Stack:** Bun、TypeScript strict mode、`bun:test`、Longbridge Node SDK `4.2.1`、现有 factory-function 与依赖注入架构。

---

## 0. 执行边界

### 0.1 规范来源

实现时以下文件共同构成当前规范，冲突时按从上到下的顺序处理：

1. `CLAUDE.md`
2. `.codex/skills/typescript-project-specifications/SKILL.md`
3. `.codex/skills/core-program-business-logic/SKILL.md`
4. `docs/plans/2026-06/2026-06-17-verification-modules-refactor-plan.md`
5. 本执行计划

本执行计划负责把设计文档拆成可执行步骤，不得改变设计文档中的业务语义、指标公式、配置矩阵、错误分类和生命周期顺序。

### 0.2 非目标

- 不证明订单簿指标具有稳定 alpha。
- 不新增 Trade 推送依赖。
- 不构造主动买卖量、CVD、OFI、MLOFI、Observed Book Delta 或成交吸收代理。
- 不用 L1、五档、旧完整快照、tradingSymbol、ETF、成分股或其他代理数据补齐 monitorSymbol 的十档事实。
- 不为旧 BUY/SELL verification 环境变量保留兼容解析。
- 不建立独立 `orderBookSubscriptionRuntime`。
- 不在 verifier 内建立请求重试或轮询等待。
- 不把中间任务视为可部署兼容阶段；最终集成完成前旧 owner 与新 owner 不得同时接入生产链路。

### 0.3 当前链路证据

实施前应确认当前链路仍为：

```text
QuoteContext Candlestick push
-> quoteClient.onCandlestickUpdated
-> businessEventProgram per-monitor latest-only route
-> indicatorPipeline
-> indicatorCache.push
-> strategy.generateSignals
-> immediateSignals / delayedSignals
-> signalPipeline
-> monitorContext.delayedSignalVerifier
-> registerDelayedSignalHandlers
-> VERIFIED_BUY / VERIFIED_SELL queue
```

当前订阅链路存在两个 owner：

```text
loadTradingDayRuntimeSnapshot
-> resetRuntimeSubscriptionsAndCaches
-> subscribeSymbols
-> subscribeCandlesticks

quoteSubscriptionRuntime
-> subscribeSymbols / unsubscribeSymbols
```

本重构结束后，上述两条链路必须分别收敛为唯一 verification owner 和唯一 market-data mutation owner。

### 0.4 原子切换要求

以下两项必须在各自任务内完成全量迁移，不能留下兼容委托：

1. `delayedSignalVerifier + registerDelayedSignalHandlers` 切换为共享 `signalVerificationRuntime`。
2. `quoteSubscriptionRuntime + loadTradingDayRuntimeSnapshot/CacheDomain/cleanup` 的低层 mutation 切换为 `marketDataSubscriptionRuntime`。

---

## 1. File map

### Add

- `src/types/runtimePrimitives.ts`
- `src/utils/time/runtimeClock.ts`
- `src/config/trading/verificationSchema.ts`
- `src/main/asyncProgram/trendSignalVerifier/index.ts`
- `src/main/asyncProgram/trendSignalVerifier/types.ts`
- `src/main/asyncProgram/trendSignalVerifier/utils.ts`
- `src/main/asyncProgram/orderBookSignalVerifier/index.ts`
- `src/main/asyncProgram/orderBookSignalVerifier/types.ts`
- `src/main/asyncProgram/orderBookSignalVerifier/utils.ts`
- `src/main/signalVerificationRuntime/index.ts`
- `src/main/signalVerificationRuntime/types.ts`
- `src/main/marketDataSubscriptionRuntime/index.ts`
- `src/main/marketDataSubscriptionRuntime/types.ts`
- `src/main/orderBookCache/index.ts`
- `src/main/orderBookCache/types.ts`
- `src/main/orderBookCache/utils.ts`
- `tests/types/runtimePrimitives.test.ts`
- `tests/config/verificationConfig.business.test.ts`
- `tests/main/asyncProgram/trendSignalVerifier/business.test.ts`
- `tests/main/asyncProgram/orderBookSignalVerifier/business.test.ts`
- `tests/main/signalVerificationRuntime/business.test.ts`
- `tests/main/marketDataSubscriptionRuntime/business.test.ts`
- `tests/main/orderBookCache/business.test.ts`

### Rename or replace

- `src/main/asyncProgram/delayedSignalVerifier/**` → `src/main/asyncProgram/trendSignalVerifier/**`
- `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts` → `tests/main/asyncProgram/trendSignalVerifier/business.test.ts`
- `src/main/quoteSubscriptionRuntime/**` → `src/main/marketDataSubscriptionRuntime/**`
- `tests/main/quoteSubscriptionRuntime/quoteSubscriptionRuntime.business.test.ts` → `tests/main/marketDataSubscriptionRuntime/business.test.ts`

### Delete

- `src/app/wiring/registerDelayedSignalHandlers.ts`
- `tests/app/wiring/registerDelayedSignalHandlers.business.test.ts`

### Major modify

- `src/constants/index.ts`
- `src/types/config.ts`
- `src/types/signal.ts`
- `src/types/indicatorProfile.ts`
- `src/types/monitorContextPorts.ts`
- `src/types/services.ts`
- `src/types/state.ts`
- `src/config/utils.ts`
- `src/config/trading/utils.ts`
- `src/config/validator/index.ts`
- `src/config/validator/utils.ts`
- `src/core/strategy/index.ts`
- `src/core/strategy/types.ts`
- `src/core/strategy/utils.ts`
- `src/services/indicators/profile/index.ts`
- `src/services/quoteClient/index.ts`
- `src/services/quoteClient/types.ts`
- `mock/longbridge/quoteContextMock.ts`
- `src/main/businessEventProgram/index.ts`
- `src/main/businessEventProgram/signalPipeline.ts`
- `src/main/businessEventProgram/types.ts`
- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
- `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
- `src/main/lifecycle/cacheDomains/marketDataDomain.ts`
- `src/main/lifecycle/cacheDomains/types.ts`
- `src/main/timeWakeupEvaluationProgram/index.ts`
- `src/main/timeWakeupEvaluationProgram/types.ts`
- `src/main/seatRuntimeCleanupDispatcher/index.ts`
- `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts`
- `src/main/seatRuntimeCleanupDispatcher/types.ts`
- `src/app/runtime/createPreGateRuntime.ts`
- `src/app/runtime/createPostGateRuntime.ts`
- `src/app/runtime/types.ts`
- `src/app/context/createMonitorContexts.ts`
- `src/app/lifecycle/createLifecycleRuntime.ts`
- `src/app/runApp.ts`
- `src/app/shutdown/createCleanup.ts`
- `src/app/types.ts`
- `tests/helpers/testDoubles.ts`
- 受完整对象字面量和 wiring 影响的 `tests/app/**`、`tests/main/**`、`tests/integration/**`
- `.env.example`
- `README.md`
- `.codex/skills/core-program-business-logic/SKILL.md`

---

## 2. Task 1: 锁定现有趋势验证与生命周期语义

**Files:**

- Modify: `tests/core/strategy/index.test.ts`
- Modify: `tests/main/businessEventProgram/signalPipeline.business.test.ts`
- Modify: `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
- Modify: `tests/app/wiring/registerDelayedSignalHandlers.business.test.ts`
- Modify: `tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts`
- Modify: `tests/app/shutdown/createCleanup.business.test.ts`

- [ ] **Step 1: 补齐迁移前 characterization tests**

在不改变生产代码的前提下，明确锁定：

- trend 的基准时间仍为候选 detected 时间加 action delay。
- T0 / T0+5s / T0+10s 使用 `IndicatorCache.getClosest` 当前最近样本语义。
- BUYCALL / SELLPUT 普通指标上涨，BUYPUT / SELLCALL 普通指标下跌。
- ADX 对四动作均要求后续值低于初始值。
- 开盘保护阻止新候选产生，不取消已 pending 的验证回流。
- 末日接管取消 pending 并阻止回流。
- verified 回流重新校验 lifecycle、doomsday、席位状态、席位版本和标的一致性。
- shutdown 当前需要清理 timer、回调和 indicator cache；这些断言后续将迁移到共享 runtime。

- [ ] **Step 2: 运行迁移前 focused tests**

Run:

```bash
bun test tests/core/strategy/index.test.ts tests/main/businessEventProgram/signalPipeline.business.test.ts tests/main/asyncProgram/delayedSignalVerifier/business.test.ts tests/app/wiring/registerDelayedSignalHandlers.business.test.ts tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts tests/app/shutdown/createCleanup.business.test.ts
```

Expected: PASS。若现状与设计文档不一致，先把差异记录为迁移约束，不在本任务修改业务行为。

---

## 3. Task 2: 建立品牌类型、时间运算与可注入时钟

**Files:**

- Add: `src/types/runtimePrimitives.ts`
- Add: `src/utils/time/runtimeClock.ts`
- Modify: `src/utils/time/index.ts`
- Modify: `src/utils/time/types.ts`
- Add: `tests/types/runtimePrimitives.test.ts`
- Modify: `tests/utils/time.business.test.ts`

- [ ] **Step 1: 写品牌构造和时间运算失败测试**

覆盖：

- epoch、monotonic、duration 只能由显式工厂创建。
- duration 拒绝非有限值和负值；Schema 使用的正 duration 额外拒绝零。
- `addEpochDuration`、`addMonotonicDuration`、`scaleDuration`、`elapsedMonotonic` 不混用单位。
- `scaleDuration` 拒绝非有限或负 ratio。
- clock 的 `capture()` 在一次调用中同时返回 epoch 和 monotonic。
- 测试时可注入确定性的 epoch / monotonic source。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
bun test tests/types/runtimePrimitives.test.ts tests/utils/time.business.test.ts
```

Expected: FAIL，因为品牌类型、构造器和 runtime clock 尚不存在。

- [ ] **Step 3: 定义唯一公共品牌源**

在 `src/types/runtimePrimitives.ts` 定义并逐项添加独立块注释：

```ts
export type Brand<T, Name extends string> = T & {
  readonly __brand: Name;
};

export type EpochTimestampMs = Brand<number, 'EpochTimestampMs'>;
export type MonotonicTimestampMs = Brand<number, 'MonotonicTimestampMs'>;
export type DurationMs = Brand<number, 'DurationMs'>;
export type ArrivalOrdinal = Brand<number, 'ArrivalOrdinal'>;
export type MarketDataGeneration = Brand<number, 'MarketDataGeneration'>;
export type AdmittedHkEquitySymbol = Brand<string, 'AdmittedHkEquitySymbol'>;
export type SeatIdentity = Brand<string, 'SeatIdentity'>;
```

不得在其他模块重复声明这些品牌，也不得 re-export。

- [ ] **Step 4: 实现边界构造器和纯时间函数**

在 `src/utils/time/runtimeClock.ts` 创建 `RuntimeClock` 行为契约和工厂。生产 monotonic source 使用 `performance.now()`，epoch source 使用 `Date.now()`；测试通过依赖注入替换。

在 `src/utils/time/index.ts` 增加时间品牌构造和运算函数。禁止调用方通过散落的 `as EpochTimestampMs` 构造品牌值。

- [ ] **Step 5: 运行 GREEN**

Run:

```bash
bun test tests/types/runtimePrimitives.test.ts tests/utils/time.business.test.ts
```

Expected: PASS。

---

## 4. Task 3: 原子替换动作级验证配置与 Schema

**Files:**

- Add: `src/config/trading/verificationSchema.ts`
- Modify: `src/types/config.ts`
- Modify: `src/config/utils.ts`
- Modify: `src/config/trading/utils.ts`
- Modify: `src/config/trading/types.ts`
- Modify: `src/config/validator/index.ts`
- Modify: `src/config/validator/utils.ts`
- Modify: `src/constants/index.ts`
- Add: `tests/config/verificationConfig.business.test.ts`
- Modify: `tests/config/tradingConfig.failfast.business.test.ts`
- Modify: `tests/utils/signalConfigParser.business.test.ts`

- [ ] **Step 1: 写完整配置矩阵测试**

至少覆盖：

- 四动作模式独立解析。
- `SELLCALL / SELLPUT = ORDER_BOOK` fail-fast。
- `NONE` 带任一 action trend 残留键 fail-fast。
- `TREND` 缺失/非正 delay、空指标、不支持指标 fail-fast。
- `ORDER_BOOK` 带 action trend 残留键 fail-fast。
- 任一买入动作使用 `ORDER_BOOK` 时 monitor JSON 必须存在。
- 两个买入动作均非 `ORDER_BOOK` 时 monitor JSON 禁止存在。
- 旧 BUY/SELL verification 键只要存在就 fail-fast。
- JSON 缺字段、额外非法结构、重复 confirmation kind、非法阈值全部 fail-fast。
- BUYCALL 与 BUYPUT 引用同一份 validated order-book config。
- branded validated config 只由 Schema 工厂产生。

- [ ] **Step 2: 运行配置测试确认 RED**

Run:

```bash
bun test tests/config/verificationConfig.business.test.ts tests/config/tradingConfig.failfast.business.test.ts tests/utils/signalConfigParser.business.test.ts
```

Expected: FAIL，因为当前仍使用 buy/sell 旧配置形状。

- [ ] **Step 3: 替换配置类型**

删除：

```text
SingleVerificationConfig
VerificationConfig.buy
VerificationConfig.sell
```

新增设计文档第 6.2 节定义的：

```text
NoVerificationConfig
ValidatedTrendVerificationConfig
ValidatedOrderBookVerificationConfig
BuyActionVerificationMode
SellActionVerificationMode
MonitorVerificationConfig
OrderBookVerificationConfig
ConfirmationConfig
```

`MonitorConfig.verificationConfig` 保留字段名，但值改为新的 `MonitorVerificationConfig`；不要引入旧形状 alias。

- [ ] **Step 4: 实现单一 JSON Schema 边界**

`verificationSchema.ts` 负责：

- `JSON.parse` 的 unknown 输入收窄。
- 所有数字的有限性、范围和交叉字段校验。
- confirmation 判别联合和 kind 去重。
- `DurationMs` 构造。
- 输出 branded validated config。

不要在 `types.ts` 放 Schema、常量或函数。不要用 `any` 或宽断言跳过 unknown 校验。

- [ ] **Step 5: 替换环境变量解析**

读取：

```text
VERIFICATION_MODE_BUYCALL_N
VERIFICATION_MODE_BUYPUT_N
VERIFICATION_MODE_SELLCALL_N
VERIFICATION_MODE_SELLPUT_N
TREND_VERIFICATION_DELAY_SECONDS_<ACTION>_N
TREND_VERIFICATION_INDICATORS_<ACTION>_N
ORDER_BOOK_VERIFICATION_CONFIG_N
```

删除旧键读取和默认兼容路径。配置错误直接抛出 `ConfigValidationError`。

同时删除不再允许的旧 helper：

```text
parseVerificationDelay
parseVerificationIndicators
```

不得保留旧 helper 的截断、跳过非法指标或默认降级语义。

- [ ] **Step 6: 增加固定常量**

在 `src/constants/index.ts` 定义：

```text
ORDER_BOOK_DEPTH_LEVELS = 10
ORDER_BOOK_MAX_BROKER_POSITION = 40
ORDER_BOOK_CACHE_MAX_DEPTH_OBSERVATIONS_PER_SYMBOL
ORDER_BOOK_CACHE_MAX_BROKER_OBSERVATIONS_PER_SYMBOL
```

容量值先按设计允许的最大窗口、压测 burst 和安全余量确定；不可从 monitor JSON 读取。

- [ ] **Step 7: 运行配置 GREEN**

Run:

```bash
bun test tests/config/verificationConfig.business.test.ts tests/config/tradingConfig.failfast.business.test.ts tests/utils/signalConfigParser.business.test.ts
```

Expected: PASS。

---

## 5. Task 4: 重编译指标画像与行情 requirements

**Files:**

- Modify: `src/types/indicatorProfile.ts`
- Modify: `src/services/indicators/profile/index.ts`
- Modify: `src/services/indicators/profile/types.ts`
- Modify: `src/app/context/createMonitorContexts.ts`
- Modify: `src/app/runtime/createPostGateRuntime.ts`
- Modify: `tests/services/indicators/profile/index.business.test.ts`
- Modify: `tests/app/context/createMonitorContexts.business.test.ts`
- Modify: `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts`

- [ ] **Step 1: 写画像编译失败测试**

覆盖：

- 只有 `mode=trend` 的动作进入验证指标画像。
- 画像改为 `trendVerificationIndicatorsByAction`，四动作分别保存。
- `ORDER_BOOK` 和 `NONE` 动作不增加技术指标计算需求。
- 混合 trend + orderBook 时 indicator cache retention 只取 trend 最大 delay。
- 全部非 trend 时 retention 只保留基础安全窗口，不受 orderBook window 影响。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
bun test tests/services/indicators/profile/index.business.test.ts tests/app/context/createMonitorContexts.business.test.ts tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts
```

Expected: FAIL，因为当前画像仍是 buy/sell 两侧结构。

- [ ] **Step 3: 替换画像结构**

删除 `verificationIndicatorsBySide`，新增：

```ts
readonly trendVerificationIndicatorsByAction: Readonly<{
  BUYCALL: ReadonlyArray<VerificationIndicator>;
  BUYPUT: ReadonlyArray<VerificationIndicator>;
  SELLCALL: ReadonlyArray<VerificationIndicator>;
  SELLPUT: ReadonlyArray<VerificationIndicator>;
}>;
```

同步更新注释，删除对 delayed verifier 和 buy/sell 配置的旧描述。

- [ ] **Step 4: 修正 retention owner**

`createPostGateRuntime` 只从所有 `mode=trend` action 的 validated delay 计算 `indicatorCache.retentionWindowMs`。

- [ ] **Step 5: 运行 GREEN**

Run:

```bash
bun test tests/services/indicators/profile/index.business.test.ts tests/app/context/createMonitorContexts.business.test.ts tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts
```

Expected: PASS。

---

## 6. Task 5: 锁定 Strategy/Pipeline 原子切换边界

**Files:**

- Inspect: `src/types/signal.ts`
- Inspect: `src/core/strategy/types.ts`
- Inspect: `src/core/strategy/index.ts`
- Inspect: `src/core/strategy/utils.ts`
- Inspect: `src/main/businessEventProgram/signalPipeline.ts`
- Inspect: `src/main/businessEventProgram/types.ts`
- Inspect: `src/main/asyncProgram/sellProcessor/index.ts`
- Inspect: corresponding tests

此任务只确认原子边界，不修改生产代码。Strategy 公共契约切换必须与 Task 12 的 Pipeline 分流在同一 change set 完成，否则会出现编译中断或双重分类 owner。

- [ ] **Step 1: 记录必须同任务删除的符号**

```text
TradingSignalStrategyConfig.verificationConfig
TradingSignalGenerationResult.immediateSignals
TradingSignalGenerationResult.delayedSignals
SignalTypeCategory
SignalWithCategory
needsDelayedVerification
calculateVerificationTime
signalTypeMap
pushSignalToCorrectArray
DEFAULT_VERIFICATION_CONFIG
```

同时记录容易遗漏的下游：

```text
Signal.indicators1
sellProcessor 对 indicators1 的克隆
sellProcessor indicators1 深拷贝测试
Strategy generateSignals 的 indicatorProfile 参数
```

- [ ] **Step 2: 记录目标契约**

```text
Strategy.generateSignals -> ReadonlyArray<CandidateSignal>
Pipeline -> detected clock capture + Signal 构造 + seat binding + mode resolve
trend -> Pipeline 提取初始指标并登记 request
orderBook -> Pipeline 构造 monitor order-book request
none -> Pipeline 直接入 IMMEDIATE queue
```

- [ ] **Step 3: 确认不在本任务引入 adapter**

不得新增“旧 immediate/delayed 输出转 candidate”或“candidate 再转旧分类”的临时适配器。实际代码与测试切换统一在 Task 12 完成。

---

## 7. Task 6: 抽出纯趋势验证模块

**Files:**

- Add: `src/main/asyncProgram/trendSignalVerifier/index.ts`
- Add: `src/main/asyncProgram/trendSignalVerifier/types.ts`
- Add: `src/main/asyncProgram/trendSignalVerifier/utils.ts`
- Rename/Test: `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts` → `tests/main/asyncProgram/trendSignalVerifier/business.test.ts`

- [ ] **Step 1: 把旧测试改写为纯算法契约**

测试不再创建 timer 或注册 callback，直接传入 `TrendVerificationRequest` 和 `IndicatorCache`，覆盖：

- T0 / T0+5s / T0+10s。
- 最近样本读取语义。
- 缺失、invalid 和普通 rejected 的区分。
- 四动作趋势方向。
- ADX 特殊规则。
- 全部指标全部时间点必须通过。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
bun test tests/main/asyncProgram/trendSignalVerifier/business.test.ts
```

Expected: FAIL，因为新模块尚不存在。

- [ ] **Step 3: 实现纯 `trendSignalVerifier`**

要求：

- 不调用 `setTimeout`。
- 不保存 pending Map。
- 不拥有 callback。
- 不写任务队列。
- 不读取 verification config。
- 输入已包含 validated delay 派生出的 `trendBaseEpochMs`、初始指标和 action。
- 输出统一 `VerificationResult` 的 `verified / rejected / data-incomplete` 子集；不产生 lifecycle `cancelled`。

- [ ] **Step 4: 运行 GREEN**

Run:

```bash
bun test tests/main/asyncProgram/trendSignalVerifier/business.test.ts
```

Expected: PASS。

此时旧 `delayedSignalVerifier` 生产模块仍暂时存在，但不得改接新链路；在 Task 8 原子删除。

---

## 8. Task 7: 扩展 quoteClient SDK 边界与 mock contract

**Files:**

- Modify: `src/services/quoteClient/index.ts`
- Modify: `src/services/quoteClient/types.ts`
- Modify: `src/types/services.ts`
- Modify: `src/app/runtime/createPreGateRuntime.ts`
- Modify: `src/app/runtime/types.ts`
- Modify: `src/app/types.ts`
- Modify: `mock/longbridge/quoteContextMock.ts`
- Modify: `mock/longbridge/types.ts`
- Modify: `tests/services/quoteClient/business.test.ts`
- Modify: `tests/mock-contract/quoteContext.contract.test.ts`
- Modify: `tests/app/runtime/createPreGateRuntime.minimalGate.test.ts`

- [ ] **Step 1: 写 SDK adapter 失败测试**

覆盖锁定 SDK `4.2.1` 的：

- `staticInfo().board`
- `quoteLevel()`
- `quotePackageDetails()`
- `subscribe()/unsubscribe()` 的 Quote / Depth / Brokers
- `subscriptions()`
- `realtimeDepth()`
- `realtimeBrokers()`
- `setOnDepth()`
- `setOnBrokers()`
- Candlestick subscribe/unsubscribe
- callback error 进入统一 fatal sink
- `301603` 与 `301604` 使用结构化 code 分类
- 暂态 mutation 调用不在 quoteClient 内重试，错误 attempts 固定为 1

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
bun test tests/services/quoteClient/business.test.ts tests/mock-contract/quoteContext.contract.test.ts tests/app/runtime/createPreGateRuntime.minimalGate.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 将工厂改为显式 capability bundle**

把 `createMarketDataClient` 改为创建一个 quote-client bundle：

```ts
type QuoteClientBundle = Readonly<{
  marketDataClient: MarketDataClient;
  mutationPort: QuoteContextMutationPort;
}>;
```

`MarketDataClient` 只保留业务读取和标准化事件：

```text
getQuoteContext
getQuotes
getCandlestickSnapshot
onQuoteUpdated
onCandlestickUpdated
isTradingDay
getTradingDays
```

删除其公开的：

```text
subscribeSymbols
unsubscribeSymbols
subscribeCandlesticks
resetRuntimeSubscriptionsAndCaches
```

低层方法全部进入 `QuoteContextMutationPort`，且该端口只由 app 装配层传给 `marketDataSubscriptionRuntime`。

- [ ] **Step 4: 实现 callback fan-out**

quoteClient 只注册一次 SDK Depth/Brokers callback，再向内部监听器集合 fan-out。回调事件保持原始 SDK 数据，标准化由 order-book 边界完成。

监听器异常或 SDK callback error 进入应用 fatal sink，不静默吞错。

- [ ] **Step 5: 更新 mock**

`quoteContextMock` 必须支持：

- subtype 与 candlestick committed truth。
- subscriptions readback。
- Depth / Brokers realtime seed。
- Depth / Brokers push。
- 每种低层调用的确定性失败注入和调用记录。

- [ ] **Step 6: 运行 GREEN**

Run:

```bash
bun test tests/services/quoteClient/business.test.ts tests/mock-contract/quoteContext.contract.test.ts tests/app/runtime/createPreGateRuntime.minimalGate.test.ts
```

Expected: PASS。

---

## 9. Task 8: 原子切换唯一 MarketDataSubscriptionRuntime

**Files:**

- Add: `src/main/marketDataSubscriptionRuntime/index.ts`
- Add: `src/main/marketDataSubscriptionRuntime/types.ts`
- Delete after migration: `src/main/quoteSubscriptionRuntime/index.ts`
- Delete after migration: `src/main/quoteSubscriptionRuntime/types.ts`
- Rename/Rewrite: `tests/main/quoteSubscriptionRuntime/quoteSubscriptionRuntime.business.test.ts` → `tests/main/marketDataSubscriptionRuntime/business.test.ts`
- Modify: `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
- Modify: `src/main/lifecycle/cacheDomains/marketDataDomain.ts`
- Modify: `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
- Modify: `src/main/lifecycle/cacheDomains/types.ts`
- Modify: `src/main/timeWakeupEvaluationProgram/index.ts`
- Modify: `src/main/timeWakeupEvaluationProgram/types.ts`
- Modify: `src/main/monitorQuoteEventRuntime/**`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/**`
- Modify: `src/app/runtime/createPostGateRuntime.ts`
- Modify: `src/app/lifecycle/createLifecycleRuntime.ts`
- Modify: `src/app/runApp.ts`
- Modify: `src/app/shutdown/createCleanup.ts`
- Modify: `src/app/types.ts`
- Modify: `tests/helpers/testDoubles.ts`
- Modify: all affected wiring/lifecycle/integration tests

- [ ] **Step 1: 写状态机与事务失败测试**

覆盖：

- requirement identity 包含 owner、symbol、subtype 或 candlestick period/session。
- monitor base、seat、position、order 和 transient retain 合并。
- 所有 mutation 经过同一 Promise chain。
- mutation 前读取 subscriptions baseline。
- 部分成功只回滚 `after - baseline`。
- 原本已 committed 的 Depth 不因新增 Brokers 失败被退订。
- active 只在 desired 与 admitted 完全相等时成立。
- `subscriptions()` 缺事实进入 failed。
- stop 时先 generation 失效，再 drain callback/mutation，再退订并 readback。
- stop readback 失败保留 `failed + lastKnownFacts`。
- 未配置 brokerBreadth 时没有 Brokers requirement。
- Candlestick seed 和 subtype seed 属于同一 reconcile transaction。
- transient quote retain 在 active generation 内串行增删。

- [ ] **Step 2: 运行新 runtime 测试确认 RED**

Run:

```bash
bun test tests/main/marketDataSubscriptionRuntime/business.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 requirement-aware 状态机**

实现设计文档第 8.3 节状态：

```text
stopped
reconciling
active
stopping
failed
```

公开高层端口：

```text
resetAndReconcile(targetRequirements)
seedCurrentRealtimeState()
start()
stopAndDrain()
retainQuoteSymbols(...)
releaseRetain(...)
waitForAdmission(...)
getActiveGeneration()
getAdmittedHkEquitySymbol(...)
```

后四项是现有动态 quote retain 和 verification 构造所需的只读/高层能力，不暴露 SDK mutation。

- [ ] **Step 4: 在同一任务迁移全部调用方**

必须同时完成：

- `loadTradingDayRuntimeSnapshot` 不再调用 subscribe/unsubscribe/reset。
- 删除 `LoadTradingDayRuntimeSnapshotParams.resetRuntimeSubscriptions`；startup/open-rebuild 不再通过布尔参数决定低层 reset。
- `marketDataDomain` 只调用 `marketDataSubscriptionRuntime.stopAndDrain()` 或新的 lifecycle 高层方法。
- `signalRuntimeDomain` 不再启动/停止旧 quote owner。
- monitor quote、switch、seat refresh、post-trade consistency 和 doomsday 持仓刷新改用高层 quote retain/reconcile API。
- cleanup 不再直接 reset quoteClient。
- `PreGateRuntime` 保存 `marketDataClient + mutationPort`；mutationPort 只流向新 runtime。
- `LastState.allTradingSymbols` 不再作为 committed truth；若仍用于显示/业务投影，改为由 active reconciled snapshot 派生。

- [ ] **Step 5: 删除旧 owner**

删除：

```text
src/main/quoteSubscriptionRuntime/
tests/main/quoteSubscriptionRuntime/
QuoteSubscriptionRuntime
createQuoteSubscriptionRuntime
```

不得保留 alias、wrapper 或委托链。

- [ ] **Step 6: 运行原子迁移测试集**

Run:

```bash
bun test tests/main/marketDataSubscriptionRuntime/business.test.ts tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts tests/app/shutdown/createCleanup.business.test.ts tests/app/runApp.business.test.ts tests/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.business.test.ts tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts tests/main/asyncProgram/monitorTaskProcessor/business.test.ts
```

Expected: PASS。

- [ ] **Step 7: 低层 capability 残留 gate**

Run:

```bash
rg -n "subscribeSymbols|unsubscribeSymbols|subscribeCandlesticks|resetRuntimeSubscriptionsAndCaches|QuoteSubscriptionRuntime|quoteSubscriptionRuntime" src tests
```

Expected:

- 旧 owner 名称零残留。
- SDK mutation 只存在于 `quoteClient` 和 `marketDataSubscriptionRuntime` 的受控端口。
- 业务模块只出现高层 retain/reconcile 方法。

---

## 10. Task 9: 建立 Depth/Brokers 标准化与有界 OrderBookCache

**Files:**

- Add: `src/main/orderBookCache/index.ts`
- Add: `src/main/orderBookCache/types.ts`
- Add: `src/main/orderBookCache/utils.ts`
- Add: `tests/main/orderBookCache/business.test.ts`
- Modify: `src/constants/index.ts`

- [ ] **Step 1: 写标准化与缓存失败测试**

Depth 覆盖：

- 完整 1..10 双边生成 validated snapshot。
- 少于十档生成 sparse observation。
- position 重复/越界、price 非正或非有限、volume/orderNum 非安全非负整数进入 fatal。
- 聚合结果非有限进入 fatal。
- 旧 generation callback 在写缓存前拒绝。

Brokers 覆盖：

- 空数组、单侧短数组、position 不连续、brokerIds 空数组合法。
- position 重复/越界、broker ID 非正整数进入 fatal。
- broker ID 去重。

Cache 覆盖：

- Depth/Brokers 分流保存。
- baseline 只取 T0 前最近 observation。
- 最近 sparse 时不穿透到更旧 validated baseline。
- 窗口包含 sparse 时可查询。
- generation reset、symbol clear。
- 容量溢出写 marker，不静默覆盖后继续通过。
- 两 monitor 共享 symbol 时共用应用级容量。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
bun test tests/main/orderBookCache/business.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 定义 types**

按设计文档第 9、10 节定义：

```text
DepthPosition
ValidatedDepthLevel
TenDepthLevels
ValidatedTenLevelDepthSnapshot
ValidatedBrokerQueueEntry
ValidatedBrokerQueueSnapshot
DepthObservation = validated | sparse-market-state
OrderBookWindowReadResult
OverflowMarker
OrderBookCache
```

`types.ts` 不含 Schema、标准化函数或常量。

- [ ] **Step 4: 实现标准化工厂**

所有 SDK unknown 输入在 `utils.ts` 收窄。标准化函数是 branded snapshot 的唯一构造点。

非法 payload：

- 调用 fatal sink。
- 不写普通 observation。
- 不同时返回 data-incomplete。

- [ ] **Step 5: 实现缓存**

写入时预计算与方向无关的：

```text
midPrice
spreadBps
microprice
micropricePremiumBps
top10VolumeImbalance
top10OrderCountImbalance
bid/ask depth
total depth notional
broker breadth source sets
```

缓存只按 symbol、stream、generation 组织，不感知 LONG/SHORT。

- [ ] **Step 6: 运行 GREEN**

Run:

```bash
bun test tests/main/orderBookCache/business.test.ts
```

Expected: PASS。

---

## 11. Task 10: 实现纯 OrderBookSignalVerifier

**Files:**

- Add: `src/main/asyncProgram/orderBookSignalVerifier/index.ts`
- Add: `src/main/asyncProgram/orderBookSignalVerifier/types.ts`
- Add: `src/main/asyncProgram/orderBookSignalVerifier/utils.ts`
- Add: `tests/main/asyncProgram/orderBookSignalVerifier/business.test.ts`

- [ ] **Step 1: 写公式与性质测试**

覆盖设计文档第 11、12、13、14、15 节：

- imbalance 始终在 `[-1, 1]`。
- bid/ask 交换后符号反转。
- volume/order count 同比例缩放时 imbalance 不变。
- 分母为零时 undefined。
- 奇偶样本中位数。
- shock depth 取最小值，recovery depth 取中位数。
- spread 取窗口最大值。
- depth notional 取窗口最小值。
- final mid 取 recovery 最大 arrivalOrdinal。
- Broker recovery breadth 只取真实 Broker observation 中位数。
- BUYCALL / BUYPUT 镜像。
- timer 晚到不扩大 `[T0, T2]`。

- [ ] **Step 2: 写结果分类测试**

覆盖：

- 核心门禁全部通过为 `verified`。
- 每个核心门禁单独失败为 `rejected`。
- 每个 configured confirmation 单独失败为 `rejected`。
- 未配置 confirmation 不影响决策。
- configured confirmation 无定义为 `data-incomplete`。
- baseline sparse、阶段样本不足、gap/age 超限、overflow 为 `data-incomplete`。
- 非法 payload 不作为普通 result 进入 verifier。
- request 只接受 BUYCALL/BUYPUT。
- monitorReferencePrice 只参与 monitor mid-price 公式。

- [ ] **Step 3: 运行测试确认 RED**

Run:

```bash
bun test tests/main/asyncProgram/orderBookSignalVerifier/business.test.ts
```

Expected: FAIL。

- [ ] **Step 4: 实现纯验证算法**

要求：

- 不拥有 timer、pending、generation 状态或任务队列。
- 只读取 request 固定 generation 和固定窗口。
- Depth 与 Brokers 分别做 baseline、阶段样本、gap、freshness。
- confirmation 使用判别联合；不存在默认 confirmation 集合。
- 审计对象完整记录测量值与每个门禁结果。
- 只有完整 audit 才能品牌化为 `CompleteVerificationAudit`。

- [ ] **Step 5: 运行 GREEN**

Run:

```bash
bun test tests/main/asyncProgram/orderBookSignalVerifier/business.test.ts
```

Expected: PASS。

---

## 12. Task 11: 建立共享 SignalVerificationRuntime 并原子删除旧 verifier owner

**Files:**

- Add: `src/main/signalVerificationRuntime/index.ts`
- Add: `src/main/signalVerificationRuntime/types.ts`
- Modify/Delete: `src/main/asyncProgram/delayedSignalVerifier/**`
- Modify: `src/types/monitorContextPorts.ts`
- Modify: `src/types/state.ts`
- Modify: `src/utils/helpers/index.ts`
- Modify: `src/main/lifecycle/cacheDomains/globalStateDomain.ts`
- Modify: `src/main/seatRuntimeCleanupDispatcher/index.ts`
- Modify: `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts`
- Modify: `src/main/seatRuntimeCleanupDispatcher/types.ts`
- Modify: `src/app/context/createMonitorContexts.ts`
- Delete: `src/app/wiring/registerDelayedSignalHandlers.ts`
- Delete: `tests/app/wiring/registerDelayedSignalHandlers.business.test.ts`
- Add: `tests/main/signalVerificationRuntime/business.test.ts`
- Modify: `tests/helpers/testDoubles.ts`
- Modify: `tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts`
- Modify: `tests/app/shutdown/createCleanup.business.test.ts`

- [ ] **Step 1: 写 runtime 生命周期失败测试**

覆盖：

- `startAccepting()` 后才能注册。
- trend 与 orderBook 请求按 mode 委托纯算法。
- timer 由 bounded one-shot scheduler 创建。
- 未 claim timer 在 stop 时取消。
- 已 claim timer、evaluation 和 delivery 都被 `stopAndDrain()` 等待。
- stop 返回后旧请求不能写 VERIFIED queue。
- cancelForMonitor/cancelForDirection 只取消目标请求。
- generation 改变取消 orderBook request。
- fatal error 只进入 fatal sink，不返回普通 result。
- verified handler 异常进入 fatal sink。
- pending count 精确。
- 重复 stop 幂等。

- [ ] **Step 2: 写统一 delivery 测试**

每次 delivery 前重新检查：

```text
runtime accepting token
lastState.isTradingEnabled
ordinary signal/doomsday takeover gate
market-data generation
seat ACTIVE
seat identity/version
signal symbol 与当前 seat symbol
```

开盘保护不在回流门禁中。

- [ ] **Step 3: 运行测试确认 RED**

Run:

```bash
bun test tests/main/signalVerificationRuntime/business.test.ts
```

Expected: FAIL。

- [ ] **Step 4: 实现共享 runtime**

公开：

```text
startAccepting()
registerTrend(request)
registerOrderBook(request)
stopAndDrain()
cancelForMonitor()
cancelForDirection()
getPendingCount()
```

内部 pending key 必须包含 monitor、action、seat identity/version、detected time，避免新旧席位请求碰撞。

- [ ] **Step 5: 原子删除 per-monitor verifier**

完成以下替换：

- `MonitorContext` 删除 `delayedSignalVerifier`。
- `MonitorState` 删除 `pendingDelayedSignals`。
- `initMonitorState` 和 `globalStateDomain` 删除该死状态的初始化/清空。
- `createMonitorContexts` 不再为每个 monitor 创建 verifier。
- 删除 `DelayedSignalVerifierPort`。
- 删除 `registerDelayedSignalHandlers` 和 app wiring。
- lifecycle、seat cleanup、time wakeup 改为调用共享 runtime。
- cleanup 只调用一次共享 `stopAndDrain()`，不再遍历 monitor destroy。
- `removedDelayed` 改为语义准确的 verification cancellation 计数，不可在仍有生产消费时直接丢弃。

不要保留 `createDelayedSignalVerifier` alias。

- [ ] **Step 6: 运行原子迁移测试集**

Run:

```bash
bun test tests/main/signalVerificationRuntime/business.test.ts tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts tests/app/shutdown/createCleanup.business.test.ts tests/app/context/createMonitorContexts.business.test.ts tests/main/seatRuntimeCleanupDispatcher/business.test.ts tests/main/timeWakeupEvaluationProgram/business.test.ts
```

Expected: PASS。

---

## 13. Task 12: 改造 BusinessEventProgram 与 Signal Pipeline

**Files:**

- Modify: `src/types/signal.ts`
- Modify: `src/core/strategy/types.ts`
- Modify: `src/core/strategy/index.ts`
- Modify: `src/core/strategy/utils.ts`
- Modify: `src/main/businessEventProgram/index.ts`
- Modify: `src/main/businessEventProgram/types.ts`
- Modify: `src/main/businessEventProgram/signalPipeline.ts`
- Modify: `src/main/businessEventProgram/utils.ts`
- Modify: `src/main/asyncProgram/sellProcessor/index.ts`
- Modify: `src/app/runtime/createPostGateRuntime.ts`
- Modify: `src/app/runApp.ts`
- Modify: `tests/core/strategy/index.test.ts`
- Modify: `tests/core/strategy/utils.business.test.ts`
- Modify: `tests/main/businessEventProgram/business.test.ts`
- Modify: `tests/main/businessEventProgram/signalPipeline.business.test.ts`
- Modify: `tests/main/asyncProgram/sellProcessor/business.test.ts`
- Modify: `tests/app/runApp.business.test.ts`

- [ ] **Step 1: 写时间来源和分流失败测试**

覆盖：

- Candlestick callback 命中 route 时用同一次 `clock.capture()` 写 observed epoch/monotonic。
- latest-only collapse 保留最新 callback 的 observed pair，不重新创建。
- Pipeline 开始候选评估时捕获 detected epoch/monotonic。
- `Signal.triggerTime` 等于 detected epoch 对应 Date。
- orderBook T0 固定 observed monotonic。
- single-flight 等待只体现在 detected-observed 审计差值。
- monitorReferencePrice 精确等于本次 `IndicatorSnapshot.price`。
- 四动作 × 合法 mode 只进入一个 owner。
- trend 初值由 Pipeline 从当前 snapshot 提取。
- 任一 trend 初值缺失返回 data-incomplete，不登记 timer。
- orderBook 不提取技术指标初值。
- none 直接进入 IMMEDIATE queue。
- Strategy 不接收 verification config、indicator profile 或时钟。
- Strategy 返回 `ReadonlyArray<CandidateSignal>`，不再返回两个分类数组。
- `Signal.indicators1` 与 sellProcessor 对它的复制全部删除。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
bun test tests/main/businessEventProgram/business.test.ts tests/main/businessEventProgram/signalPipeline.business.test.ts tests/app/runApp.business.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 扩展 route state**

`BusinessEventRouteState.dirty=true` 时保存：

```text
pendingObservedEpochMs
pendingObservedMonotonicMs
```

不再只保存裸 `pendingObservedAtMs`。

- [ ] **Step 4: Pipeline 成为唯一 mode owner**

固定顺序：

```text
ordinary signal pre-gate
-> strategy.generateCandidateSignals
-> detected clock capture
-> prepareSignal / seat binding
-> resolve action verification config
-> none | trend | orderBook
```

orderBook request 从 `marketDataSubscriptionRuntime` 只读 active view 获取 generation 和 admitted monitor symbol；若 active view 与配置/monitor 不一致，作为不变量错误进入 fatal sink。

- [ ] **Step 5: 在同一 change set 切换 Strategy**

定义 `CandidateSignal`，并原子删除 Task 5 记录的旧分类、未来 triggerTime 和 `indicators1` 语义。不得在 Strategy 与 Pipeline 之间保留兼容 adapter。

- [ ] **Step 6: 修正 indicator cache push**

BusinessEventProgram 只投影所有 trend action 的指标集合。orderBook-only monitor 不写无关验证指标。

- [ ] **Step 7: 运行 GREEN**

Run:

```bash
bun test tests/core/strategy/index.test.ts tests/core/strategy/utils.business.test.ts tests/main/businessEventProgram/business.test.ts tests/main/businessEventProgram/signalPipeline.business.test.ts tests/main/asyncProgram/sellProcessor/business.test.ts tests/app/runApp.business.test.ts
```

Expected: PASS。

---

## 14. Task 13: 接入 startup/rebuild 静态准入、requirements 和 seed

**Files:**

- Modify: `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
- Modify: `src/main/lifecycle/types.ts`
- Modify: `src/app/startup/startupSnapshot.ts`
- Modify: `src/app/runtime/createPostGateRuntime.ts`
- Modify: `src/app/context/createMonitorContexts.ts`
- Modify: `src/app/runApp.ts`
- Modify: `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`
- Modify: `tests/app/startup/startupSnapshot.test.ts`
- Modify: `tests/integration/full-business-simulation.integration.test.ts`

- [ ] **Step 1: 写 rebuild 顺序失败测试**

严格断言：

```text
交易日/账户/持仓/全量订单
-> 席位与在途订单恢复
-> staticInfo board admission
-> 编译完整 requirements
-> resetAndReconcile
-> subscriptions readback 完整确认
-> candlestick/depth/brokers seed
-> quotesMap
-> 后续业务缓存重建
```

并覆盖：

- HKEquity + orderBook 成功。
- HKHS/HKWarrant/其他 board + orderBook fail-fast。
- 指数 monitor 的 none/trend 成功。
- 不改用 tradingSymbol 做订单簿准入。
- `301603` seed-unavailable 不阻断 startup/rebuild。
- `301604` 阻断 startup；rebuild 进入 fatal 并保持交易关闭。
- brokerBreadth 未配置时不调用 realtimeBrokers。
- requirements 包含 monitor、恢复席位、持仓、在途订单 Quote。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
bun test tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts tests/app/startup/startupSnapshot.test.ts tests/integration/full-business-simulation.integration.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 编译完整 target requirements**

必须在账户、持仓、订单和席位事实加载完成后一次性编译。每个 monitor：

```text
Quote
1m Candlestick
Depth if any action = orderBook
Brokers if orderBook confirmations contains brokerBreadth
```

恢复席位、持仓、在途订单额外增加 Quote。

`createPostGateRuntime` 的创建顺序固定为：

```text
quoteClient callback fan-out / mutation port
-> marketDataSubscriptionRuntime
-> orderBookCache
-> signalVerificationRuntime（注入统一 fatal sink）
-> loadTradingDayRuntimeSnapshot（只注入高层订阅事务端口）
```

- [ ] **Step 4: 静态 board admission**

只接受 SDK `SecurityBoard.HKEquity`。成功后由 subscription runtime 创建 `AdmittedHkEquitySymbol`。

不要通过 `.HK` 后缀、名称或 quote package 文本判断。

- [ ] **Step 5: seed 当前 generation**

Candlestick 使用 subscribe 返回值 seed；Depth/Brokers 使用 realtime readback seed。seed 写入前必须带 active generation。

- [ ] **Step 6: 运行 GREEN**

Run:

```bash
bun test tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts tests/app/startup/startupSnapshot.test.ts tests/integration/full-business-simulation.integration.test.ts
```

Expected: PASS。

---

## 15. Task 14: 收口连续交易边界、末日接管与 shutdown 顺序

**Files:**

- Modify: `src/main/timeWakeupEvaluationProgram/index.ts`
- Modify: `src/main/timeWakeupEvaluationProgram/types.ts`
- Modify: `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
- Modify: `src/main/lifecycle/cacheDomains/marketDataDomain.ts`
- Modify: `src/app/shutdown/createCleanup.ts`
- Modify: `src/app/lifecycle/createLifecycleRuntime.ts`
- Modify: `tests/main/timeWakeupEvaluationProgram/business.test.ts`
- Modify: `tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts`
- Modify: `tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts`
- Modify: `tests/app/shutdown/createCleanup.business.test.ts`
- Modify: `tests/main/lifecycle/integration.test.ts`

- [ ] **Step 1: 写边界竞态测试**

覆盖：

- 进入午休取消 orderBook pending。
- 全日/半日连续交易结束取消 orderBook pending。
- generation 切换取消全部旧 orderBook pending。
- 末日接管取消普通 trend/orderBook pending 并阻止 delivery。
- 开盘保护只阻止新候选和新注册，不取消已等待验证。
- timer 未 claim、已 claim、evaluation 中、delivery 中分别执行 stopAndDrain。
- unsubscribe 后旧 generation callback 被拒绝。
- 重复 shutdown/rebuild 幂等。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
bun test tests/main/timeWakeupEvaluationProgram/business.test.ts tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts tests/app/shutdown/createCleanup.business.test.ts tests/main/lifecycle/integration.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 固定停止顺序**

实现：

```text
signalVerificationRuntime 停止接收
-> businessEventProgram.stopAndDrain
-> signalVerificationRuntime.stopAndDrain
-> 其余业务 owner/processor drain
-> marketDataSubscriptionRuntime.stopAndDrain
-> 服务端事实确认
-> orderBook/indicator/monitor cache 清理
```

`signalRuntimeDomain` 和 app cleanup 使用同一所有权顺序，不得一处先清 cache、一处先停 callback。

- [ ] **Step 4: 保留 failed facts**

market-data stop 的任一退订/readback 失败：

- 继续执行不依赖该事实的本地清理。
- runtime 保持 failed 和 lastKnownFacts。
- cleanup 最终聚合并抛错。
- 不把 committed truth 伪造为空。

- [ ] **Step 5: 运行 GREEN**

Run:

```bash
bun test tests/main/timeWakeupEvaluationProgram/business.test.ts tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts tests/app/shutdown/createCleanup.business.test.ts tests/main/lifecycle/integration.test.ts
```

Expected: PASS。

---

## 16. Task 15: 更新完整测试替身、对象字面量与跨模块集成

**Files:**

- Modify: `tests/helpers/testDoubles.ts`
- Modify: `tests/app/**/*.test.ts`
- Modify: `tests/main/**/*.test.ts`
- Modify: `tests/integration/**/*.test.ts`
- Modify: `tests/chaos/**/*.test.ts`
- Modify: `tests/types/monitorContextPorts.test.ts`
- Modify: `tests/architecture/typeOrganization.test.ts`
- Modify: `tests/architecture/importBoundary.test.ts`

- [ ] **Step 1: 删除旧 double**

删除：

```text
createDelayedSignalVerifierDouble
DelayedSignalVerifierPort doubles
QuoteSubscriptionRuntime doubles
pendingDelayedSignals defaults
immediateSignals/delayedSignals strategy defaults
verificationIndicatorsBySide defaults
```

新增：

```text
createSignalVerificationRuntimeDouble
createMarketDataSubscriptionRuntimeDouble
createQuoteContextMutationPortDouble
createOrderBookCacheDouble
createRuntimeClockDouble
candidate strategy double
```

- [ ] **Step 2: 更新 architecture guards**

增加静态护栏：

- `MarketDataClient` 不包含低层 mutation。
- 只有 `marketDataSubscriptionRuntime` 依赖 `QuoteContextMutationPort`。
- `types.ts` 无 runtime 定义。
- 不存在旧 verifier/owner import。
- orderBook verifier 不 import SDK、timer、任务队列或 subscription runtime。
- trend verifier 不 import timer、任务队列或 config parser。
- Strategy 不 import verification config 或 time constants。

- [ ] **Step 3: 运行分层测试**

Run:

```bash
bun test tests/types tests/architecture tests/app tests/main
```

Expected: PASS。

- [ ] **Step 4: 运行 integration/chaos**

Run:

```bash
bun test tests/integration tests/chaos tests/mock-contract
```

Expected: PASS。

---

## 17. Task 16: 文档、环境示例与业务规范同步

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: `.codex/skills/core-program-business-logic/SKILL.md`
- Modify: current active docs that describe verification/runtime ownership

- [ ] **Step 1: 更新 `.env.example`**

至少包含两组可直接 parse 的配置：

1. `HKEquity + ORDER_BOOK` monitor，包含完整 JSON。
2. 合法 `TREND/NONE` monitor。

删除所有旧：

```text
VERIFICATION_DELAY_SECONDS_BUY_
VERIFICATION_DELAY_SECONDS_SELL_
VERIFICATION_INDICATORS_BUY_
VERIFICATION_INDICATORS_SELL_
```

- [ ] **Step 2: 更新 README**

准确说明：

- Strategy/Pipeline/runtime 所有权。
- orderBook 只支持 HKEquity monitor 的买入动作。
- Depth/Brokers 独立流。
- confirmations 显式配置。
- 缺数据拒绝当前信号，不降档。
- 卖出与风险清仓不等待订单簿验证。

- [ ] **Step 3: 更新业务 skill**

把旧“延迟验证”章节替换为：

- none/trend/orderBook 分流。
- trend 原语义。
- orderBook 核心门禁和 confirmations。
- 开盘保护与末日接管不对称语义。
- 唯一订阅 owner 与 generation 生命周期。

- [ ] **Step 4: 标记历史归档**

历史文档可以保留旧术语，但若其可能被当作当前实现入口，增加“已废弃/仅历史背景”说明。不要批量改写纯历史记录。

---

## 18. Task 17: 全量残留清理

**Files:**

- Search scope: `src/`, `tests/`, `.env.example`, `README.md`, `.codex/skills/core-program-business-logic/SKILL.md`, current active plans/specs

- [ ] **Step 1: 运行旧验证语义残留搜索**

Run:

```bash
rg -n "delayedSignalVerifier|DelayedSignalVerifier|registerDelayedSignalHandlers|cancelAllDelayedSignals|removedDelayed|pendingDelayedSignals|immediateSignals|delayedSignals|SignalTypeCategory|SignalWithCategory|needsDelayedVerification|calculateVerificationTime|signalTypeMap|pushSignalToCorrectArray|SingleVerificationConfig|verificationConfig\\.buy|verificationConfig\\.sell|TradingSignalStrategyConfig|indicators1|VERIFICATION_DELAY_SECONDS_BUY_|VERIFICATION_DELAY_SECONDS_SELL_|VERIFICATION_INDICATORS_BUY_|VERIFICATION_INDICATORS_SELL_|verificationIndicatorsBySide" src tests .env.example README.md .codex/skills/core-program-business-logic/SKILL.md docs/superpowers docs/plans/2026-06
```

Expected: 当前活动代码、测试、配置和文档零残留。设计文档第 19/24 节的删除清单文字可保留。

- [ ] **Step 2: 运行禁止指标残留搜索**

Run:

```bash
rg -n "activeBuyVolume|activeSellVolume|activeTotalVolume|dominanceRatio|TickCVD|MLOFI|Observed OFI|Observed Book Delta|aggressorSide|ORDER_BOOK_LEVEL_WEIGHTS|maxSnapshotGapMs|PairedOrderBookObservation|orderBookSubscriptionRuntime" src tests .env.example README.md .codex/skills/core-program-business-logic/SKILL.md docs/superpowers
```

Expected: 生产实现和当前配置零残留；删除原因说明不计。

- [ ] **Step 3: 运行低层订阅 owner 搜索**

Run:

```bash
rg -n "QuoteContextMutationPort|subscribeSubtypes|unsubscribeSubtypes|getSubscriptions|subscribeCandlestick|unsubscribeCandlestick|resetRuntimeMarketData" src
```

Expected:

- `QuoteContextMutationPort` 只由 quoteClient 定义/实现、app 装配传递、marketDataSubscriptionRuntime 消费。
- 其他 lifecycle、business、MonitorContext 模块不出现低层 mutation。

- [ ] **Step 4: 检查无用文件和空目录**

确认：

- 旧 `delayedSignalVerifier` 目录不存在。
- 旧 `quoteSubscriptionRuntime` 目录不存在。
- 旧 wiring test 不存在。
- 无临时 replay、debug、fixture 或生成文件。

---

## 19. Task 18: 完整工程验证

- [ ] **Step 1: 运行 format**

Run:

```bash
bun format
```

Expected: 成功。检查格式化范围，确认没有无关文件被意外改写。

- [ ] **Step 2: 运行 lint**

Run:

```bash
bun lint
```

Expected: PASS。不得用 `any`、无理由断言或临时 eslint disable 绕过。

- [ ] **Step 3: 运行 type-check**

Run:

```bash
bun type-check
```

Expected: PASS。

- [ ] **Step 4: 运行全量测试**

Run:

```bash
bun test
```

Expected: PASS。

- [ ] **Step 5: 运行容量/性能定向测试**

Run:

```bash
bun test tests/main/orderBookCache/business.test.ts tests/main/asyncProgram/orderBookSignalVerifier/business.test.ts tests/main/marketDataSubscriptionRuntime/business.test.ts tests/main/signalVerificationRuntime/business.test.ts
```

Expected:

- 固定 push burst 下缓存有界。
- overflow 被显式标记。
- pending 数增加不导致重复扫描原始十档。
- stop 后 timer、retains、callbacks 和缓存资源归零或保持准确 failed facts。

- [ ] **Step 6: 检查工作树**

Run:

```bash
git status --short
git diff --stat
```

Expected: 只包含本重构相关源码、测试、配置和文档。

- [ ] **Step 7: 检查残留进程**

Run:

```powershell
Get-Process |
  Where-Object {
    $_.ProcessName -match 'bun|node|tsc|typescript'
  } |
  Select-Object Id, ProcessName, StartTime, Path
```

只清理由本次任务启动且已经无用的 test/watch/build 进程。不要终止 Codex、编辑器或用户已有的 Node 进程。

---

## 20. 最终验收清单

- [ ] Strategy 只生成候选，不读取验证配置，不创建未来时间。
- [ ] Pipeline 是四动作 `none / trend / orderBook` 唯一分流 owner。
- [ ] orderBook 从类型和运行时两层都只接受 BUYCALL / BUYPUT。
- [ ] `Signal.triggerTime` 是 detected 时间，不承载 verification ready 时间。
- [ ] observed epoch/monotonic 在同一次 K 线 callback 捕获并传到 Pipeline。
- [ ] trend 的 delay、T0/T+5/T+10、最近样本和 ADX 语义与迁移前一致。
- [ ] `signalVerificationRuntime` 是 timer、pending、cancel、drain、delivery 和 fatal 的唯一 owner。
- [ ] stopAndDrain 返回后没有旧 verification 写入 VERIFIED queue。
- [ ] verified 回流不受 open protection 阻断，但受末日接管和 lifecycle 门禁阻断。
- [ ] 保护性清仓、末日清仓、智能平仓、普通卖出和换标卖出不进入 orderBook verifier。
- [ ] Quote/Candlestick/Depth/Brokers mutation 只有一个串行 owner。
- [ ] startup/rebuild 在业务权威事实完成后一次性编译 requirements。
- [ ] committed truth 由 subscriptions readback 确认，不由本地 Set 猜测。
- [ ] 部分成功回滚不退订事务前 baseline。
- [ ] stop 失败保留 failed + lastKnownFacts。
- [ ] orderBook 只读取 admitted HKEquity monitorSymbol。
- [ ] Depth/Brokers 独立缓存，不做跨流配对。
- [ ] sparse 市场状态与非法 payload 严格分离。
- [ ] 非法 payload 只进入 fatal sink。
- [ ] configured confirmation 缺失时为 data-incomplete，不跳过。
- [ ] 未配置 brokerBreadth 时不订阅、不 seed、不验证 Brokers。
- [ ] indicator cache retention 只由 trend action 决定。
- [ ] 旧配置键、旧 verifier、旧 owner、旧类型和无生产消费状态零残留。
- [ ] `.env.example` 两组正向示例可通过真实 parser。
- [ ] README 和业务 skill 与实现一致。
- [ ] `bun format`、`bun lint`、`bun type-check`、`bun test` 全部通过。
- [ ] 无本任务遗留的 test/watch/build 进程。

---

## 21. 实证启用门槛

工程验收完成后，生产启用 `ORDER_BOOK` 仍需单独完成设计文档第 22 节：

1. Depth/Brokers 连续交易时段事件录制。
2. 确定性 replay。
3. 指标覆盖率与单指标命中率。
4. 指标相关性。
5. confirmations 消融。
6. 训练/验证/样本外拆分。
7. walk-forward。
8. 早盘、午盘、波动率、流动性分层。
9. 拒绝率与最终成交质量评估。

不得把“代码、类型和生命周期测试通过”描述为“订单簿策略已证明有效”。
