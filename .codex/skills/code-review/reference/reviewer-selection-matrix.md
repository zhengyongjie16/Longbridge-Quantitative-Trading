# Reviewer Selection Matrix

## Overview

reviewer 选择由三层共同决定：

1. `mode`
2. `task type`
3. `user focus`
4. `required context`

主 skill 先取 mode 默认集合，再按任务类型修正，最后按用户显式关注点增减 reviewer。完成选择后，必须根据本文件中的 Required Context 为每个 selected reviewer 预加载其必需上下文，然后再派发只读子代理。缺失上下文时，不强行补判断，由对应 reviewer 返回 `not assessed`。

## Default Reviewer Sets by Mode

| Mode | Default Reviewers | Optional Reviewers | Excluded by Default |
| --- | --- | --- | --- |
| `quick` | `implementation-reviewer` | `project-spec-reviewer`, `type-design-reviewer`, `comment-reviewer` | `code-simplification-reviewer`, `dead-code-reviewer`, `test-coverage-reviewer` |
| `standard` | `implementation-reviewer`, `project-spec-reviewer`, `type-design-reviewer` | `comment-reviewer`, `test-coverage-reviewer`, `code-simplification-reviewer` | `dead-code-reviewer` |
| `deep` | 全部七个 reviewer | 无 | 无 |

`deep` 固定启用以下全部 reviewer：

- `project-spec-reviewer`
- `implementation-reviewer`
- `code-simplification-reviewer`
- `comment-reviewer`
- `type-design-reviewer`
- `dead-code-reviewer`
- `test-coverage-reviewer`

## Task-Type Adjustments

| Task Type | Default Mode | Add | Avoid | Notes |
| --- | --- | --- | --- | --- |
| 单文件审查 | `quick` | `project-spec-reviewer`, `type-design-reviewer`, `comment-reviewer`（按需） | `dead-code-reviewer` 默认避免 | 若为类型密集文件，可直接升到 `standard` |
| 模块审查 | `standard` | `comment-reviewer`, `test-coverage-reviewer`, `code-simplification-reviewer`（按需） | `dead-code-reviewer` 默认避免 | 核心交易/风控/调度链路可直接升到 `deep` |
| diff / commit / PR 审查 | `standard` 或 `deep` | `test-coverage-reviewer` 通常应启；`comment-reviewer`、`code-simplification-reviewer`、`dead-code-reviewer` 按需追加 | 无 | 大改动、关键 PR 优先 `deep` |
| 注释专项审查 | `quick` | `comment-reviewer` | 其余 reviewer 默认避免 | 可按需附加 `implementation-reviewer` 提供上下文 |
| 类型专项审查 | `standard` | `type-design-reviewer` | `dead-code-reviewer`, `test-coverage-reviewer` 默认避免 | 类型密集模块可直接 `deep` |
| 死代码专项审查 | `standard` 或 `deep` | `dead-code-reviewer` | `comment-reviewer` 默认避免 | 只输出候选与证据，不执行删除 |
| 测试覆盖专项审查 | `standard` | `test-coverage-reviewer` | `dead-code-reviewer` 默认避免 | 没有测试上下文时返回 `not assessed` |
| 计划一致性审查 | `standard` | `project-spec-reviewer`, `implementation-reviewer` | `comment-reviewer` 默认避免 | 无 plan/spec 时仅做规范检查，不强做计划一致性 |

## Explicit User Focus Adjustments

| User Focus                                  | Add Reviewer                   |
| ------------------------------------------- | ------------------------------ |
| comments / 注释 / 文档                      | `comment-reviewer`             |
| types / 类型设计 / 不变量                   | `type-design-reviewer`         |
| dead code / 无用代码 / 清理导出             | `dead-code-reviewer`           |
| tests / test coverage / regression          | `test-coverage-reviewer`       |
| simplification / 简化 / 冗余 / 过度设计     | `code-simplification-reviewer` |
| project rules / CLAUDE.md / TypeScript 规范 | `project-spec-reviewer`        |

用户显式点名的 focus 优先级高于默认 mode。

## Context Gating and Not-Assessed Rules

| Reviewer | Required Context | If Missing |
| --- | --- | --- |
| `project-spec-reviewer` | `CLAUDE.md`、项目规范；若目标为 TypeScript 则还需要 `typescript-project-specifications`；若要审 plan alignment 则需要 plan/spec | 仅做可见规范审查；对缺失的计划一致性返回 `not assessed` |
| `implementation-reviewer` | 目标代码与最基本任务上下文 | 若范围不清晰，先缩小范围；仍不清晰则返回 `not assessed` |
| `code-simplification-reviewer` | 可见实现代码；最好有近期改动或明确目标范围 | 没有足够结构表面时返回 `not assessed` |
| `comment-reviewer` | 注释表面、文档性代码 | 注释极少或无注释时返回 `not assessed` |
| `type-design-reviewer` | 类型定义、接口边界、类型密集表面 | 类型设计表面不足时返回 `not assessed` |
| `dead-code-reviewer` | 可搜索使用链路、导出关系、调用证据 | 证据不足时返回 `not assessed` 或 B/C 风险结论，不给确定性删除建议 |
| `test-coverage-reviewer` | diff、测试文件、测试上下文 | 无测试上下文时返回 `not assessed` |

## Escalation and De-escalation Rules

### Escalate to `standard`

当满足任一条件时，从 `quick` 升到 `standard`：

- 涉及多个文件
- 涉及核心业务逻辑
- 用户显式提到规范、类型或测试
- 目标文件是类型密集区、流程编排层或边界层

### Escalate to `deep`

当满足任一条件时，从 `standard` 升到 `deep`：

- 用户明确要求深审
- 目标是 PR / 大 diff / 高风险重构
- 涉及核心交易、风控、状态机、异步调度链路
- 涉及 dead code 专项、高风险类型边界或测试策略变更
- 需要七个维度共同给出联合结论

### De-escalate to `quick`

当同时满足以下条件时，可从 `standard` 降到 `quick`：

- 单文件
- 低风险
- 用户没有专项要求
- 没有 plan、tests、PR 上下文
- 目标是快速扫主要风险而非完整深审

### Do Not Auto-Downgrade `deep`

用户明确要求 `deep` 时，不自动降级。
