# Per-Monitor Strategy Isolation Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让不同监控标的可以显式选择不同策略族，并让各标的策略定义、指标需求、信号生成逻辑互相隔离，同时继续共用交易执行、风控、订单、生命周期、订阅与换标基础设施。

**Architecture:** 策略拆分只发生在配置、策略定义、指标需求编译和策略实例装配层。`main/businessEventProgram` 继续作为 K 线事件 owner，只通过 `TradingSignalStrategy` 端口消费候选信号，不感知具体策略类型；买卖执行、延迟验证、风控、订单记录、生命周期等运行时仍保持共享。

**Tech Stack:** Bun, TypeScript, Longbridge OpenAPI SDK, existing `src/app` assembly layer, `src/core/strategy`, `src/services/indicators`, `src/main/businessEventProgram`, architecture tests.

---

## 二次分析结论

### 当前事实

当前程序不是所有监控标的共用同一个策略实例。`createMonitorContexts(...)` 会为每个 `MonitorConfig` 创建独立 `MonitorContext.strategy`，并为该 monitor 编译独立 `indicatorProfile`。

但当前所有策略实例都来自同一个策略引擎：`createMultiIndicatorTradingStrategy(...)`。每个 monitor 能改变的是四动作条件 DSL 和买卖延迟验证参数，不能改变策略族、策略状态机、指标需求声明方式或信号生成模型。

当前主链路为：

```text
MONITOR_SYMBOL_N / SIGNAL_*_N / VERIFICATION_*_N
-> parseMonitorConfig(...)
-> createMonitorContexts(...)
-> compileIndicatorUsageProfile(signalConfig, verificationConfig)
-> createMultiIndicatorTradingStrategy(...)
-> businessEventProgram K-line event
-> runIndicatorPipeline(...)
-> indicatorCache.push(...)
-> runSignalPipeline(...)
-> strategy.generateSignals(...)
-> immediate buy/sell queue or delayedSignalVerifier
```

这说明当前问题的本质是：**per-monitor 参数化已经存在，per-monitor 策略族隔离不存在。**

### 初步方案可行性

初步方案中“策略实现保留在 `core/strategy`、策略选择放在 `app/context`、`main` 只消费端口”的方向是可行的，理由如下：

- `TradingSignalStrategy` 和 `TradingSignalStrategyFactory` 现已定义在 `src/core/strategy/types.ts`，这是现有策略端口的自然扩展点。
- `createMonitorContexts(...)` 是每个 monitor 创建 `strategy` 和 `indicatorProfile` 的唯一装配点，适合承担 per-monitor 策略选择。
- `runSignalPipeline(...)` 当前只依赖 `monitorContext.strategy.generateSignals(...)`，并在策略输出后统一执行 ordinary gate、席位 ACTIVE、seatVersion、symbol match 和队列分流；这里不应引入具体策略分支。
- `businessEventProgram` 已按 `monitorSymbol` 做 single-flight/latest-only route，策略拆分不会要求重写事件驱动主链路。

### 初步方案的不足

初版设计还不够完整，必须补齐以下点：

1. **指标需求 owner 不能继续绑定旧 `signalConfig + verificationConfig`。**  
   如果只给 `strategyFactory` 传完整 `MonitorConfig`，但继续用 `compileIndicatorUsageProfile({ signalConfig, verificationConfig })`，新策略需要的指标可能不会被 runtime 计算。

2. **延迟验证和 indicator cache 保留窗口必须从策略定义推导。**  
   `createPostGateRuntime.ts` 当前用所有 monitor 的 `verificationConfig.buy/sell.delaySeconds` 计算 `indicatorCache` 保留窗口。迁移后必须从 `strategyDefinition` 的延迟验证需求取最大延迟，不能留下旧字段。

3. **配置校验、启动日志和 README/env 样例必须同步迁移。**  
   `src/config/validator/**` 和 `README.md` 仍以 `SIGNAL_BUYCALL_N` 等旧配置为用户入口。如果只改运行时，不改校验和文档，会形成双轨配置和误导。

4. **架构边界测试必须防止策略逻辑泄漏到 `main` 或 `services`。**  
   这不是代码风格问题。若 `main/businessEventProgram` 直接 import 具体策略，就会把事件 owner 和策略业务规则耦合在一起。

5. **不能用旧配置 fallback 到默认策略。**  
   本次目标是系统性重构，不是兼容性迁移。缺少 `strategy.kind`、未知 kind、kind 参数缺失都必须 fail-fast。

### 合理性判定

合理的重构边界是：

- `MonitorConfig` 保留监控标的、席位、风控、自动寻标、执行参数。
- 策略相关字段收敛为 `strategy: StrategyDefinition`。
- 每个 `StrategyDefinition.kind` 对应一个具体策略工厂。
- 每个策略工厂创建的策略必须声明自身指标需求。
- 指标 profile 由策略指标需求编译，不再由旧四动作 DSL 直接推导。
- `runSignalPipeline(...)` 只负责调用策略端口和统一分流。
- 买卖执行、风控、订单记录、生命周期、订阅、换标、延迟验证 runtime 继续共用。

这个边界能够同时满足：

- 不同 monitor 采用不同策略族。
- 不同策略之间的配置和指标需求互不污染。
- 策略不能绕过交易门禁、席位版本、风险检查和订单执行一致性。
- 不引入 fallback、降级、双轨兼容或补丁式字段堆叠。

## 不变业务边界

以下模块不随策略拆分复制，也不变成策略私有实现：

- `src/main/businessEventProgram/index.ts`：K 线事件 owner，继续按 monitor route 推进指标和信号流水线。
- `src/main/businessEventProgram/signalPipeline.ts`：普通信号门禁、席位校验、seatVersion 绑定、立即/延迟分流 owner。
- `src/main/asyncProgram/delayedSignalVerifier/**`：延迟验证 runtime，继续按 monitor + signal 管理待验证信号。
- `src/main/asyncProgram/buyProcessor/**`：买入执行 owner，继续执行实时行情读取、买入风控和下单。
- `src/main/asyncProgram/sellProcessor/**`：卖出执行 owner，继续等待成交后一致性 fresh、计算卖量和下单。
- `src/core/signalProcessor/**`：买入风险流水线和卖出数量计算 owner。
- `src/core/orderRecorder/**`：订单记录和智能平仓事实 owner。
- `src/core/riskController/**`：牛熊证风险、浮亏、持仓限制 owner。
- `src/services/autoSymbolManager/**`：寻标、换标、席位状态机 owner。
- `src/main/lifecycle/**`：午夜清理、开盘重建、缓存域 owner。
- `src/main/quoteSubscriptionRuntime/**`：订阅集合 owner。
- `src/app/runtime/createPostTradeConsistencyRuntime.ts`：成交后一致性 owner。

策略只负责产生候选 `Signal`，不负责入队、下单、风险检查、quote retry、生命周期重建或订阅。

## 目标类型模型

### StrategyDefinition

新增 `src/types/strategy.ts`，作为配置层和策略层共享的类型边界。

```ts
import type { SignalConfig } from './signalConfig.js';
import type { VerificationIndicator } from './indicatorProfile.js';

export type StrategyKind = 'multi-indicator' | 'mean-reversion' | 'trend-breakout';

export type DirectionalVerificationDefinition = Readonly<{
  delaySeconds: number;
  indicators: ReadonlyArray<VerificationIndicator>;
}>;

export type MultiIndicatorStrategyDefinition = Readonly<{
  kind: 'multi-indicator';
  signals: Readonly<{
    buycall: SignalConfig;
    sellcall: SignalConfig;
    buyput: SignalConfig;
    sellput: SignalConfig;
  }>;
  verification: Readonly<{
    buy: DirectionalVerificationDefinition;
    sell: DirectionalVerificationDefinition;
  }>;
}>;

export type MeanReversionStrategyDefinition = Readonly<{
  kind: 'mean-reversion';
  entry: Readonly<{
    rsiPeriod: number;
    rsiOversold: number;
    mfiOversold: number;
    kdjJExtreme: number;
  }>;
  exit: Readonly<{
    rsiRecovery: number;
    kdjKRecovery: number;
  }>;
  verification: Readonly<{
    buy: DirectionalVerificationDefinition;
    sell: DirectionalVerificationDefinition;
  }>;
}>;

export type TrendBreakoutStrategyDefinition = Readonly<{
  kind: 'trend-breakout';
  entry: Readonly<{
    emaFastPeriod: number;
    emaSlowPeriod: number;
    adxMin: number;
  }>;
  exit: Readonly<{
    emaExitPeriod: number;
  }>;
  verification: Readonly<{
    buy: DirectionalVerificationDefinition;
    sell: DirectionalVerificationDefinition;
  }>;
}>;

export type StrategyDefinition =
  | MultiIndicatorStrategyDefinition
  | MeanReversionStrategyDefinition
  | TrendBreakoutStrategyDefinition;
```

首轮实现可以只落地 `multi-indicator` 行为迁移，`mean-reversion` 和 `trend-breakout` 先只作为类型与 fail-fast 解析目标不启用，或者在同一计划中完成具体实现。若实现阶段不打算一次性实现后两类策略，不要在解析层接受这两个 kind。

本计划建议首轮只接受 `multi-indicator`，同时把 registry 和端口设计好。后续新增策略时，每个策略作为独立增量，而不是继续改旧四动作 DSL。

### MonitorConfig

修改 `src/types/config.ts`：

```ts
import type { StrategyDefinition } from './strategy.js';

export type MonitorConfig = {
  readonly originalIndex: number;
  readonly monitorSymbol: string;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly autoSearchConfig: AutoSearchConfig;
  readonly orderOwnershipMapping: ReadonlyArray<string>;
  readonly targetNotional: number;
  readonly maxPositionNotional: number;
  readonly maxUnrealizedLossPerSymbol: number;
  readonly buyIntervalSeconds: number;
  readonly liquidationCooldown: LiquidationCooldownConfig | null;
  readonly liquidationTriggerLimit: number;
  readonly strategy: StrategyDefinition;
  readonly smartCloseEnabled: boolean;
  readonly smartCloseTimeoutMinutes: number | null;
};
```

删除 monitor 顶层：

```ts
readonly verificationConfig: VerificationConfig;
readonly signalConfig: SignalConfigSet;
```

`VerificationConfig` 和 `SignalConfigSet` 可以在旧 `multi-indicator` 策略内部继续复用或重命名，但不再作为 `MonitorConfig` 顶层公共字段。

### Strategy Port

修改 `src/core/strategy/types.ts`：

```ts
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { Signal } from '../../types/signal.js';
import type { OrderRecorder } from '../../types/services.js';
import type { SignalSeatInfo } from '../../main/businessEventProgram/types.js';
import type { IndicatorRequirements } from '../../types/indicatorProfile.js';
import type { StrategyDefinition } from '../../types/strategy.js';

export type StrategyEvaluationContext = Readonly<{
  monitorSymbol: string;
  monitorSnapshot: IndicatorSnapshot | null;
  seatInfo: SignalSeatInfo;
  orderRecorder: OrderRecorder;
  currentTime: Date;
}>;

export type TradingSignalGenerationResult = {
  readonly immediateSignals: ReadonlyArray<Signal>;
  readonly delayedSignals: ReadonlyArray<Signal>;
};

export interface TradingSignalStrategy {
  getIndicatorRequirements: () => IndicatorRequirements;
  getMaxVerificationDelaySeconds: () => number;
  getVerificationIndicatorsForSignal: (signal: Signal) => ReadonlyArray<VerificationIndicator>;
  generateSignals: (context: StrategyEvaluationContext) => TradingSignalGenerationResult;
}

export type TradingSignalStrategyFactory = (
  params: Readonly<{
    monitorSymbol: string;
    definition: StrategyDefinition;
  }>,
) => TradingSignalStrategy;
```

`getVerificationIndicatorsForSignal(...)` 的目的：`runSignalPipeline(...)` 在延迟信号入队时仍然不理解具体策略配置，只向策略询问该信号需要哪些验证指标。这样可以删除 `signalPipeline.ts` 对 `monitorContext.indicatorProfile.verificationIndicatorsBySide.buy/sell` 的直接策略假设。

### IndicatorRequirements

修改 `src/types/indicatorProfile.ts`，新增策略可声明的指标需求类型：

```ts
export type IndicatorRequirements = {
  readonly indicators: ReadonlyArray<ProfileIndicator>;
  readonly verificationIndicatorsBySide: {
    readonly buy: ReadonlyArray<VerificationIndicator>;
    readonly sell: ReadonlyArray<VerificationIndicator>;
  };
};
```

`IndicatorUsageProfile` 保持为运行期 profile：

```ts
export type IndicatorUsageProfile = {
  readonly requiredFamilies: { ... };
  readonly requiredPeriods: { ... };
  readonly verificationIndicatorsBySide: { ... };
  readonly displayPlan: ReadonlyArray<DisplayIndicatorItem>;
};
```

### Profile Compiler

把 `compileIndicatorUsageProfile(...)` 从旧输入：

```ts
compileIndicatorUsageProfile({
  signalConfig: config.signalConfig,
  verificationConfig: config.verificationConfig,
});
```

改为：

```ts
compileIndicatorUsageProfile(strategy.getIndicatorRequirements());
```

`services/indicators/profile` 只负责把 `IndicatorRequirements` 编译为运行时 profile，不再解析策略业务语义。

## 配置设计

### 环境变量迁移

当前配置入口是：

```text
SIGNAL_BUYCALL_1=...
SIGNAL_SELLCALL_1=...
SIGNAL_BUYPUT_1=...
SIGNAL_SELLPUT_1=...
VERIFICATION_DELAY_SECONDS_BUY_1=...
VERIFICATION_INDICATORS_BUY_1=...
VERIFICATION_DELAY_SECONDS_SELL_1=...
VERIFICATION_INDICATORS_SELL_1=...
```

重构后建议第一阶段使用显式策略前缀：

```text
STRATEGY_KIND_1=multi-indicator
STRATEGY_BUYCALL_1=(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-20)
STRATEGY_SELLCALL_1=(RSI:6>65,K>75)
STRATEGY_BUYPUT_1=(RSI:6>75,MFI>80,D>75,J>100)/3|(J>120)
STRATEGY_SELLPUT_1=(RSI:6<35,K<25)
STRATEGY_VERIFICATION_DELAY_SECONDS_BUY_1=60
STRATEGY_VERIFICATION_INDICATORS_BUY_1=K,MACD
STRATEGY_VERIFICATION_DELAY_SECONDS_SELL_1=60
STRATEGY_VERIFICATION_INDICATORS_SELL_1=K,MACD
```

不保留旧 `SIGNAL_*_N` 的 fallback。若旧 key 仍存在但新 key 缺失，校验直接失败，并输出明确迁移提示：

```text
[配置错误] MONITOR_SYMBOL_1 已配置，但缺少 STRATEGY_KIND_1。旧 SIGNAL_*_1 配置已废弃，请迁移到 STRATEGY_*_1。
```

### Fail-fast 规则

配置解析必须满足：

- `MONITOR_SYMBOL_N` 已配置时，`STRATEGY_KIND_N` 必填。
- `STRATEGY_KIND_N` 只接受已实现的 kind。
- `multi-indicator` 下四个动作配置都必填，保持当前校验语义。
- `multi-indicator` 下买/卖验证 delay 和 indicators 继续允许 delay=0 或 indicators 空来表达立即执行。
- 验证指标非法时 fail-fast，不再只警告后跳过。
- 任何旧 `SIGNAL_*_N` 或 `VERIFICATION_*_N` 配置不能被运行时读取。

## 文件结构

### Create

- `src/types/strategy.ts`  
  定义 `StrategyKind`、`StrategyDefinition`、各策略 definition、策略解析后的验证 definition。

- `src/core/strategy/multiIndicatorStrategy.ts`  
  从现有 `src/core/strategy/index.ts` 拆出多指标策略实现，接收 `MultiIndicatorStrategyDefinition`。

- `src/core/strategy/registry.ts`  
  提供 `createStrategyFromDefinition(...)`，按 `definition.kind` 选择具体策略工厂。未知 kind 抛错。

- `src/core/strategy/requirements.ts`  
  提供策略指标需求构造 helper，例如从 `SignalConfig` 收集条件指标、合并验证指标。

- `tests/core/strategy/registry.business.test.ts`  
  覆盖 registry 按 kind 创建策略，未知 kind fail-fast。

- `tests/core/strategy/multiIndicatorStrategy.business.test.ts`  
  迁移并扩展当前 `tests/core/strategy/index.test.ts` 的行为测试。

### Modify

- `src/types/config.ts`  
  `MonitorConfig` 用 `strategy` 替换 `signalConfig` 和 `verificationConfig`。

- `src/types/indicatorProfile.ts`  
  新增 `IndicatorRequirements`。

- `src/core/strategy/types.ts`  
  改造策略端口和 factory 入参。

- `src/core/strategy/index.ts`  
  只导出 registry 和具体策略，或者保留导出但不再承载全部实现。

- `src/config/trading/utils.ts`  
  解析 `STRATEGY_KIND_N` 和对应策略配置。

- `src/config/validator/utils.ts`  
  校验 strategy definition，并删除旧 signalConfig 顶层校验。

- `src/config/validator/index.ts`  
  启动日志改为输出策略 kind 和策略参数摘要。

- `src/app/context/createMonitorContexts.ts`  
  先按 monitor strategy definition 创建策略，再用策略需求编译 profile。

- `src/app/runtime/createPostGateRuntime.ts`  
  `indicatorCacheRetentionSeconds` 从 `monitorConfig.strategy` 或创建出的 strategy 取最大延迟。

- `src/main/businessEventProgram/signalPipeline.ts`  
  调用新的 `strategy.generateSignals({ ... })`，延迟信号验证指标从策略端口获取。

- `src/main/businessEventProgram/types.ts`  
  调整 `SignalPipelineParams` 和必要的 strategy context 类型引用。

- `src/services/indicators/profile/index.ts`  
  改为消费 `IndicatorRequirements`。

- `tests/app/context/createMonitorContexts.business.test.ts`  
  覆盖 per-monitor 不同策略 definition 和 profile 隔离。

- `tests/services/indicators/profile/index.business.test.ts`  
  改为从 requirements 编译 profile。

- `tests/main/businessEventProgram/signalPipeline.business.test.ts`  
  覆盖 signal pipeline 不感知具体策略。

- `tests/config/tradingConfig.failfast.business.test.ts`  
  覆盖新配置 fail-fast 与旧配置废弃。

- `tests/architecture/importBoundary.test.ts`  
  禁止 `src/main/**` 直接 import 具体策略实现。

- `tests/architecture/typeOrganization.test.ts`  
  更新策略文件结构期望。

- `README.md`  
  更新配置样例，删除旧 `SIGNAL_*_N` 说明。

## Implementation Tasks

### Task 1: 建立策略定义类型

**Files:**

- Create: `src/types/strategy.ts`
- Modify: `src/types/config.ts`
- Test: `bun test tests/architecture/typeOrganization.test.ts`

- [ ] **Step 1: 新增 `StrategyDefinition` 类型**

在 `src/types/strategy.ts` 创建策略定义联合类型。首轮只接受 `multi-indicator`，不要在解析层启用未实现策略。

```ts
import type { VerificationIndicator } from './indicatorProfile.js';
import type { SignalConfig } from './signalConfig.js';

export type StrategyKind = 'multi-indicator';

export type DirectionalVerificationDefinition = Readonly<{
  delaySeconds: number;
  indicators: ReadonlyArray<VerificationIndicator>;
}>;

export type MultiIndicatorStrategyDefinition = Readonly<{
  kind: 'multi-indicator';
  signals: Readonly<{
    buycall: SignalConfig;
    sellcall: SignalConfig;
    buyput: SignalConfig;
    sellput: SignalConfig;
  }>;
  verification: Readonly<{
    buy: DirectionalVerificationDefinition;
    sell: DirectionalVerificationDefinition;
  }>;
}>;

export type StrategyDefinition = MultiIndicatorStrategyDefinition;
```

- [ ] **Step 2: 修改 `MonitorConfig`**

在 `src/types/config.ts` 引入 `StrategyDefinition`，删除 `SignalConfigSet` 和 `VerificationConfig` 作为 monitor 顶层字段。

```ts
import type { StrategyDefinition } from './strategy.js';
```

`MonitorConfig` 中保留：

```ts
readonly strategy: StrategyDefinition;
```

删除：

```ts
readonly verificationConfig: VerificationConfig;
readonly signalConfig: SignalConfigSet;
```

- [ ] **Step 3: 运行类型组织测试**

Run:

```bash
bun test tests/architecture/typeOrganization.test.ts
```

Expected: 当前会失败，因为生产代码仍引用旧字段。该失败是预期的迁移中间态。

### Task 2: 改造策略端口

**Files:**

- Modify: `src/types/indicatorProfile.ts`
- Modify: `src/core/strategy/types.ts`
- Test: `bun test tests/core/strategy/index.test.ts`

- [ ] **Step 1: 新增 `IndicatorRequirements`**

在 `src/types/indicatorProfile.ts` 添加：

```ts
export type IndicatorRequirements = {
  readonly indicators: ReadonlyArray<ProfileIndicator>;
  readonly verificationIndicatorsBySide: {
    readonly buy: ReadonlyArray<VerificationIndicator>;
    readonly sell: ReadonlyArray<VerificationIndicator>;
  };
};
```

- [ ] **Step 2: 修改策略端口**

在 `src/core/strategy/types.ts` 改为 context 入参。保留 `TradingSignalGenerationResult`，新增 `StrategyEvaluationContext`。

```ts
export type StrategyEvaluationContext = Readonly<{
  monitorSymbol: string;
  monitorSnapshot: IndicatorSnapshot | null;
  seatInfo: SignalSeatInfo;
  orderRecorder: OrderRecorder;
  currentTime: Date;
}>;
```

策略接口改为：

```ts
export interface TradingSignalStrategy {
  getIndicatorRequirements: () => IndicatorRequirements;
  getMaxVerificationDelaySeconds: () => number;
  getVerificationIndicatorsForSignal: (signal: Signal) => ReadonlyArray<VerificationIndicator>;
  generateSignals: (context: StrategyEvaluationContext) => TradingSignalGenerationResult;
}
```

工厂改为：

```ts
export type TradingSignalStrategyFactory = (
  params: Readonly<{
    monitorSymbol: string;
    definition: StrategyDefinition;
  }>,
) => TradingSignalStrategy;
```

- [ ] **Step 3: 运行策略测试确认旧实现断裂点**

Run:

```bash
bun test tests/core/strategy/index.test.ts
```

Expected: FAIL，错误集中在旧 `generateSignals(state, longSymbol, shortSymbol, ...)` 签名和旧 `TradingSignalStrategyConfig`。

### Task 3: 迁移多指标策略实现

**Files:**

- Create: `src/core/strategy/multiIndicatorStrategy.ts`
- Modify: `src/core/strategy/index.ts`
- Modify: `tests/core/strategy/index.test.ts`
- Test: `bun test tests/core/strategy/index.test.ts`

- [ ] **Step 1: 从旧实现拆出多指标策略**

把 `createMultiIndicatorTradingStrategy(...)` 从 `src/core/strategy/index.ts` 移入 `src/core/strategy/multiIndicatorStrategy.ts`，构造函数入参改为：

```ts
export function createMultiIndicatorTradingStrategy(params: {
  readonly monitorSymbol: string;
  readonly definition: MultiIndicatorStrategyDefinition;
}): TradingSignalStrategy {
  const { definition } = params;
  const finalSignalConfig = definition.signals;
  const finalVerificationConfig = definition.verification;
  ...
}
```

- [ ] **Step 2: 用 `StrategyEvaluationContext` 替代位置参数**

旧：

```ts
generateSignals(state, longSymbol, shortSymbol, orderRecorder, indicatorProfile);
```

新：

```ts
generateSignals: (context) => {
  const {
    monitorSnapshot,
    seatInfo,
    orderRecorder,
  } = context;
  const { longSymbol, shortSymbol } = seatInfo;
  ...
}
```

- [ ] **Step 3: 策略自己声明指标需求**

实现：

```ts
getIndicatorRequirements: () =>
  buildMultiIndicatorRequirements({
    signals: finalSignalConfig,
    verification: finalVerificationConfig,
  }),
```

其中 `buildMultiIndicatorRequirements(...)` 放在 `src/core/strategy/requirements.ts`，负责从四动作条件和验证指标中收集 `ProfileIndicator`。

- [ ] **Step 4: 策略自己提供延迟验证指标**

实现：

```ts
getVerificationIndicatorsForSignal: (signal) =>
  isBuyAction(signal.action)
    ? finalVerificationConfig.buy.indicators
    : finalVerificationConfig.sell.indicators,
```

- [ ] **Step 5: 策略自己提供最大延迟秒数**

实现：

```ts
getMaxVerificationDelaySeconds: () =>
  Math.max(
    finalVerificationConfig.buy.delaySeconds,
    finalVerificationConfig.sell.delaySeconds,
  ),
```

- [ ] **Step 6: 更新测试**

把 `tests/core/strategy/index.test.ts` 中的构造替换为：

```ts
const strategy = createMultiIndicatorTradingStrategy({
  monitorSymbol: 'HSI.HK',
  definition: {
    kind: 'multi-indicator',
    signals: {
      buycall: requireSignalConfig('(K>80)'),
      sellcall: requireSignalConfig('(D>50)'),
      buyput: null as never,
      sellput: null as never,
    },
    verification: {
      buy: { delaySeconds: 0, indicators: ['K'] },
      sell: { delaySeconds: 10, indicators: ['K'] },
    },
  },
});
```

测试中的 `generateSignals(...)` 改为：

```ts
const result = strategy.generateSignals({
  monitorSymbol: 'HSI.HK',
  monitorSnapshot: createSnapshot(),
  seatInfo: createSeatInfo({ longSymbol: 'BULL.HK', shortSymbol: '' }),
  orderRecorder,
  currentTime: new Date('2026-05-21T09:31:00.000Z'),
});
```

- [ ] **Step 7: 运行策略测试**

Run:

```bash
bun test tests/core/strategy/index.test.ts
```

Expected: PASS。

### Task 4: 建立策略 registry

**Files:**

- Create: `src/core/strategy/registry.ts`
- Modify: `src/core/strategy/index.ts`
- Create: `tests/core/strategy/registry.business.test.ts`

- [ ] **Step 1: 新增 registry**

`src/core/strategy/registry.ts`：

```ts
import type { TradingSignalStrategy, TradingSignalStrategyFactory } from './types.js';
import { createMultiIndicatorTradingStrategy } from './multiIndicatorStrategy.js';

export const createStrategyFromDefinition: TradingSignalStrategyFactory = ({
  monitorSymbol,
  definition,
}): TradingSignalStrategy => {
  switch (definition.kind) {
    case 'multi-indicator': {
      return createMultiIndicatorTradingStrategy({
        monitorSymbol,
        definition,
      });
    }
  }
};
```

不要添加 `default` 分支。这样 TypeScript 能在新增 kind 时暴露未处理分支。

- [ ] **Step 2: 更新 index exports**

`src/core/strategy/index.ts` 只保留明确导出：

```ts
export { createStrategyFromDefinition } from './registry.js';
export { createMultiIndicatorTradingStrategy } from './multiIndicatorStrategy.js';
export type {
  StrategyEvaluationContext,
  TradingSignalGenerationResult,
  TradingSignalStrategy,
  TradingSignalStrategyFactory,
} from './types.js';
```

- [ ] **Step 3: 添加 registry 测试**

`tests/core/strategy/registry.business.test.ts` 验证：

- `multi-indicator` 返回可用策略。
- `getIndicatorRequirements()` 包含四动作和验证指标需求。
- 新增 kind 前没有默认吞错路径。

Run:

```bash
bun test tests/core/strategy/registry.business.test.ts
```

Expected: PASS。

### Task 5: 重写指标 profile 编译输入

**Files:**

- Modify: `src/services/indicators/profile/index.ts`
- Modify: `src/services/indicators/profile/types.ts`
- Modify: `tests/services/indicators/profile/index.business.test.ts`

- [ ] **Step 1: 改 `compileIndicatorUsageProfile` 签名**

旧：

```ts
compileIndicatorUsageProfile({
  signalConfig,
  verificationConfig,
});
```

新：

```ts
compileIndicatorUsageProfile(requirements: IndicatorRequirements)
```

- [ ] **Step 2: 删除 profile compiler 对 `SignalConfigSet` 的策略语义依赖**

`profile/index.ts` 不再遍历 `buycall/sellcall/buyput/sellput`。它只遍历：

```ts
for (const indicator of requirements.indicators) {
  collectIndicatorUsage(indicator, collector);
}
```

然后处理：

```ts
const buyVerificationIndicators = compileVerificationIndicatorList(
  requirements.verificationIndicatorsBySide.buy,
  collector,
);
```

- [ ] **Step 3: 更新 profile 测试**

测试直接构造 `IndicatorRequirements`：

```ts
const indicatorProfile = compileIndicatorUsageProfile({
  indicators: ['RSI:6', 'RSI:14', 'MFI', 'K', 'D', 'J'],
  verificationIndicatorsBySide: {
    buy: ['EMA:7', 'DIF'],
    sell: ['EMA:21', 'K'],
  },
});
```

Run:

```bash
bun test tests/services/indicators/profile/index.business.test.ts
```

Expected: PASS。

### Task 6: 改造配置解析

**Files:**

- Modify: `src/config/trading/utils.ts`
- Modify: `src/config/types.ts`
- Modify: `tests/config/tradingConfig.failfast.business.test.ts`

- [ ] **Step 1: 新增策略 kind 解析**

在 `src/config/trading/utils.ts` 增加：

```ts
function parseStrategyKind(env: NodeJS.ProcessEnv, envKey: string): StrategyKind {
  const value = getStringConfig(env, envKey);
  if (value === 'multi-indicator') {
    return value;
  }

  throw createConfigValidationError(
    `[配置错误] ${envKey} 未配置或无效（当前仅支持 multi-indicator）`,
    [envKey],
  );
}
```

- [ ] **Step 2: 新增多指标策略解析**

解析新 key：

```ts
STRATEGY_BUYCALL_N;
STRATEGY_SELLCALL_N;
STRATEGY_BUYPUT_N;
STRATEGY_SELLPUT_N;
STRATEGY_VERIFICATION_DELAY_SECONDS_BUY_N;
STRATEGY_VERIFICATION_INDICATORS_BUY_N;
STRATEGY_VERIFICATION_DELAY_SECONDS_SELL_N;
STRATEGY_VERIFICATION_INDICATORS_SELL_N;
```

验证指标解析必须 fail-fast。不要复用会警告后跳过非法值的旧 `parseVerificationIndicators(...)`，新增严格版本：

```ts
function parseStrictVerificationIndicators(
  env: NodeJS.ProcessEnv,
  envKey: string,
): ReadonlyArray<VerificationIndicator> {
  ...
  if (invalidItems.length > 0) {
    throw createConfigValidationError(
      `[配置错误] ${envKey} 包含无效验证指标: ${invalidItems.join(', ')}`,
      [envKey],
    );
  }
  return validItems;
}
```

- [ ] **Step 3: `parseMonitorConfig` 返回 `strategy`**

旧：

```ts
verificationConfig,
signalConfig,
```

新：

```ts
strategy: parseStrategyDefinition(env, suffix),
```

- [ ] **Step 4: 添加旧配置废弃测试**

测试输入：

```ts
{
  MONITOR_SYMBOL_1: 'HSI.HK',
  SIGNAL_BUYCALL_1: '(K>80)',
}
```

Expected: throw `STRATEGY_KIND_1` missing，不读取旧 `SIGNAL_BUYCALL_1`。

- [ ] **Step 5: 添加新配置成功测试**

测试输入完整 `STRATEGY_*_1`，断言：

```ts
expect(config.monitors[0]?.strategy.kind).toBe('multi-indicator');
expect(config.monitors[0]?.strategy.signals.buycall.conditionGroups).toHaveLength(1);
```

Run:

```bash
bun test tests/config/tradingConfig.failfast.business.test.ts
```

Expected: PASS。

### Task 7: 改造 app monitor context 装配

**Files:**

- Modify: `src/app/context/createMonitorContexts.ts`
- Modify: `src/app/types.ts`
- Modify: `tests/app/context/createMonitorContexts.business.test.ts`

- [ ] **Step 1: 默认策略工厂改为 registry**

```ts
import { createStrategyFromDefinition } from '../../core/strategy/index.js';

const DEFAULT_STRATEGY_FACTORY = createStrategyFromDefinition;
```

- [ ] **Step 2: 创建策略后再编译 profile**

旧：

```ts
const indicatorProfile = compileIndicatorUsageProfile({
  signalConfig: config.signalConfig,
  verificationConfig: config.verificationConfig,
});
```

新：

```ts
const strategy = strategyFactory({
  monitorSymbol: monitorConfig.monitorSymbol,
  definition: monitorConfig.strategy,
});

const indicatorProfile = compileIndicatorUsageProfile(strategy.getIndicatorRequirements());
```

注意：`createMonitorContext(...)` 需要接收已经编译好的 `indicatorProfile`，不要在内部重新创建策略或读取旧配置。

- [ ] **Step 3: 更新测试替身**

`strategyFactory` mock 改为接收：

```ts
({ monitorSymbol, definition }) => { ... }
```

测试两个 monitor 的不同 definition 被分别传入，并断言：

```ts
expect(factoryCalls).toEqual([
  { monitorSymbol: 'HSI.HK', kind: 'multi-indicator' },
  { monitorSymbol: 'HSCEI.HK', kind: 'multi-indicator' },
]);
```

Run:

```bash
bun test tests/app/context/createMonitorContexts.business.test.ts
```

Expected: PASS。

### Task 8: 改造 signal pipeline

**Files:**

- Modify: `src/main/businessEventProgram/signalPipeline.ts`
- Modify: `src/main/businessEventProgram/types.ts`
- Modify: `tests/main/businessEventProgram/signalPipeline.business.test.ts`

- [ ] **Step 1: 新策略 context 调用**

旧：

```ts
const { immediateSignals, delayedSignals } = strategy.generateSignals(
  monitorSnapshot,
  longSymbol,
  shortSymbol,
  orderRecorder,
  indicatorProfile,
);
```

新：

```ts
const { immediateSignals, delayedSignals } = strategy.generateSignals({
  monitorSymbol,
  monitorSnapshot,
  seatInfo,
  orderRecorder,
  currentTime,
});
```

- [ ] **Step 2: 延迟验证指标从策略端口读取**

旧：

```ts
const verificationIndicators = isBuyAction(prepared.action)
  ? indicatorProfile.verificationIndicatorsBySide.buy
  : indicatorProfile.verificationIndicatorsBySide.sell;
```

新：

```ts
const verificationIndicators = strategy.getVerificationIndicatorsForSignal(prepared);
```

`signalPipeline` 不再 import `isBuyAction` 仅用于验证指标选择；如果其他逻辑不需要，删除该 import。

- [ ] **Step 3: 更新测试**

测试策略替身需要实现：

```ts
strategy: {
  getIndicatorRequirements: () => createIndicatorRequirementsDouble(),
  getMaxVerificationDelaySeconds: () => 60,
  getVerificationIndicatorsForSignal: () => ['K'],
  generateSignals: () => ({
    immediateSignals: params.immediateSignals,
    delayedSignals: params.delayedSignals,
  }),
}
```

Run:

```bash
bun test tests/main/businessEventProgram/signalPipeline.business.test.ts
```

Expected: PASS。

### Task 9: 改造 indicator cache retention

**Files:**

- Modify: `src/app/runtime/createPostGateRuntime.ts`
- Test: `tests/app/runtime/createPostGateRuntime.test.ts` or existing runtime tests

- [ ] **Step 1: 从 strategy definition 推导最大延迟**

新增 helper，放在 `src/core/strategy/registry.ts` 或 `src/core/strategy/requirements.ts`：

```ts
export function getMaxVerificationDelaySecondsFromDefinition(
  definition: StrategyDefinition,
): number {
  switch (definition.kind) {
    case 'multi-indicator': {
      return Math.max(
        definition.verification.buy.delaySeconds,
        definition.verification.sell.delaySeconds,
      );
    }
  }
}
```

- [ ] **Step 2: 替换旧 `verificationConfig` 读取**

旧：

```ts
const maxDelaySeconds = Math.max(
  ...tradingConfig.monitors.map((monitorConfig) =>
    Math.max(
      monitorConfig.verificationConfig.buy.delaySeconds,
      monitorConfig.verificationConfig.sell.delaySeconds,
    ),
  ),
);
```

新：

```ts
const maxDelaySeconds = Math.max(
  ...tradingConfig.monitors.map((monitorConfig) =>
    getMaxVerificationDelaySecondsFromDefinition(monitorConfig.strategy),
  ),
);
```

- [ ] **Step 3: 添加回归测试**

构造两个 monitor：

- monitor 1 buy delay 10
- monitor 2 sell delay 90

断言 `createIndicatorCache` 收到的 retention window 基于 90 秒。若现有测试不易注入 `createIndicatorCache`，在 helper 层测试 `getMaxVerificationDelaySecondsFromDefinition(...)`。

Run:

```bash
bun test tests/app/runtime/createPostGateRuntime.test.ts tests/core/strategy/registry.business.test.ts
```

Expected: PASS。

### Task 10: 改造配置校验与启动日志

**Files:**

- Modify: `src/config/validator/types.ts`
- Modify: `src/config/validator/utils.ts`
- Modify: `src/config/validator/index.ts`
- Test: `tests/config/tradingConfig.failfast.business.test.ts`

- [ ] **Step 1: 删除 `SignalConfigKey` 对 `MonitorConfig['signalConfig']` 的依赖**

旧：

```ts
export type SignalConfigKey = keyof MonitorConfig['signalConfig'];
```

删除该类型，改由策略校验函数内部处理 `multi-indicator` 四动作。

- [ ] **Step 2: 新增 `validateStrategyDefinition(...)`**

逻辑：

```ts
switch (config.strategy.kind) {
  case 'multi-indicator':
    validate all four strategy signals
    validate verification delay and indicators
    return
}
```

四动作缺失时使用新 env key：

```text
STRATEGY_BUYCALL_N
STRATEGY_SELLCALL_N
STRATEGY_BUYPUT_N
STRATEGY_SELLPUT_N
```

- [ ] **Step 3: 更新启动日志**

旧日志：

```ts
logger.info('信号配置:');
logger.info(`BUYCALL: ${formatSignalConfig(monitorConfig.signalConfig.buycall)}`);
```

新日志：

```ts
logger.info(`策略类型: ${monitorConfig.strategy.kind}`);
if (monitorConfig.strategy.kind === 'multi-indicator') {
  logger.info('多指标策略信号配置:');
  logger.info(`BUYCALL: ${formatSignalConfig(monitorConfig.strategy.signals.buycall)}`);
  ...
}
```

验证配置日志从 `monitorConfig.strategy.verification` 读取。

- [ ] **Step 4: 运行配置测试**

Run:

```bash
bun test tests/config/tradingConfig.failfast.business.test.ts
```

Expected: PASS。

### Task 11: 更新 business event program 回归测试

**Files:**

- Modify: `tests/main/businessEventProgram/business.test.ts`
- Modify: `tests/main/businessEventProgram/indicatorPipeline.business.test.ts`
- Modify: `tests/helpers/testDoubles.ts`

- [ ] **Step 1: 更新 test double**

`createStrategyDouble(...)` 必须实现新端口：

```ts
export function createStrategyDouble(
  overrides: Partial<TradingSignalStrategy> = {},
): TradingSignalStrategy {
  return {
    getIndicatorRequirements: () => createIndicatorRequirementsDouble(),
    getMaxVerificationDelaySeconds: () => 60,
    getVerificationIndicatorsForSignal: () => ['K'],
    generateSignals: () => ({ immediateSignals: [], delayedSignals: [] }),
    ...overrides,
  };
}
```

- [ ] **Step 2: 添加 per-monitor 不交叉测试**

在 business event test 中构造两个 monitor contexts：

- `HSI.HK` strategy 输出 `BULL_HSI.HK`。
- `HSCEI.HK` strategy 输出 `BULL_HSCEI.HK`。

触发 `HSI.HK` K 线事件，只断言 `HSI` 的 strategy 被调用，`HSCEI` 未被调用。

- [ ] **Step 3: 运行测试**

Run:

```bash
bun test tests/main/businessEventProgram/business.test.ts tests/main/businessEventProgram/indicatorPipeline.business.test.ts
```

Expected: PASS。

### Task 12: 增加架构边界测试

**Files:**

- Modify: `tests/architecture/importBoundary.test.ts`
- Modify: `eslint.config.js` if existing local rule config is the right owner

- [ ] **Step 1: 禁止 main 直接 import 具体策略**

测试示例：

```ts
it('rejects main imports of concrete strategy implementations', async () => {
  const messages = await lintText(
    'src/main/businessEventProgram/signalPipeline.ts',
    "import { createMultiIndicatorTradingStrategy } from '../../core/strategy/multiIndicatorStrategy.js';\nvoid createMultiIndicatorTradingStrategy;\n",
  );

  expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
});
```

- [ ] **Step 2: 允许 app 装配层 import registry**

测试示例：

```ts
it('allows app assembly to import strategy registry', async () => {
  const messages = await lintText(
    'src/app/context/createMonitorContexts.ts',
    "import { createStrategyFromDefinition } from '../../core/strategy/index.js';\nvoid createStrategyFromDefinition;\n",
  );

  expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(false);
});
```

- [ ] **Step 3: 运行架构测试**

Run:

```bash
bun test tests/architecture/importBoundary.test.ts tests/architecture/typeOrganization.test.ts
```

Expected: PASS。

### Task 13: 清理旧字段和旧配置残留

**Files:**

- Modify: all remaining production/test references
- Modify: `README.md`

- [ ] **Step 1: 全仓搜索旧字段**

Run:

```bash
rg -n "monitorConfig\\.signalConfig|monitorConfig\\.verificationConfig|config\\.signalConfig|config\\.verificationConfig|SIGNAL_BUYCALL|SIGNAL_SELLCALL|SIGNAL_BUYPUT|SIGNAL_SELLPUT|VERIFICATION_DELAY_SECONDS|VERIFICATION_INDICATORS" src tests README.md docs
```

Expected: only historical docs under `docs/` may remain. `src`, `tests`, `README.md` should not contain active old config references except migration notes in this plan.

- [ ] **Step 2: 更新 README**

替换配置样例为：

```text
STRATEGY_KIND_1=multi-indicator
STRATEGY_BUYCALL_1=(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-20)
STRATEGY_SELLCALL_1=(RSI:6>65,K>75)
STRATEGY_BUYPUT_1=(RSI:6>75,MFI>80,D>75,J>100)/3|(J>120)
STRATEGY_SELLPUT_1=(RSI:6<35,K<25)
STRATEGY_VERIFICATION_DELAY_SECONDS_BUY_1=60
STRATEGY_VERIFICATION_INDICATORS_BUY_1=K,MACD
STRATEGY_VERIFICATION_DELAY_SECONDS_SELL_1=60
STRATEGY_VERIFICATION_INDICATORS_SELL_1=K,MACD
```

明确说明旧 `SIGNAL_*_N` 已废弃。

- [ ] **Step 3: 运行清理检查**

Run:

```bash
rg -n "signalConfig|verificationConfig" src tests
```

Expected: 仅允许策略内部类型或 `multiIndicatorStrategy` 内部变量出现，不允许作为 `MonitorConfig` 顶层字段出现。

### Task 14: 全量验证

**Files:**

- No source changes unless tests expose real issue

- [ ] **Step 1: 类型检查**

Run:

```bash
bun run typecheck
```

Expected: PASS。

- [ ] **Step 2: 架构测试**

Run:

```bash
bun test tests/architecture
```

Expected: PASS。

- [ ] **Step 3: 策略与配置测试**

Run:

```bash
bun test tests/core/strategy tests/services/indicators/profile tests/config
```

Expected: PASS。

- [ ] **Step 4: 业务事件和异步链路测试**

Run:

```bash
bun test tests/main/businessEventProgram tests/main/asyncProgram tests/app/context tests/app/runtime
```

Expected: PASS。

- [ ] **Step 5: 集成测试**

Run:

```bash
bun test tests/integration
```

Expected: PASS。

- [ ] **Step 6: 全量测试**

Run:

```bash
bun test
```

Expected: PASS。

- [ ] **Step 7: 残留进程检查**

Run:

```powershell
Get-Process bun,node,pwsh,powershell -ErrorAction SilentlyContinue |
  Select-Object Id,ProcessName,CPU,WorkingSet64,Path |
  Format-Table -AutoSize
```

Expected: no `bun` test process left from this work. Do not kill unrelated Cursor, Node, shell, or user-owned processes without attribution.

## Implementation Order

建议按以下顺序实施：

1. 类型和端口：Tasks 1-2。
2. 多指标策略迁移和 registry：Tasks 3-4。
3. 指标需求 owner 迁移：Task 5。
4. 配置解析和校验迁移：Tasks 6 and 10。
5. app 装配与 signal pipeline：Tasks 7-8。
6. indicator cache retention：Task 9。
7. 测试替身、业务事件、架构测试：Tasks 11-12。
8. 清理旧引用、README、全量验证：Tasks 13-14。

这个顺序能避免“先改运行时但 profile 仍从旧字段推导”的半迁移状态。

## Acceptance Criteria

- `MonitorConfig` 不再暴露顶层 `signalConfig` 和 `verificationConfig`。
- 每个 monitor 必须显式配置 `strategy.kind`。
- `createMonitorContexts(...)` 根据 monitor strategy definition 创建独立策略实例。
- `indicatorProfile` 从策略声明的 requirements 编译。
- `indicatorCache` 保留窗口从 strategy definition 的最大验证延迟推导。
- `runSignalPipeline(...)` 不直接读取具体策略配置，不 import 具体策略实现。
- `main/**` 不直接 import `multiIndicatorStrategy` 或其他具体策略实现。
- 旧 `SIGNAL_*_N` 和 `VERIFICATION_*_N` 不再被生产代码读取。
- README 配置样例使用新 `STRATEGY_*_N`。
- 所有现有多指标策略行为在迁移后保持业务等价。
- `bun run typecheck`、架构测试、策略测试、配置测试、业务事件测试和集成测试通过。

## Risks And Mitigations

### 风险 1：策略定义接受了未实现 kind

不得在 `StrategyKind` 中提前加入未实现策略并让配置解析通过。每个 kind 只有在具体策略实现、profile requirements、测试和文档都完成后才能加入解析白名单。

### 风险 2：策略绕过统一门禁

策略端口只返回候选信号。`ordinarySignalGuard`、seat ACTIVE、seatVersion、symbol match、延迟验证入队、买卖任务分流继续留在 `runSignalPipeline(...)`。

### 风险 3：指标需求和策略逻辑不一致

每个策略必须通过 `getIndicatorRequirements()` 声明所有信号生成和延迟验证会读取的指标。策略测试必须覆盖指标缺失时不生成信号的行为。

### 风险 4：配置迁移形成双轨

不做旧 key fallback。旧 key 只能出现在迁移说明或历史 docs，不能被生产解析读取。

### 风险 5：测试替身掩盖真实端口变化

`tests/helpers/testDoubles.ts` 的 strategy double 必须实现完整新端口，不能用 `as unknown as TradingSignalStrategy` 绕过端口变化。

## Self-Review

- Spec coverage: 覆盖了 per-monitor 策略族隔离、指标需求隔离、延迟验证保留窗口、配置 fail-fast、app/main owner 边界、共享执行链路和旧引用清理。
- Placeholder scan: passed; no placeholder-only implementation steps remain.
- Type consistency: `StrategyDefinition`、`IndicatorRequirements`、`StrategyEvaluationContext`、`TradingSignalStrategyFactory` 在各任务中命名一致。
- Scope check: 本计划只重构策略层和策略装配层，不实现新的真实交易策略族。新增策略族应在本迁移完成后以独立计划实施。
