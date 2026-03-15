# Review Report Format

## Overview

所有 reviewer 子代理与主 skill 最终汇总都必须使用同一套输出协议。reviewer 可以保留自己的分析风格，但不能自定义顶层结构。

## Reviewer Output Contract

每个 reviewer 必须返回以下结构；没有内容的 section 也应显式保留。

```markdown
## reviewer
<reviewer-name>

## scope
- target: <file/module/diff/pr>
- mode: <quick|standard|deep>

## summary
<1-3 句概括本 reviewer 的总体判断>

## critical issues
- [file:line or context]
  - issue: ...
  - why: ...
  - recommendation: ...

## major issues
- [file:line or context]
  - issue: ...
  - why: ...
  - recommendation: ...

## minor issues
- [file:line or context]
  - issue: ...
  - why: ...
  - recommendation: ...

## positive findings
- ...

## not assessed
- <dimension>: <reason>

## confidence
high | medium | low
```

## Severity Definitions

### critical
- 明显逻辑错误或高风险缺陷
- 违反核心项目约束或核心架构边界
- 关键测试缺口足以让严重回归漏过
- 高风险类型/边界问题可能导致错误行为

### major
- 重要但非立即致命的问题
- 类型设计不足导致非法状态可表示
- 关键实现边界、维护性或可读性明显受损
- 注释、测试、结构问题已足以影响后续维护或可靠性

### minor
- 非阻塞改进项
- 轻度冗余、轻度噪音或一致性问题
- 可选但合理的增强建议

## Not-Assessed Contract

`not assessed` 表示：当前 reviewer 因为上下文不足、范围不适配或证据不完整，无法给出可靠判断。

禁止使用以下模糊替代表达：

- “应该没问题”
- “看起来大概可以”
- “可能已经覆盖”
- “似乎没有死代码”

上下文不足时，必须明确写入 `not assessed`。

## Aggregation Rules for Main Skill

主 skill 在汇总时必须执行以下规则：

1. **按问题归并，而不是按 reviewer 拼接**
2. **同一问题取更高严重级别**
3. **必须保留来源 reviewer（`sources`）**
4. **缺失上下文统一进入 `not assessed`**
5. **不让 `minor issues` 淹没主要结论**

当主 skill 合并问题时，问题项必须附加：

```markdown
- sources: implementation-reviewer, type-design-reviewer
```

## Deduplication Rules

以下条件同时满足时，可视为同一问题并合并：

- 指向相同文件或相邻上下文
- 本质风险相同
- 建议方向相容

以下情况不要合并：

- 位置相同但风险不同
- 一个问题是实现正确性，另一个问题是注释误导
- 一个问题是类型不变量，另一个问题是测试覆盖缺口

## Worked Example

```markdown
## major issues
- [src/main/asyncProgram/tradeTaskQueue/types.ts:17-42]
  - issue: task type does not encode the signal-direction invariant
  - why: illegal buy/sell combinations remain representable at the type boundary
  - recommendation: narrow the task payload shape so queue direction and signal direction cannot diverge
  - sources: implementation-reviewer, type-design-reviewer

## not assessed
- test coverage: no relevant test diff or test context was provided
```

## Final Output Structure

主 skill 的最终汇总报告固定为：

```markdown
## summary

## critical issues

## major issues

## minor issues

## positive findings

## not assessed

## recommended next actions
```

`recommended next actions` 用于给出汇总后的行动建议，不是简单复制 reviewer 原始建议。

## Common Failure Modes

- 子 reviewer 自定义输出模板
- 使用评分制替代统一严重级别
- 缺上下文时不写 `not assessed`
- 主 skill 直接拼接多个 reviewer 报告而不去重
- `minor issues` 过多掩盖关键问题
- 把审查建议写成直接执行命令或修改操作
