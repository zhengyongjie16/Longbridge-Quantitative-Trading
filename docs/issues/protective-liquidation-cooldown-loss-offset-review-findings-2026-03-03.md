# 冷却切段重构复核问题清单（2026-03-03）

## 1. 文档目的

本文档用于记录对 `docs/issues/protective-liquidation-cooldown-loss-offset-redesign-2026-03-02.md` 对应重构的复核结果。
目标是明确：

1. 当前实现是否完全满足既定重构语义。
2. 已发现问题是否真实存在（含二次确认）。
3. 问题是否有修复必要性。
4. 当前测试覆盖是否足以防止该类问题回归。

---

## 2. 复核范围

本次复核覆盖以下主链路：

1. 冷却状态链路：`src/services/liquidationCooldown/index.ts`
2. 偏移分段链路：`src/core/riskController/dailyLossTracker.ts`
3. 生命周期协调链路：`src/core/riskController/lossOffsetLifecycleCoordinator/index.ts`
4. 买入风险链路：`src/core/signalProcessor/riskCheckPipeline.ts` + `src/core/riskController/index.ts`
5. 启动恢复链路：`src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts` + `src/services/liquidationCooldown/tradeLogHydrator.ts`
6. 换标刷新链路：`src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`
7. 午夜清理链路：`src/main/lifecycle/cacheDomains/riskDomain.ts`

同时执行了类型/规范与关键测试验证：

1. `bun type-check`：通过
2. `bun lint`：通过
3. 关键业务测试：通过（见第 6 节）

---

## 3. 总体结论

重构总体方向正确，核心能力已经落地：

1. `getRemainingMs` 已改为纯查询，过期清理由 `sweepExpired` 统一消费。
2. 主循环已在门禁前执行 `lossOffsetLifecycleCoordinator.sync(...)`，满足“非交易时段也要同步边界”。
3. 启动恢复顺序已调整为“先 hydrate 分段边界，再按边界回算偏移”。

但仍存在 1 个严重逻辑问题和 1 组关键测试覆盖缺口，导致目前不能判定为“完全正确且全链路闭环无风险”。

---

## 4. 发现的问题

## 4.1 严重问题：冷却过期切段后，买入风控仍可能读取旧 R1 缓存（旧偏移残留）

### 等级

严重（必须修复）

### 现象

即使冷却已经过期并完成 `dailyLossTracker.resetDirectionSegment(...)`，买入风控仍可能短时间沿用旧的 `unrealizedLossChecker` 缓存（旧 `R1`），从而出现：

1. 冷却结束后仍拒买。
2. 新周期首仓仍被旧偏移抬高成本口径。

### 关键证据

1. 切段仅发生在偏移追踪层：
   - `src/core/riskController/lossOffsetLifecycleCoordinator/index.ts:40`
   - `src/core/riskController/dailyLossTracker.ts:343`
2. 买入风控读取的是浮亏缓存层：
   - `src/core/riskController/index.ts:87`
   - `src/core/riskController/index.ts:153`
3. `syncLossOffsetLifecycle` 在买入链路执行，但未联动刷新浮亏缓存：
   - `src/core/signalProcessor/riskCheckPipeline.ts:173`
4. 浮亏缓存刷新入口存在，但未在“冷却过期切段”事件后统一触发：
   - `src/core/riskController/index.ts:380`
   - `src/core/riskController/unrealizedLossChecker.ts:112`

### 二次确认

#### 确认 1（静态链路确认）

`sync -> resetDirectionSegment` 只修改 `dailyLossTracker` 分段状态，不会主动刷新 `unrealizedLossChecker` 的 `unrealizedLossData` map。

#### 确认 2（动态实证）

已执行最小复现实验：

1. 先写入负偏移，生成 `R1 > 0` 的浮亏缓存。
2. 执行 `coordinator.sync(...)`（仅切段）。
3. 立即执行买入风控检查，仍返回 `allowed: false`。
4. 仅当显式再执行一次 `refreshUnrealizedLossData(..., dailyLossOffset=0)` 后，才恢复为 `allowed: true`。

结论：问题真实存在，且与文档目标直接冲突。

### 修复必要性评估

必须修复。理由：

1. 违反既定验收目标：
   - 冷却结束后旧段偏移不应参与买入风控。
   - 冷却结束后旧段偏移不应继续抬高浮亏口径 R1。
2. 该缺陷会导致交易可用性下降（误拒买），属于业务行为错误而非仅日志/注释问题。

---

## 4.2 重要问题：关键测试覆盖缺口，无法充分证明“全链路正确”

### 等级

重要（应修复）

### 缺口 1：`dailyLossTracker` 分段能力无独立业务测试文件

文档规划建议新增：

- `tests/core/riskController/dailyLossTracker.segment.business.test.ts`

当前仓库未找到该文件，且未发现等价覆盖组。

### 缺口 2：`liquidationCooldown` 未覆盖 `sweepExpired` 的核心语义

`tests/services/liquidationCooldown/business.test.ts` 已覆盖触发计数与基础冷却窗口，但未覆盖以下重构关键点：

1. `sweepExpired` 幂等（同一条目仅消费一次）。
2. `sweepExpired` 事件字段正确性（`cooldownEndMs`、`triggerCountAtExpire`）。
3. `getRemainingMs` 在过期前后均无状态副作用（与 `sweepExpired` 职责分离）。

### 缺口 3：`loadTradingDayRuntimeSnapshot` 未验证新顺序语义

`tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` 当前未对以下关键行为做断言：

1. `hydrateCooldownFromTradeLog = true` 时必须先 `hydrate()`。
2. `recalculateFromAllOrders(...)` 必须接收到 `segmentStartByDirection`。
3. 调用顺序必须为 `hydrate -> recalculate`。

### 修复必要性评估

应修复。理由：

1. 当前重构依赖“时序一致性”和“幂等消费”，但缺少对应自动化约束。
2. 没有这些测试，后续重构很容易把语义悄然改坏。

---

## 4.3 建议问题：注释与实现顺序不一致

### 等级

建议（可与功能修复同批处理）

### 描述

`src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts` 文件头流程描述仍保留旧顺序，和实际实现不一致。

### 证据

1. 文件头描述（旧顺序）：先初始化日内亏损，再水合冷却。
   - `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:7`
2. 实际实现（新顺序）：先 hydrate 冷却得到分段边界，再回算日内亏损。
   - `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:114`

### 修复必要性评估

建议修复。项目规范明确要求注释与实现保持一致。

---

## 5. 对业务语义的影响评估

## 5.1 已满足的语义

1. 冷却过期边界已集中到 `sweepExpired` + coordinator。
2. 换标链路本身不触发切段（与“换标不切段”语义一致）。
3. 启动恢复具备分段边界恢复能力（`segmentStartByDirection`）。

## 5.2 尚未完全闭环的语义

1. “冷却过期后旧偏移立即失效”在买入风控链路仍存在缓存残留窗口。
2. 缺少关键自动化测试证明该语义在未来不回退。

---

## 6. 已执行验证清单

以下检查与测试已执行且通过：

1. `bun type-check`
2. `bun lint`
3. `bun test tests/services/liquidationCooldown/business.test.ts`
4. `bun test tests/services/liquidationCooldown/tradeLogHydrator.business.test.ts`
5. `bun test tests/services/liquidationCooldown/utils.test.ts`
6. `bun test tests/core/riskController/lossOffsetLifecycleCoordinator.business.test.ts`
7. `bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts`
8. `bun test tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`
9. `bun test tests/main/lifecycle/cacheDomains/riskDomain.test.ts`
10. `bun test tests/integration/protective-liquidation.integration.test.ts`
11. `bun test tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`

说明：这些通过结果证明“当前代码可编译、可运行、基础场景可过”，但不等同于“目标语义全量闭环已被证明”。

---

## 7. 结论与处理建议

## 7.1 结论

当前重构为“部分完成且方向正确”，但还不能判定为“完全正确”。

## 7.2 必须处理

1. 修复“冷却过期切段后浮亏缓存残留”问题（严重）。

## 7.3 应处理

1. 补齐 `dailyLossTracker` 分段专项测试。
2. 补齐 `sweepExpired` 幂等与职责分离测试。
3. 补齐 `loadTradingDayRuntimeSnapshot` 新顺序与参数透传测试。

## 7.4 建议处理

1. 修正文档注释顺序，确保与实现一致。

---

## 8. 状态标记

- 记录时间：2026-03-03
- 记录类型：重构复核问题记录
- 当前判定：存在需修复项（严重 1、重要 1 组、建议 1）
