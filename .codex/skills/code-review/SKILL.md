---
name: code-review
description: This skill should be used when performing a structured, read-only code review of a file, module, diff, commit, or pull request, especially when the user asks to review a PR or diff, 审查一个模块或文件, 看看改动有没有问题, or coordinate multiple review perspectives from one manual entry point.
---

# Code Review

## Overview

这是一个手动调用的代码审查主入口。它不承载所有专项审查细则，而是从 `reference/` 中读取 reviewer profile、路由矩阵与统一输出协议，然后组织只读子代理完成多视角审查并汇总结果。

核心原则：**主入口负责编排，reviewer 负责分析，所有参与者都保持只读。**

## When to Use

- 你想手动发起一次结构化代码审查
- 目标是单文件、模块、diff、commit 或 PR
- 你希望统一组织实现质量、项目规范、类型设计、注释、死代码、测试覆盖等多个维度
- 你需要一个统一的最终报告，而不是多份互相重叠的 reviewer 输出

不适用：

- 直接修改、重构、删除代码
- 直接执行 dead code cleanup
- 只想做一次极轻量的口头点评且不需要编排
- 单纯实现功能而非审查

## Hard Limits

- 默认只分析，不修改任何代码、注释、配置或测试
- 所有 reviewer profile 都是只读角色，不具有执行权限
- `dead-code-reviewer` 只提供候选、证据、风险与建议，不执行删除
- 没有足够上下文时，selected reviewer 必须返回 `not assessed`，不得强行给出确定性结论
- 主 skill 负责去重、合并与统一严重级别，不能直接拼接子报告了事
- 除非用户明确要求 `deep`，否则不要默认启用全部 reviewer

## Inputs to Gather First

在启动审查前，先明确：

- 审查对象：file / module / diff / commit / PR
- 审查范围：具体路径、模块边界、提交范围
- 上下文：是否有 plan、spec、PR 描述、测试上下文
- 关注点：comments / types / dead code / tests / simplification / project rules
- 审查深度：`quick` / `standard` / `deep`
- 输出边界：默认只读、仅提供反馈

## Review Modes

| Mode | 用途 | 默认行为 |
| --- | --- | --- |
| `quick` | 单文件快速审查、低成本扫风险 | 默认聚焦实现质量，按需附加专项 reviewer |
| `standard` | 常规模块或多文件审查 | 平衡广度与成本，是默认推荐模式 |
| `deep` | 关键模块、PR 深审、高风险重构 | 启用全部七个 reviewer profile |

更详细的 reviewer 选择逻辑见 `reference/reviewer-selection-matrix.md`。

## Reviewer Selection

执行前必须先读：

- `reference/reviewer-selection-matrix.md`
- `reference/report-format.md`

然后按以下顺序选择 reviewer：

1. 先根据 `mode` 取默认 reviewer 集合
2. 再根据 task type 修正
3. 再根据用户显式关注点增减 reviewer
4. 对缺失上下文的 reviewer 使用 `not assessed`
5. 仅加载本次选中的 reviewer profile，不要把全部 reference 一次性读入

## Execution Flow

1. 明确审查对象、范围、上下文与 mode
2. 读取 `reference/reviewer-selection-matrix.md`
3. 读取 `reference/report-format.md`
4. 根据 `reference/reviewer-selection-matrix.md` 中的 Required Context，为每个 selected reviewer 预加载其必需上下文
5. 读取本次选中的 reviewer profile 文件
6. 为每个 selected reviewer 派发一个只读子代理
7. 要求每个子代理严格遵循统一输出协议
8. 收集子代理结果，合并重复问题，统一严重级别，并为每个合并问题保留 `sources`
9. 生成最终汇总报告，并明确 `not assessed` 与后续建议

## Output Contract

所有子代理与主 skill 最终输出都必须遵循统一结构。详细模板见 `reference/report-format.md`。

最终汇总报告固定包含：

- `summary`
- `critical issues`
- `major issues`
- `minor issues`
- `positive findings`
- `not assessed`
- `recommended next actions`

## Common Mistakes

- 对一个小文件默认开 `deep`
- 没有 plan 还强行做计划一致性审查
- 把 `dead-code-reviewer` 当成删除执行器
- 把 `code-simplification-reviewer` 当成改代码执行器
- 直接拼接多个 reviewer 输出而不去重
- 在上下文不足时用“应该”“大概”“看起来”替代 `not assessed`
