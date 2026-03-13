# 保护性清仓后偏移重构全链路审查问题清单（2026-03-13）

## 1. 审查背景与目标

基于重构设计文档 `docs/issues/2026-03/2026-03-13-protective-liquidation-loss-offset-reset-redesign.md`，对当前实现做第一性原理审查：

- 不预设文档一定正确；
- 不预设当前实现一定正确；
- 以业务不变量为基准验证“保护性清仓事件完成驱动切段”是否真正落地；
- 对发现的问题进行二次确认（排除误报）后再给出修复必要性结论。

---

## 2. 业务不变量（审查基线）

本次审查以以下不变量为准：

1. `dailyLossOffset` 的分段边界必须是“保护性清仓业务事件完成”，不是冷却开始/结束。
2. 边界过滤必须是严格 `executedTimeMs > boundary`。
3. 冷却链只负责买入门禁，不负责偏移切段。
4. `liquidationCooldown = null` 以及 `liquidationTriggerLimit > 1` 且未激活冷却时，仍必须切段。
5. 同一保护性清仓事件即使拆成多笔终态订单，也只能完成一次边界推进。

---

## 3. 审查范围

### 3.1 核心代码链路

- `src/core/riskController/dailyLossTracker.ts`
- `src/core/trader/orderMonitor/settlementFlow.ts`
- `src/core/trader/protectiveLiquidationEpisodeTracker/index.ts`
- `src/main/asyncProgram/postTradeRefresher/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`
- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
- `src/services/liquidationCooldown/index.ts`
- `src/services/liquidationCooldown/tradeLogHydrator.ts`
- `src/services/liquidationCooldown/utils.ts`
- `src/app/startupSnapshot.ts`
- `src/app/rebuild.ts`
- `src/main/lifecycle/dayLifecycleManager.ts`

### 3.2 关键验证命令（已执行）

```bash
bun test "tests/core/riskController/dailyLossTracker.segment.business.test.ts" "tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts" "tests/main/asyncProgram/postTradeRefresher/business.test.ts" "tests/core/trader/orderMonitor/settlementFlow.business.test.ts" "tests/integration/protective-liquidation.integration.test.ts"
bun type-check
bun lint
```

结果：

- `bun test`：`18 pass / 0 fail`
- `bun type-check`：通过
- `bun lint`：通过

---

## 4. 总体结论

### 4.1 通过项（主链路已正确落地）

1. 保护性成交阶段只记录 episode 进度，不直接切段：`src/core/trader/orderMonitor/settlementFlow.ts:300-311`
2. 切段入口收敛到完成确认（空仓 + 无 pending protective）：`src/main/asyncProgram/postTradeRefresher/index.ts:166-180`
3. `dailyLossTracker` 使用严格边界过滤：`src/core/riskController/dailyLossTracker.ts:311-313`、`src/core/riskController/dailyLossTracker.ts:226-229`
4. 旧语义路径已退场（`lossOffsetLifecycleCoordinator / syncLossOffsetLifecycle / resetDirectionSegment` 在 `src` 无命中）。

### 4.2 综合评级

**B+**（主链路正确，但仍有会破坏业务不变量的一致性缺口）。

---

## 5. 问题清单（含二次确认与修复必要性）

## [严重-必须修复] ISSUE-01：`SEAT_REFRESH` 全量重算未显式传入保护性边界

- 证据位置：
  - `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:130-134`
  - `src/core/riskController/dailyLossTracker.ts:178-196`
  - `src/core/riskController/dailyLossTracker.ts:222-229`
- 现象：
  - `SEAT_REFRESH` 调用 `dailyLossTracker.recalculateFromAllOrders(...)` 时未显式传入 `protectionBoundaryByDirection`。
  - `dailyLossTracker` 的边界来源存在分支优先级：显式传入 > 同日沿用 > 跨日清空。该路径未显式传参会导致链路语义依赖运行时隐式状态。
- 风险：
  - 在复杂时序下可能把边界前成交重新纳入当前周期，污染 `dailyLossOffset`，从而影响浮亏风控判定。
- 二次确认（排除误报）：
  - 启动恢复链明确传入边界：`src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:223-230`。
  - 仅 `SEAT_REFRESH` 该重算链路缺少显式边界输入，存在链路不一致。
- 结论：**必须修复**。

---

## [严重-必须修复] ISSUE-02：启动快照失败后的开盘重建路径不执行 trade log 冷却恢复

- 证据位置：
  - 启动快照成功路径启用 hydrate：`src/app/startupSnapshot.ts:30-37`（`hydrateCooldownFromTradeLog: true`）
  - 启动快照失败进入 pending rebuild：`src/app/startupSnapshot.ts:45-53`
  - 开盘重建固定关闭 hydrate：`src/app/rebuild.ts:59-66`（`hydrateCooldownFromTradeLog: false`）
  - 实际 hydrate 仅在该开关为 true 时执行：`src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:150-152`
- 现象：
  - 若启动阶段快照失败，后续由生命周期触发开盘重建；但该路径固定不 hydrate trade log。
- 风险：
  - “启动失败恢复分支”与“正常启动分支”在冷却状态恢复语义上不一致，可能导致冷却状态丢失。
- 二次确认（排除误报）：
  - 全局检索 `tradeLogHydrator.hydrate()` 仅一个调用点，且受 `hydrateCooldownFromTradeLog` 开关控制。
- 结论：**必须修复**。

---

## [重要-建议修复] ISSUE-03：部分注释与实现语义存在漂移

- 证据位置（示例）：
  - `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:12-13`（“可选”描述易误读为边界恢复也可选）
  - `src/core/riskController/dailyLossTracker.ts:145,222`（注释字段与全量回算实际使用字段不完全一致）
- 风险：
  - 后续维护时容易误解切段/恢复语义，增加逻辑回退概率。
- 二次确认：
  - 注释文本与代码行为可直接对照，不是口径差异而是表达不精确。
- 结论：**建议修复**。

---

## [重要-建议修复] ISSUE-04：测试对关键契约的防回归断言仍可加强

- 缺口建议：
  1. 增加 `SEAT_REFRESH` 路径“重算必须携带保护性边界”的断言。
  2. 增加“同一保护性事件重复完成信号只计一次 trigger + 只切段一次”的跨模块约束测试。
- 风险：
  - 当前主链路虽通过，但对未来重构的约束还不够硬，仍有回归空间。
- 结论：**建议修复**。

---

## 6. 结语

本次重构在方向上是正确的，核心建模已从“冷却驱动切段”切换到“保护性清仓完成驱动切段”。

但在“链路一致性”维度仍存在两项必须修复的问题：

1. `SEAT_REFRESH` 重算边界显式传递缺失；
2. 启动失败恢复分支未执行 trade log 冷却恢复。

在上述两项修复并补齐对应防回归断言之前，不建议认定“重构已完全正确且全链路闭合”。
