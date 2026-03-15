# Code Review Skill Redesign

## Goal

将现有 `.claude/skills/code-review` 从一个大一体化的专家职责文档，重构为一个**手动调用的、只读的、可裁剪的主编排 skill**。主 skill 只负责收集上下文、选择 reviewer、调度只读子代理、统一汇总输出；七个专项 reviewer 则以 `reference/` 下的 reviewer profile 形式存在，不再把所有细则堆在单个 `SKILL.md` 中。

## Core Design

### 1. Main skill as orchestration entrypoint

主 `SKILL.md` 只承担以下责任：

- 说明该 skill 是手动调用的 review 主入口
- 定义何时使用、何时不使用
- 强调所有参与者默认只读
- 定义 quick / standard / deep 三种模式
- 指向 `reference/reviewer-selection-matrix.md` 与 `reference/report-format.md`
- 规定主流程：收集输入、选 mode、选 reviewer、派发子代理、去重汇总

### 2. Reviewer profiles live in `reference/`

七个 reviewer 统一放在：

- `reference/project-spec-reviewer.md`
- `reference/implementation-reviewer.md`
- `reference/code-simplification-reviewer.md`
- `reference/comment-reviewer.md`
- `reference/type-design-reviewer.md`
- `reference/dead-code-reviewer.md`
- `reference/test-coverage-reviewer.md`

它们不是系统注册 agent，而是供主 skill 读取和注入给只读子代理的 reviewer spec。

### 3. Selection matrix and unified protocol

新增两份核心协议文件：

- `reference/reviewer-selection-matrix.md`
- `reference/report-format.md`

前者负责路由，后者负责统一输出结构与聚合规则。

## Reviewer Mode Strategy

### quick
- 默认启：`implementation-reviewer`
- 按需附加：`project-spec-reviewer`、`type-design-reviewer`、`comment-reviewer`
- 默认不开：`code-simplification-reviewer`、`dead-code-reviewer`、`test-coverage-reviewer`

### standard
- 默认启：`implementation-reviewer`、`project-spec-reviewer`、`type-design-reviewer`
- 按需附加：`comment-reviewer`、`test-coverage-reviewer`、`code-simplification-reviewer`
- 默认不开：`dead-code-reviewer`

### deep
- 启用全部七个 reviewer

## Read-Only Boundary

本次重写把“所有参与者都只读”作为硬边界：

- 主 skill 不修改代码
- 所有 reviewer 不修改代码
- `dead-code-reviewer` 不执行删除，只输出候选、证据、风险与建议
- `code-simplification-reviewer` 只提简化建议，不实施改动

## Context Gating

新体系强制支持 `not assessed`：

- 没有 plan/spec，不强行做计划一致性结论
- 没有测试上下文，不强行做测试覆盖结论
- 死代码证据不足，不输出确定性删除建议
- 注释极少或类型表面不足时，允许 reviewer 返回 `not assessed`

## Final Output Contract

所有 reviewer 与主 skill 汇总统一使用以下顶层结构：

- `summary`
- `critical issues`
- `major issues`
- `minor issues`
- `positive findings`
- `not assessed`
- `recommended next actions`

主 skill 在最终汇总时执行：

- 问题归并
- 严重级别统一
- 来源 reviewer 保留
- 重复问题去重
- `not assessed` 统一列出

## Expected Outcomes

重写完成后，`code-review` skill 应具备以下特征：

- 主入口轻量、边界清晰
- review 深度可调
- reviewer 组合可裁剪
- 所有 reviewer 只读
- 输出结构统一、易于汇总
- 不再依赖单个超长 `SKILL.md`

## Verification Plan

验证分三步：

1. **结构验证**：检查目录结构、主 skill 边界、reference 是否完整
2. **执行验证**：用真实代码文件做 quick / standard / deep 模拟审查，确认路由与 `not assessed` 行为合理
3. **质量验证**：检查输出是否遵循统一协议，是否去除了旧版的边界冲突与职责过载问题
