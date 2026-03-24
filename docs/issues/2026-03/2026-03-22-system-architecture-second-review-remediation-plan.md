# 系统架构问题二次分析与完整修复方案

## 1. 文档目标

本文档用于对上一轮架构审计问题做二次复核，并给出可执行、分阶段、可验证的系统性修复方案。

2026-03-23 已完成并移除：P0-1、P1-2、P2-1。2026-03-22 已完成并移除：原 P0-1 / P0-2 / P0-3。本文档仅保留剩余未完成问题与后续计划。

本方案严格遵守以下约束：

1. 不做补丁式兼容层，不引入双真相。
2. 以最短路径修复架构硬伤，避免过度设计。
3. 不改变既有业务规则语义（信号、风控、下单口径保持不变）。
4. 每个阶段都必须可测试、可回归、可验收。

---

## 2. 二次分析结论（复核结果）

## 2.1 可观测性问题仍然成立

### A. 关键失败路径仍以日志为主，缺少统一故障事件层

- 主循环异常：`src/app/runApp.ts:239-241`
- 开盘重建失败：`src/main/lifecycle/dayLifecycleManager.ts:175-183`

当前可诊断性依赖人工检索日志，缺少结构化故障计数与统一升级出口。

---

## 2.2 演进耦合问题仍然成立

### A. 单文件职责仍偏重

- `src/services/autoSymbolManager/switchStateMachine.ts`（超大状态机文件）
- `src/app/types.ts`（跨装配链路大而全类型定义）

这会持续拉高理解成本与改动冲突概率。

---

## 3. 修复总目标（必须同时满足）

1. 建立最小故障观测闭环：关键故障统一事件化、可计数、可告警。
2. 降低单文件职责复杂度与长期维护成本。
3. 继续以静态约束与文档基线防止架构问题复发。

---

## 4. 不采用方案（明确排除）

1. 不采用“在调用点加 if 防御”替代依赖边界治理。
2. 不采用“只写文档规范，不加静态约束”的软治理方案。

---

## 5. 分阶段详细修复方案

## P1：可观测与演进能力治理（降长期维护成本）

### 任务 P1-1：建立最小故障观测闭环

**目标**：关键故障可计数、可聚合、可升级。

**Files**

- Create: `src/utils/observability/failureEvents.ts`
- Modify: `src/app/runApp.ts`
- Modify: `src/app/startupSnapshot.ts`
- Modify: `src/main/lifecycle/dayLifecycleManager.ts`
- Create: `tests/main/lifecycle/startupFailureState.test.ts`（补充断言）

**实施步骤**

- [ ] 建立统一故障事件模型（eventKey、severity、context）。
- [ ] 在主循环异常、启动快照失败、开盘重建失败打点统一故障事件。
- [ ] 提供最小聚合输出（按事件键计数），便于告警对接。

**验收标准**

- [ ] 三类关键失败均有结构化事件输出。
- [ ] 不改变业务分支语义，仅增强可观测数据。

---

### 任务 P1-3：超大状态机文件按职责拆分

**目标**：降低 `switchStateMachine.ts` 维护复杂度与冲突概率。

**Files**

- Create: `src/services/autoSymbolManager/switch/phases.ts`
- Create: `src/services/autoSymbolManager/switch/guards.ts`
- Create: `src/services/autoSymbolManager/switch/execution.ts`
- Modify: `src/services/autoSymbolManager/switchStateMachine.ts`
- Modify: `tests/main/processMonitor/autoSymbolTasks.business.test.ts`

**实施步骤**

- [ ] 将“阶段推进”“可触发判定”“下单执行/重试”拆分到独立文件。
- [ ] `switchStateMachine.ts` 保留 orchestrator 职责。
- [ ] 不改变状态机阶段语义与切换条件。

**验收标准**

- [ ] 业务行为等价（核心流程测试无新增失败）。
- [ ] 主文件显著缩短并只保留流程编排。

---

## P2：架构防回归机制（防止问题复发）

### 任务 P2-2：架构 ADR 固化

**Files**

- Create: `docs/architecture/adr-00x-layer-dependency-rules.md`
- Create: `docs/architecture/adr-00x-config-failfast-policy.md`
- Create: `docs/architecture/adr-00x-seat-switch-state-boundary.md`

**实施步骤**

- [ ] 固化依赖方向、配置失败策略、状态机边界原则。
- [ ] 所有后续重构以 ADR 为审查基线。

---

## 6. 测试与验证计划（全链路）

## 6.1 分阶段验证命令

### 已完成项补充验证

- `bun test tests/app/startupModes.test.ts tests/app/runApp.test.ts`
- `bun test tests/app/createMonitorContexts.business.test.ts tests/app/createMonitorContext.business.test.ts tests/core/strategy/index.test.ts`
- `bun test tests/architecture/importBoundary.test.ts`
- `bun lint`
- `bun type-check`

### P1 剩余项完成后

- `bun test tests/main/processMonitor/*.test.ts`
- `bun test tests/main/lifecycle/*.test.ts`
- `bun lint`
- `bun type-check`

### P2 剩余项完成后

- `bun lint`
- `bun test`（全量）

---

## 6.2 关键验收清单

- [x] 运行门禁不再由 `RUN_MODE` 隐式控制。
- [ ] 主循环/重建失败存在统一结构化故障事件。
- [x] 新增策略不需要改 app 主装配骨架。
- [x] 分层违规 import 可被 lint 静态拦截。

---

## 7. 变更提交策略（建议）

建议按最小可回归粒度提交：

1. `fix: decouple gate policy from run mode with strict-by-default gating`
2. `refactor: add structured failure events for critical runtime and lifecycle paths`
3. `refactor: port strategy wiring and split auto symbol switch state machine responsibilities`
4. `chore: enforce architecture import boundaries and add ADRs`

---

## 8. 完成定义（DoD）

当且仅当以下条件全部成立，判定本次架构修复完成：

1. P0/P1/P2 全部任务完成并通过测试。
2. 全量 lint 与 type-check 通过。
3. 架构约束可被静态检查拦截。
4. 二次审计中的 Critical/High 问题全部关闭。

---

## 9. 备注

本方案是“先止血、再降耦合、最后防回归”的执行路径。

它不追求一次性大重写，而是用最短路径先消除事故触发点，再把系统带回可持续演进的架构轨道。
