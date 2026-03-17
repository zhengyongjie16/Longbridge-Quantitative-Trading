# Code Review Skill Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写 `.claude/skills/code-review`，把它改造成手动调用的只读主编排 skill，并补齐 `reference/` 下的 reviewer 体系、路由矩阵与统一输出协议。

**Architecture:** 主 `SKILL.md` 只保留 orchestration 逻辑；七个 reviewer-spec、选择矩阵和输出协议全部放入 `reference/`。最终以真实审查场景验证新的 skill 是否具备可裁剪、只读、可汇总的行为。

**Tech Stack:** Markdown skill files, Claude Code skills, structured review protocol

---

## Chunk 1: Rewrite the main skill

### Task 1: Replace the oversized main SKILL

**Files:**

- Modify: `.claude/skills/code-review/SKILL.md`

- [ ] **Step 1: Read the old `SKILL.md` and identify sections that must be removed**
- [ ] **Step 2: Rewrite frontmatter to describe a manual orchestration entrypoint**
- [ ] **Step 3: Replace the body with a lightweight orchestration structure**
- [ ] **Step 4: Ensure the new file declares read-only limits and points to `reference/`**
- [ ] **Step 5: Verify the new `SKILL.md` no longer embeds all reviewer details**

## Chunk 2: Build the reference layer

### Task 2: Add the routing and reporting protocol files

**Files:**

- Create: `.claude/skills/code-review/reference/reviewer-selection-matrix.md`
- Create: `.claude/skills/code-review/reference/report-format.md`

- [ ] **Step 1: Write reviewer selection rules for quick / standard / deep**
- [ ] **Step 2: Add task-type adjustments and user focus adjustments**
- [ ] **Step 3: Add context gating and escalation rules**
- [ ] **Step 4: Write the unified reviewer output contract**
- [ ] **Step 5: Add aggregation, severity, deduplication, and final report rules**

### Task 3: Add the seven read-only reviewer profiles

**Files:**

- Create: `.claude/skills/code-review/reference/project-spec-reviewer.md`
- Create: `.claude/skills/code-review/reference/implementation-reviewer.md`
- Create: `.claude/skills/code-review/reference/code-simplification-reviewer.md`
- Create: `.claude/skills/code-review/reference/comment-reviewer.md`
- Create: `.claude/skills/code-review/reference/type-design-reviewer.md`
- Create: `.claude/skills/code-review/reference/dead-code-reviewer.md`
- Create: `.claude/skills/code-review/reference/test-coverage-reviewer.md`

- [ ] **Step 1: Write role, scope, and exclusions for each reviewer**
- [ ] **Step 2: Add context gating rules to each reviewer**
- [ ] **Step 3: Add explicit read-only limits to each reviewer**
- [ ] **Step 4: Ensure every reviewer points back to `report-format.md`**
- [ ] **Step 5: Verify all seven reviewers are distinct and non-overlapping enough**

## Chunk 3: Document the redesign

### Task 4: Write the redesign spec and implementation plan

**Files:**

- Create: `docs/superpowers/specs/2026-03-15-code-review-skill-redesign.md`
- Create: `docs/superpowers/plans/2026-03-15-code-review-skill-redesign.md`

- [ ] **Step 1: Write the redesign spec with goals, architecture, and read-only boundary**
- [ ] **Step 2: Write the implementation plan with chunked tasks**
- [ ] **Step 3: Verify both docs match the actual file structure and rules**

## Chunk 4: Verify the redesign

### Task 5: Validate the rewritten skill against real review scenarios

**Files:**

- Read: `.claude/skills/code-review/SKILL.md`
- Read: `.claude/skills/code-review/reference/*.md`
- Read target code samples from `src/`

- [ ] **Step 1: Check structural completeness of the new skill layout**
- [ ] **Step 2: Run at least one quick-style review scenario**
- [ ] **Step 3: Run at least one standard or deep-style review scenario**
- [ ] **Step 4: Confirm outputs can be normalized into the unified report format**
- [ ] **Step 5: Summarize remaining gaps, if any**
