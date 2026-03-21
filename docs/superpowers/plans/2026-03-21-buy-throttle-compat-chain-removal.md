# Buy Throttle Compat Chain Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 下线 `recordBuyAttempt / markBuyAttempt` 兼容链路，只保留“成功提交买单后通过 `updateLastBuyTime` 刷新买入频率”的真实模型。

**Architecture:** 当前主链路已经不再在风险检查阶段预占买入频率，只在 `submitFlow` 提交成功后刷新 `lastBuyTime`。本次实现按最短路径删除外露兼容入口与内部委托链，同时保留 `canTradeNow / updateLastBuyTime / resetBuyThrottle` 三个真实仍在使用的能力，并用现有 risk pipeline、buy-flow integration 与受影响的 Trader stub 测试面验证行为未变。

**Tech Stack:** TypeScript, Bun test, ESLint, tsc

---

## File Map

### 生产代码

- Modify: `src/types/services.ts`
  - 删除 `Trader.recordBuyAttempt` 契约，收敛相关注释。
- Modify: `src/core/trader/index.ts`
  - 删除 `recordBuyAttempt` 方法实现与对 `orderExecutor.markBuyAttempt` 的委托。
- Modify: `src/core/trader/types.ts`
  - 删除 `OrderExecutor.markBuyAttempt` 契约与相关注释。
- Modify: `src/core/trader/orderExecutor/types.ts`
  - 删除 `BuyThrottle.markBuyAttempt` 契约，只保留真实仍在使用的节流能力。
- Modify: `src/core/trader/orderExecutor/index.ts`
  - 删除 `markBuyAttempt` 对外返回字段。
- Modify: `src/core/trader/orderExecutor/buyThrottle.ts`
  - 删除 `markBuyAttempt` 实现与注释，保留 `canTradeNow / updateLastBuyTime / resetBuyThrottle`。
- Read for verification: `src/core/trader/orderExecutor/submitFlow.ts`
  - 核对真实更新时间仍在提交成功后调用 `updateLastBuyTime`。

### 测试与替身

- Modify: `tests/helpers/testDoubles.ts`
  - 删除 `Trader` 测试替身中的 `recordBuyAttempt` 默认实现。
- Modify: `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`
  - 删除对 `recordBuyAttempt` 计数与断言，改为验证真实业务结果（不触发 API、结果为空、原因正确、基础风险检查不进入等）。
- Modify: `tests/regression/risk-pipeline-regression.test.ts`
  - 删除对 `recordBuyAttempt` 的回归断言，保留“失败不刷新频率”的真实闭环验证。
- Modify: `tests/integration/buy-flow.integration.test.ts`
  - 删除 `createTraderDouble({ recordBuyAttempt: orderExecutor.markBuyAttempt })` 之类的兼容装配，保留 `applyRiskChecks + executeSignals + canTradeNow` 闭环验证。
- Modify: `tests/integration/liquidation-cooldown-recovery.integration.test.ts`
  - 删除显式 `recordBuyAttempt` stub 与相关计数/断言。
- Modify: `tests/integration/multi-monitor-concurrency.integration.test.ts`
  - 删除手写 `Trader` stub 中的 `recordBuyAttempt`。
- Modify: `tests/app/runApp.test.ts`
  - 删除手写 `Trader` stub 中的 `recordBuyAttempt`。

---

### Task 1: 先写行为测试，锁定真实闭环

**Files:**

- Modify: `tests/integration/buy-flow.integration.test.ts`
- Read for reference: `src/core/trader/orderExecutor/submitFlow.ts:161-209`
- Read for reference: `src/core/signalProcessor/riskCheckPipeline.ts:161-292`

- [ ] **Step 1: 写一个端到端闭环测试**

目标：先锁定真实业务语义，而不是先制造类型错误。

测试至少覆盖两个场景：

1. 第一次买入经 `applyRiskChecks -> executeSignals` 成功提交后，第二次同方向买入再次进入 `applyRiskChecks` 时被 `交易频率限制` 拦截。
2. 第一次买入若提交失败，第二次同方向买入再次进入 `applyRiskChecks` 时不应被 `交易频率限制` 拦截。

- [ ] **Step 2: 运行目标测试，确认闭环测试真实表达了目标语义**

Run: `bun test tests/integration/buy-flow.integration.test.ts` Expected: 若当前仓库尚未覆盖该闭环则 FAIL；若测试已存在或行为本就正确则 PASS。关键是确认测试确实锁定“成功提交后刷新频率、提交失败不刷新”的业务语义，而不是依赖旧兼容接口。

- [ ] **Step 3: 做最小测试实现，补足闭环验证**

要求：

- 使用现有 `signalProcessor`、`orderExecutor`、`createTradeContextMock`。
- 只验证真实业务语义：成功提交后刷新频率，失败提交不刷新。
- 不再通过 `recordBuyAttempt / markBuyAttempt` 兼容接口构造测试前提。

- [ ] **Step 4: 重新运行 buy-flow 集成测试，确认绿灯**

Run: `bun test tests/integration/buy-flow.integration.test.ts` Expected: PASS

---

### Task 2: 删除 Trader 层兼容入口

**Files:**

- Modify: `src/types/services.ts`
- Modify: `src/core/trader/index.ts`
- Modify: `tests/helpers/testDoubles.ts`
- Modify: `tests/integration/liquidation-cooldown-recovery.integration.test.ts`
- Modify: `tests/integration/multi-monitor-concurrency.integration.test.ts`
- Modify: `tests/app/runApp.test.ts`

- [ ] **Step 1: 做最小实现删除**

修改点：

- 从 `src/types/services.ts` 删除 `recordBuyAttempt` 声明与对应注释。
- 从 `src/core/trader/index.ts` 删除：

```ts
recordBuyAttempt(signalAction: SignalType, monitorConfig?: MonitorConfig | null): void {
  orderExecutor.markBuyAttempt(signalAction, monitorConfig);
},
```

- 从 `tests/helpers/testDoubles.ts` 删除默认替身：

```ts
recordBuyAttempt: () => {},
```

- 从以下测试删除手写 `Trader` stub 中的 `recordBuyAttempt`：
  - `tests/integration/liquidation-cooldown-recovery.integration.test.ts`
  - `tests/integration/multi-monitor-concurrency.integration.test.ts`
  - `tests/app/runApp.test.ts`

- [ ] **Step 2: 运行类型检查，确认 Trader 层兼容入口已彻底删除**

Run: `bun type-check` Expected: 若仍失败，失败应转移到 `OrderExecutor.markBuyAttempt` 或业务测试中对旧兼容接口的引用。

---

### Task 3: 删除 OrderExecutor / BuyThrottle 内部兼容链路

**Files:**

- Modify: `src/core/trader/types.ts`
- Modify: `src/core/trader/orderExecutor/types.ts`
- Modify: `src/core/trader/orderExecutor/index.ts`
- Modify: `src/core/trader/orderExecutor/buyThrottle.ts`

- [ ] **Step 1: 核对当前真实仍在使用的节流能力**

检查对象：

- 保留：`canTradeNow`、`updateLastBuyTime`、`resetBuyThrottle`
- 删除：`markBuyAttempt`
- 证据锚点：`src/core/trader/orderExecutor/submitFlow.ts:205`

- [ ] **Step 2: 做最小实现删除**

修改点：

- 从 `src/core/trader/types.ts` 删除 `OrderExecutor.markBuyAttempt`。
- 从 `src/core/trader/orderExecutor/types.ts` 删除 `BuyThrottle.markBuyAttempt`。
- 从 `src/core/trader/orderExecutor/index.ts` 返回对象删除：

```ts
markBuyAttempt: buyThrottle.markBuyAttempt,
```

- 从 `src/core/trader/orderExecutor/buyThrottle.ts` 删除：

```ts
function markBuyAttempt(signalAction: SignalType, monitorConfig?: MonitorConfig | null): void {
  updateLastBuyTime(signalAction, monitorConfig);
}
```

以及 return 暴露与相关注释。

- [ ] **Step 3: 运行类型检查，确认内部兼容链路已被完全移除**

Run: `bun type-check` Expected: 若仍失败，失败应只剩业务测试文件里对 `recordBuyAttempt / markBuyAttempt` 的旧断言或旧装配。

---

### Task 4: 收敛业务测试，移除兼容接口断言

**Files:**

- Modify: `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`
- Modify: `tests/regression/risk-pipeline-regression.test.ts`
- Modify: `tests/integration/liquidation-cooldown-recovery.integration.test.ts`

- [ ] **Step 1: 先运行目标测试，确认受影响测试面与兼容接口引用位置**

Run: `bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts` Expected: 记录当前结果；若失败，应定位到 `recordBuyAttempt` 相关旧断言或装配。

Run: `bun test tests/regression/risk-pipeline-regression.test.ts` Expected: 记录当前结果；若失败，应定位到 `recordBuyAttempt` 相关旧断言。

Run: `bun test tests/integration/liquidation-cooldown-recovery.integration.test.ts` Expected: 记录当前结果；若失败，应定位到手写 `recordBuyAttempt` 或相关计数/断言。

- [ ] **Step 2: 做最小测试收敛，不再测试已删除兼容接口**

调整原则：

- `riskCheckPipeline.business.test.ts`：逐条删除 `recordBuyAttemptCount` 与相关断言，但保留每个场景的真实业务不变量：
  - 轻检查失败不触发实时拉取
  - 实时拉取失败不进入基础风险检查
  - mixed buy/sell 不互相污染
- `risk-pipeline-regression.test.ts`：不能只删除 `recordBuyAttemptCount`。必须把首个回归用例改成 same-direction 的真实语义验证，确保若 risk check 阶段错误预占频率槽时该用例会稳定失败；并继续保留“失败后下一次未成功提交前不被频率限制”的真实回归语义。
- `liquidation-cooldown-recovery.integration.test.ts`：删除 `recordBuyAttempt` 相关 stub/计数，只保留恢复与冷却业务语义。

- [ ] **Step 3: 运行相关测试，确认从‘测试兼容接口’切换到‘测试真实业务语义’**

Run: `bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts` Expected: PASS

Run: `bun test tests/regression/risk-pipeline-regression.test.ts` Expected: PASS

Run: `bun test tests/integration/liquidation-cooldown-recovery.integration.test.ts` Expected: PASS

---

### Task 5: 全量验证与提交前检查

**Files:**

- Modify: `src/types/services.ts`
- Modify: `src/core/trader/index.ts`
- Modify: `src/core/trader/types.ts`
- Modify: `src/core/trader/orderExecutor/types.ts`
- Modify: `src/core/trader/orderExecutor/index.ts`
- Modify: `src/core/trader/orderExecutor/buyThrottle.ts`
- Modify: `tests/helpers/testDoubles.ts`
- Modify: `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`
- Modify: `tests/regression/risk-pipeline-regression.test.ts`
- Modify: `tests/integration/buy-flow.integration.test.ts`
- Modify: `tests/integration/liquidation-cooldown-recovery.integration.test.ts`
- Modify: `tests/integration/multi-monitor-concurrency.integration.test.ts`
- Modify: `tests/app/runApp.test.ts`

- [ ] **Step 1: 运行完整验证命令**

Run: `bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts` Expected: PASS

Run: `bun test tests/regression/risk-pipeline-regression.test.ts` Expected: PASS

Run: `bun test tests/integration/buy-flow.integration.test.ts` Expected: PASS

Run: `bun test tests/integration/liquidation-cooldown-recovery.integration.test.ts` Expected: PASS

Run: `bun test tests/integration/multi-monitor-concurrency.integration.test.ts` Expected: PASS

Run: `bun test tests/app/runApp.test.ts` Expected: PASS

Run: `bun lint` Expected: PASS

Run: `bun type-check` Expected: PASS

Run: `grep search via Grep tool for recordBuyAttempt|markBuyAttempt over repository root` Expected: 除计划文档、历史文档或明确不在本次范围的说明文本外，仓库内不再存在生产代码与测试代码残留引用。

- [ ] **Step 2: 代码审查与提交**

Run:

```bash
git diff -- src/types/services.ts src/core/trader/index.ts src/core/trader/types.ts src/core/trader/orderExecutor/types.ts src/core/trader/orderExecutor/index.ts src/core/trader/orderExecutor/buyThrottle.ts tests/helpers/testDoubles.ts tests/core/signalProcessor/riskCheckPipeline.business.test.ts tests/regression/risk-pipeline-regression.test.ts tests/integration/buy-flow.integration.test.ts tests/integration/liquidation-cooldown-recovery.integration.test.ts tests/integration/multi-monitor-concurrency.integration.test.ts tests/app/runApp.test.ts
```

Expected: 只包含兼容链路删除与测试收敛，无额外行为改动。

- [ ] **Step 3: Commit**

```bash
git add src/types/services.ts src/core/trader/index.ts src/core/trader/types.ts src/core/trader/orderExecutor/types.ts src/core/trader/orderExecutor/index.ts src/core/trader/orderExecutor/buyThrottle.ts tests/helpers/testDoubles.ts tests/core/signalProcessor/riskCheckPipeline.business.test.ts tests/regression/risk-pipeline-regression.test.ts tests/integration/buy-flow.integration.test.ts tests/integration/liquidation-cooldown-recovery.integration.test.ts tests/integration/multi-monitor-concurrency.integration.test.ts tests/app/runApp.test.ts
git commit -m "refactor: remove buy throttle compat chain"
```
