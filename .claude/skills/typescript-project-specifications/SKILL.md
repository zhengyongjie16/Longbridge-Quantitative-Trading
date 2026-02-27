---
name: typescript-project-specifications
description: 编写简洁、易于维护且遵循严格规范的 TypeScript 代码。在编写、修改或重构 .ts 文件时使用。强制执行核心原则（必须遵守）。适用场景：创建新 TypeScript 文件、重构现有代码、代码审查、修复类型错误、检查代码规范、代码简化。当用户提到"写代码"、"重构"、"修改"、"检查"、"简化"、"创建文件"、"添加功能"时自动使用这个skill。
---

# TypeScript Project Specifications

## 核心原则（必须遵守）

### 类型安全

1. **禁止使用 `any`**：若类型确实未知，使用 `unknown`
2. **禁止无理由的类型断言**（`as Type`），必须有明确原因（如已通过 Schema 校验、第三方库类型不完善等）
3. **禁止无说明的 `@ts-ignore`**：若使用须在注释中说明原因
4. **严格 tsconfig 配置**：必须开启 `strict: true` 及所有额外安全选项（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 等），以上规则同时适用于测试代码与生产代码

### 基础规范

5. **文件命名**：使用小写驼峰命名（camelCase），config/ 下文件除外
6. **不可变数据**：所有类型属性使用 `readonly`，数组使用 `ReadonlyArray`，可以视情况宽容（若存在必须要修改的属性可宽容，过多的只读性会影响性能）

### 架构模式

7. **工厂函数模式**：使用工厂函数而非类来创建对象
8. **非闭包函数提升**：定义在工厂函数内部、但完全没有使用外层变量（闭包）的函数，必须移到模块顶层（outer scope），避免每次调用工厂函数时重复创建，且逻辑更清晰
9. **依赖注入模式**：所有依赖通过参数注入，永远不在内部创建
10. **对象池模式例外**：对象池类型（如 `PoolableSignal`）使用可变属性和 `| null` 标记，这是性能优化的必要例外。使用对象池对象后**必须**及时释放，嵌套对象也需要递归释放；`acquire` 后在成功、失败、提前返回等所有路径都必须有对应 `release`

### 类型与接口

11. **type vs interface 选择**：数据结构使用 `type`（配合 `readonly`），行为契约使用 `interface`（表达"实现契约"语义，支持 `implements`）
12. **禁止重复类型**：不允许 `type A = B` 形式的类型别名，应直接使用 `B`
13. **禁止等价类型**：不允许 `type Price = number` 形式的基础类型重命名，应直接使用 `number`
14. **品牌类型（Branded Types）**：可使用品牌类型对基本类型做类型安全区分（`type UserId = string & { readonly brand: unique symbol }`），与禁止等价类型不冲突——品牌类型通过交叉类型真正创建了新类型
15. **禁止内联导入**：不允许在类型注解、方法签名、参数类型等行内使用 `import('...')` 的形式（如 `import('../../types/config.js').MonitorConfig`）。所有类型必须在文件顶部通过 `import type { X } from '...'` 显式导入，在类型位置只引用已导入的类型名（如 `MonitorConfig`）

### Schema 规范

16. **Schema 单一来源**：避免在多处重复定义相同的校验逻辑，Schema 应在一处定义、到处引用，修改后自动影响所有使用处
17. **信任边界处 Schema 优先**：数据跨越信任边界（外部 → 内部）时必须用 Schema 校验；纯内部类型、Result 类型、工具类型、行为契约无需 Schema

### 代码组织

18. **类型组织**：类型定义必须放在 `types.ts` 文件中，共享类型应定义在公共的 `types.ts` 文件中（跨文件或跨模块的公共位置的 types 文件）
19. **工具函数组织**：工具函数（纯工具）定义必须放在 `utils.ts` 文件中，公共工具应定义在公共的 `utils.ts` 文件中（跨文件或跨模块的公共位置的 utils 文件），不要定义重复的工具函数，注意纯函数不应使用 create 开头命名
20. **常量组织**：常量定义统一放在 `/src/constants` 文件下，不要定义重复的常量
21. **单元测试文件位置**：单元测试文件统一放在项目根目录的 `tests/` 下，目录结构需与 `src/` 对应。例如 `src/core/trader` 的测试文件放在 `tests/core/trader` 下

### 代码风格

22. **禁止 re-export**：所有文件和代码均不允许重复导入再导出（禁止 re-export 模式）。类型、函数、常量、类等任何符号均应**直接从定义处（源模块）引用**，不得在中间文件中"转手"导出。例如：若需使用某类型或函数，应在使用处直接 `import ... from '.../源模块'`，而非 `import ... from '.../bar'` 且 bar 仅做 `export { ... } from '.../源模块'`
23. **禁止嵌套三元表达式**：不允许使用嵌套的三元运算符（三元内部包含三元），应使用 `if-else`、`switch`、`Map` 映射或提取为独立函数
24. **函数参数限制**：函数参数不允许超过 7 个，超过时必须使用对象参数（解构入参）
25. **禁止否定条件前置**：在 `if-else` 语句中，`if` 条件不应使用否定表达式（如 `!isValid`），应将肯定条件放在 `if` 分支；仅有 `if` 无 `else` 的 guard clause 除外

### 函数式编程原则

26. **纯函数优先**：无副作用（不修改外部状态），确定性（相同输入 → 相同输出），易推理、易测试、易组合
27. **不修改数据**：用展开运算做不可变更新，返回新对象/数组，而不是原地修改
28. **组合优于复杂逻辑**：用多个小函数组合出大逻辑，每个函数只做一件事
29. **数组方法替代循环**：变换用 `map`、`filter`、`reduce`，声明式且天然不可变
30. **预期错误使用 Result 类型**：对"预期内"的错误，优先用 `Result<T, E>` 而不是抛异常，错误处理显式化，类型系统强制调用方检查

### 代码质量

31. **无兼容性代码**：不要编写兼容式、补丁式和临时性的代码，必须编写完整的系统性代码
32. **无临时或多余的注释**：不要编写临时性和多余的注释，例如此次代码更新的步骤或更新的内容（与代码无关）
33. **清除无用/临时代码**：不要保留无用/无效的代码或已弃用的代码，不要保留临时的测试文件
34. **命名语义一致**：函数/方法命名必须与实际行为一致；若行为扩展导致语义变化，新增语义正确的方法后必须全规模彻底替换旧方法并完全弃用，不得保留旧方法委托链，禁止仅靠注释解释语义偏差

### 流程要求

35. **完成检查**：编写完成后**必须**运行 `bun run lint` 和 `bun run type-check` 并修复所有问题

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

## 验证检查清单

完成代码后逐项自检，按核心原则核对：

- [ ] 符合 [严格类型安全](./examples/strict-type-safety.md) 示例
- [ ] 符合 [type 与 interface](./examples/type-and-interface.md) 示例
- [ ] 符合 [不可变与函数式](./examples/immutable-and-functional.md) 示例
- [ ] 符合 [工厂函数与依赖注入](./examples/factory-and-di.md) 示例
- [ ] 符合 [对象池模式](./examples/object-pool.md) 示例（若使用对象池）
- [ ] 符合 [代码组织](./examples/code-organization-rules.md) 示例
- [ ] 符合 [Schema 组织与校验](./examples/schema-organization.md) 示例
- [ ] 符合 [代码风格规则](./examples/code-style-rules.md) 示例
- [ ] 文件命名 camelCase（config/ 下除外）
- [ ] 无 re-export，无内联 `import('...')`（类型等从源模块直接引用，顶部显式 import）
- [ ] 无兼容/临时代码与多余注释，命名与行为一致
- [ ] 已通过 `bun run lint` 与 `bun run type-check`
