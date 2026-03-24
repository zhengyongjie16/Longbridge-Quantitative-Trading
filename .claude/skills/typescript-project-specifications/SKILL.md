---
name: typescript-project-specifications
description: Use when writing, refactoring, or reviewing TypeScript modules in this repository.
---

# TypeScript Project Specifications

## 使用边界

- 适用场景：编写 TypeScript 模块、重构 TypeScript 模块、按项目规范审查 TypeScript 代码或模块。
- 只读审查任务：按本 skill 检查适用规则是否满足，不把仅在实际改码时才要求执行的流程项误判为违规。
- 实际改码任务：除规则符合性外，还必须落实注释、代码组织与命令验证要求。

## 核心规则

### 1. 类型安全

- 禁止使用 `any`；类型确实未知时使用 `unknown`。
- 禁止无理由的类型断言（`as Type`）；只有在边界已被明确收窄时才可使用，例如已通过 Schema 校验或第三方库类型不完整。
- 禁止无说明的 `@ts-ignore`；若使用，必须在注释中说明原因。
- TypeScript 配置保持严格模式；`strict: true` 及相关安全选项同时适用于生产代码与测试代码。

### 2. 基础规范

- 文件命名使用小写驼峰命名（camelCase），`config/` 下文件除外。
- 默认使用不可变数据：类型属性使用 `readonly`，数组使用 `ReadonlyArray`；只有在确实需要可变状态的场景下才放宽，可变边界必须明确。

### 3. 架构模式

- 使用工厂函数而非类来创建对象。
- 定义在工厂函数内部、但完全不依赖外层变量的函数，必须提升到模块顶层，避免重复创建并保持逻辑清晰。
- 所有依赖通过参数注入，禁止在内部直接创建。
- 对象池类型（如 `PoolableSignal`）允许使用可变属性和 `| null`，这是性能优化的明确例外；`acquire` 后在成功、失败、提前返回等所有路径都必须对应 `release`，嵌套对象也必须递归释放。

### 4. 类型与接口

- 数据结构使用 `type`（配合 `readonly`），行为契约使用 `interface`。
- 禁止 `type A = B` 这类重复类型别名，应直接使用原类型。
- 禁止 `type Price = number` 这类基础类型等价重命名，应直接使用原始基础类型。
- 允许使用品牌类型（Branded Types）为基本类型建立真实的类型区分。
- 禁止在类型位置内联使用 `import('...')`；所有类型必须在文件顶部通过 `import type { X } from '...'` 显式导入。

### 5. Schema 规范

- Schema 必须单一来源定义，避免在多处重复维护同一套校验逻辑。
- 数据跨越信任边界（外部 → 内部）时必须优先使用 Schema 校验；纯内部类型、Result 类型、工具类型和行为契约不要求额外 Schema。

### 6. 代码组织

- `types.ts` 文件只能定义类型；只允许出现 `type`、`interface`、`import type` 与 `export type` 等类型相关定义。禁止在 `types.ts` 中定义常量、函数、Schema、类、枚举或其他任何运行时代码；共享类型放在公共的 `types.ts` 文件中。
- `utils.ts` 文件只能定义工具函数与其必要实现；禁止在 `utils.ts` 中定义 `type`、`interface` 或其他类型声明。工具函数依赖的类型必须拆到相邻 `types.ts` 或公共类型模块，并通过 `import type` 引入；公共工具放在公共的 `utils.ts` 文件中；不要定义重复工具函数，纯函数不应使用 `create` 开头命名。
- 常量统一放在 `/src/constants` 下，不要定义重复常量。
- 单元测试文件统一放在项目根目录的 `tests/` 下，目录结构需与 `src/` 对应。

### 7. 代码风格

- 禁止 re-export；所有符号都必须直接从定义处（源模块）引用。
- 禁止嵌套三元表达式；使用 `if-else`、`switch`、映射或独立函数替代。
- 函数参数不允许超过 7 个；超过时必须改为对象参数。
- 在 `if-else` 语句中，不要把否定条件放在 `if` 分支；仅有 `if` 无 `else` 的 guard clause 除外。

### 8. 函数式编程原则

- 优先编写纯函数：无副作用、相同输入得到相同输出。
- 不原地修改数据；使用不可变更新并返回新对象或新数组。
- 用多个小函数组合复杂逻辑，每个函数只做一件事。
- 变换集合时优先使用 `map`、`filter`、`reduce` 等数组方法。
- 对预期内错误优先使用 `Result<T, E>`，不要用异常替代正常分支控制。

### 9. 注释规范

- 注释语言以中文为主，专有名词保留英文。
- 新增 `.ts` 模块（除 `types.ts`、`utils.ts`、`types/`、`utils/` 下文件外）必须添加 `/** ... */` 文件头注释，描述模块名与职责/流程。
- `types.ts` / `types/` 下每个类型都必须有独立块注释，说明用途、数据来源（如适用）和使用范围。
- `utils.ts` / `utils/` 下每个工具函数都必须有完整 JSDoc，包含功能说明、`@param`、`@returns`。
- 核心业务流程、状态机迁移、风控检查、生命周期处理、异步队列处理等关键函数必须有函数注释，说明做什么、为什么，必要时补充副作用。
- 行内注释仅用于解释复杂业务判断或顺序约束，避免对显而易见的代码重复描述。
- 修改业务逻辑时必须同步更新相关注释，禁止注释与实现不一致。
- 测试注释保持轻量，重点说明场景意图、边界条件和业务期望。

### 10. 代码质量

- 禁止兼容式、补丁式和临时性代码；必须直接实现完整、正确的目标逻辑。
- 禁止临时性和多余注释，例如记录本次改动步骤或与代码无关的说明。
- 清除无用、无效、已弃用代码与临时测试文件。
- 命名必须与实际行为一致；若行为语义变化，必须用语义正确的新命名完成全量替换，不能保留旧命名委托链。

### 11. 流程要求

- 实际编写或修改 TypeScript 代码并交付结果时，必须运行（按顺序）`bun format`、 `bun lint` 和 `bun type-check`，并修复全部问题。
- 只读审查任务只对适用规则做符合性判断；命令验证要求仅在实际改码任务中生效。

## 示例文档

核心原则与代码组织的精简示例：

- [严格类型安全](./examples/strict-type-safety.md) - any/断言/@ts-ignore、tsconfig 严格配置
- [type 与 interface](./examples/type-and-interface.md) - 数据结构用 type、行为契约用 interface、品牌类型
- [不可变与函数式](./examples/immutable-and-functional.md) - readonly、Result、纯函数、数组方法
- [Schema 组织与校验](./examples/schema-organization.md) - 单一来源、信任边界校验
- [工厂函数与依赖注入](./examples/factory-and-di.md) - 工厂函数、闭包提升、依赖注入
- [对象池模式](./examples/object-pool.md) - 实现、嵌套释放、异常安全
- [代码风格规则](./examples/code-style-rules.md) - 类型、三元、参数个数、条件写法
- [代码组织](./examples/code-organization-rules.md) - types/utils/constants 放置、tests 与 src 对应
- [注释规范](./examples/comment-rules.md) - 文件头、类型注释、工具函数 JSDoc、关键函数、行内注释、测试注释

## 验证检查清单

完成任务后逐项自检，按适用范围核对：

- [ ] 符合 [严格类型安全](./examples/strict-type-safety.md) 示例
- [ ] 符合 [type 与 interface](./examples/type-and-interface.md) 示例
- [ ] 符合 [不可变与函数式](./examples/immutable-and-functional.md) 示例
- [ ] 符合 [工厂函数与依赖注入](./examples/factory-and-di.md) 示例
- [ ] 符合 [对象池模式](./examples/object-pool.md) 示例（若使用对象池）
- [ ] 符合 [代码组织](./examples/code-organization-rules.md) 示例
- [ ] `types.ts` 中无常量、函数、Schema 或其他非类型定义，`utils.ts` 中无 `type`、`interface` 或其他类型定义
- [ ] 符合 [Schema 组织与校验](./examples/schema-organization.md) 示例
- [ ] 符合 [代码风格规则](./examples/code-style-rules.md) 示例
- [ ] 符合 [注释规范](./examples/comment-rules.md) 示例（文件头、类型、工具函数、关键函数）
- [ ] 文件命名为 camelCase（`config/` 下除外）
- [ ] 无 re-export，无内联 `import('...')`（类型等从源模块直接引用，顶部显式 import）
- [ ] 无兼容/临时代码与多余注释，命名与行为一致
- [ ] 若本次任务包含实际改码，已运行且通过 `bun format`、 `bun lint` 和 `bun type-check`
