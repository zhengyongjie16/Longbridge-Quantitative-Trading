---
name: typescript-write-strict
description: Write clean, maintainable TypeScript code following strict standards. Use when writing, modifying, or refactoring .ts files. Enforces typescript-strict and typescript-review patterns, unified type organization, and post-write validation. Reduces patch-style code and ensures cohesive design.
---

# TypeScript Write Strict

严格遵循 TypeScript 编码规范的代码编写 skill，确保代码质量、可读性和一致性。

## 核心原则

1. **严格遵循现有规范**：所有代码必须符合 `typescript-strict` 和 `typescript-review` 的标准
2. **整体性设计**：避免"兼容性补丁"式的修改，采用清晰、统一的架构
3. **类型组织**：类型定义统一放在 `type.ts` 文件中，公共类型放在最近的共享位置
4. **双重验证**：编写完成后自动进行规范性检查

## 编写流程

### 第一步：分析现有代码

在编写或修改代码前：

1. **检查相关 type.ts 文件**
   ```bash
   # 查找现有类型定义文件
   find src -name "type.ts" -o -name "types.ts"
   ```

2. **了解现有模式**
   - 阅读相关模块的现有代码
   - 识别命名约定、代码风格
   - 查看是否有类似功能的实现

3. **确定类型定义位置**
   - 模块私有类型：`模块目录/type.ts`
   - 跨模块共享类型：最近的共同父目录下的 `type.ts`
   - 全局类型：`src/types.ts` 或 `src/types/`

### 第二步：应用 TypeScript 严格规范

**必须遵循 typescript-strict 和 typescript-review 的所有规则**，包括但不限于：

#### 类型定义
- ✅ 使用显式类型注解（函数参数、返回值、类属性）
- ✅ 避免 `any`，使用 `unknown` 或具体类型
- ✅ 使用只读类型（`readonly`、`Readonly<T>`、`as const`）
- ✅ 接口优先于类型别名（除非需要联合/交叉类型）
- ❌ 不使用 `any`、`@ts-ignore`、`@ts-expect-error`（除非有充分理由）

#### 空值处理
- ✅ 使用可选链（`?.`）和空值合并（`??`）
- ✅ 显式检查 `null` 和 `undefined`
- ✅ 使用类型守卫（type guards）
- ❌ 不使用非空断言（`!`）除非绝对确定

#### 错误处理
- ✅ 所有 Promise 必须有错误处理
- ✅ 使用 try-catch 包裹可能失败的操作
- ✅ 错误类型化（使用 `Error` 子类或自定义错误类型）

#### 函数设计
- ✅ 单一职责原则
- ✅ 纯函数优先（无副作用）
- ✅ 参数数量 ≤ 3，超过使用对象参数
- ✅ 返回值类型明确

#### 文件命名规范
- ✅ **新建 TypeScript 文件时使用小写字母开头**（如 `userService.ts`, `orderManager.ts`）
- ✅ 遵循驼峰命名法（camelCase）作为文件名
- ❌ **避免使用大写字母开头的文件名**（除非是 React 组件或特殊约定）
- ✅ 类型定义文件统一命名为 `type.ts` 或 `types.ts`
- ✅ 文件名应清晰反映文件内容和职责

### 第三步：组织类型定义

#### 模块内类型（module/type.ts）

```typescript
/**
 * 模块名称的类型定义
 * @module 模块路径
 */

// 导出接口（按字母顺序）
export interface Config {
  readonly key: string;
  readonly value: number;
}

export interface Options {
  readonly enabled: boolean;
  readonly timeout?: number;
}

// 导出类型别名
export type Status = 'pending' | 'active' | 'completed';
export type Handler = (data: unknown) => Promise<void>;

// 导出枚举（如果需要）
export enum Priority {
  Low = 0,
  Medium = 1,
  High = 2,
}
```

#### 共享类型（shared/type.ts）

```typescript
/**
 * 跨模块共享的类型定义
 * @module 共享路径
 */

// 只包含真正需要跨模块共享的类型
export interface CommonResult<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: Error;
}

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
```

### 第四步：编写清晰、简洁的代码

#### 避免"补丁式"代码

❌ **不好的做法（补丁式）**：
```typescript
// 为了兼容旧代码添加的临时逻辑
function processData(data: any) {
  // 旧逻辑
  if (data.oldField) {
    return data.oldField;
  }
  // 新逻辑（补丁）
  if (data.newField) {
    return data.newField;
  }
  // 更新的补丁
  return data.field ?? data.value ?? null;
}
```

✅ **好的做法（统一设计）**：
```typescript
interface DataInput {
  readonly field: string;
}

function processData(data: DataInput): string {
  return data.field;
}
```

#### 保持整体性

- 重构时彻底重构，不留临时代码
- 统一命名约定（驼峰、帕斯卡、常量大写）
- 统一错误处理模式
- 统一日志记录方式

#### 提高可读性

```typescript
// ✅ 好：清晰的变量名和类型
interface UserPreferences {
  readonly theme: 'light' | 'dark';
  readonly notifications: boolean;
}

function updateUserPreferences(
  userId: string,
  preferences: UserPreferences
): Promise<void> {
  // 实现
}

// ❌ 差：模糊的命名和类型
function upd(id: any, prefs: any): Promise<any> {
  // 实现
}
```

### 第五步：编写完成后进行验证

**自动触发以下检查**：

1. **运行 typescript-review skill**
   - 检查是否符合编码标准
   - 验证类型安全性
   - 检查代码风格一致性

2. **类型检查清单**
   ```
   ✓ 所有函数有明确的参数和返回值类型
   ✓ 没有使用 any（或有明确注释说明原因）
   ✓ 类型定义在正确的 type.ts 文件中
   ✓ 没有类型重复定义
   ✓ 使用了只读类型（适当时）
   ✓ 空值处理得当
   ```

3. **代码质量清单**
   ```
   ✓ 函数职责单一
   ✓ 没有"补丁式"代码
   ✓ 命名清晰、一致
   ✓ 错误处理完整
   ✓ 没有魔法数字/字符串
   ✓ 代码可读性强
   ```

4. **架构一致性清单**
   ```
   ✓ 遵循项目现有模式
   ✓ 类型组织合理
   ✓ 导入路径清晰
   ✓ 依赖关系简单
   ```

## 类型文件组织策略

### 决策树：类型应该放在哪里？

```
类型定义
│
├─ 仅在单个文件中使用？
│  └─ 定义在文件顶部（不创建 type.ts）
│
├─ 在单个模块（目录）内共享？
│  └─ 创建 module/type.ts
│
├─ 在多个相邻模块间共享？
│  └─ 创建 parent-dir/type.ts
│
└─ 全局使用（3+ 个模块）？
   └─ 定义在 src/types.ts 或 src/types/
```

### 示例项目结构

```
src/
├── types.ts                    # 全局共享类型
├── core/
│   ├── type.ts                 # core 模块共享类型
│   ├── strategy/
│   │   ├── type.ts             # strategy 专用类型
│   │   └── index.ts
│   ├── trader/
│   │   ├── type.ts             # trader 专用类型
│   │   └── index.ts
│   └── risk/
│       └── index.ts            # 仅内部使用，无 type.ts
├── services/
│   ├── type.ts                 # services 共享类型
│   └── indicators/
│       ├── type.ts             # indicators 专用类型
│       └── index.ts
└── utils/
    └── helpers.ts              # 工具函数，可能引用全局类型
```

## 实际应用示例

### 场景 1：添加新功能

**任务**：为 trader 模块添加新的订单管理功能

**步骤**：
1. 读取 `core/trader/type.ts` 了解现有类型
2. 读取 `core/trader/index.ts` 了解现有模式
3. 在 `type.ts` 中添加新类型定义
4. 在 `index.ts` 中实现功能，遵循现有模式
5. 运行验证检查

```typescript
// core/trader/type.ts - 添加类型
export interface OrderManagementConfig {
  readonly maxRetries: number;
  readonly retryDelay: number;
}

export interface OrderResult {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly timestamp: Date;
}

// core/trader/index.ts - 实现功能
import type { OrderManagementConfig, OrderResult } from './type';

export class OrderManager {
  private readonly config: OrderManagementConfig;

  constructor(config: OrderManagementConfig) {
    this.config = config;
  }

  public async submitOrder(/* ... */): Promise<OrderResult> {
    // 实现遵循现有模式
  }
}
```

### 场景 2：重构现有代码

**任务**：重构一个有"补丁式"代码的模块

**步骤**：
1. 分析现有代码，识别问题
2. 设计统一的新架构
3. 更新或创建 type.ts 文件
4. 重写实现（不是修补）
5. 验证所有调用点
6. 运行完整检查

**重构前**：
```typescript
// ❌ 补丁式代码
function calculate(input: any): any {
  if (input.type === 'old') {
    return input.value * 2; // 旧逻辑
  }
  if (input.newType) {
    return input.newValue * 3; // 补丁1
  }
  // 补丁2
  return (input.val ?? input.value ?? 0) * 2;
}
```

**重构后**：
```typescript
// type.ts
export interface CalculationInput {
  readonly value: number;
  readonly multiplier: number;
}

// index.ts
export function calculate(input: CalculationInput): number {
  return input.value * input.multiplier;
}
```

### 场景 3：跨模块类型共享

**任务**：多个模块需要共享 Signal 类型

**步骤**：
1. 识别共同父目录（如 `core/`）
2. 创建或更新 `core/type.ts`
3. 移动类型定义到共享位置
4. 更新所有导入

```typescript
// core/type.ts - 共享类型
export type SignalType = 'BUYCALL' | 'SELLCALL' | 'BUYPUT' | 'SELLPUT' | 'HOLD';

export interface Signal {
  readonly type: SignalType;
  readonly timestamp: Date;
  readonly confidence: number;
}

// core/strategy/index.ts - 使用共享类型
import type { Signal } from '../type';

// core/trader/index.ts - 使用共享类型
import type { Signal } from '../type';
```

## 验证检查列表

每次编写代码后，自动执行以下检查：

### ✅ 类型安全
- [ ] 所有函数参数有类型注解
- [ ] 所有函数返回值有类型注解
- [ ] 类的所有属性有类型注解
- [ ] 没有使用 `any`（或有充分理由）
- [ ] 没有使用非空断言 `!`（或有充分理由）
- [ ] 正确处理 `null` 和 `undefined`

### ✅ 类型组织
- [ ] 类型定义在正确的 type.ts 文件中
- [ ] 没有类型重复定义
- [ ] 导入路径清晰、正确
- [ ] 公共类型放在最近的共享位置

### ✅ 代码质量
- [ ] 函数职责单一，长度合理（< 50 行）
- [ ] 变量和函数命名清晰、一致
- [ ] 文件名使用小写字母开头（驼峰命名法）
- [ ] 没有魔法数字或字符串（使用常量）
- [ ] 错误处理完整（try-catch、Promise.catch）
- [ ] 没有"补丁式"代码
- [ ] 代码可读性强，逻辑清晰

### ✅ 架构一致性
- [ ] 遵循项目现有模式和约定
- [ ] 文件和目录结构合理
- [ ] 模块依赖关系简单清晰
- [ ] 符合 typescript-strict 规范
- [ ] 符合 typescript-review 规范

## 常见问题处理

### Q: 什么时候可以使用 `any`？
A: 极少数情况：
- 第三方库类型不完整且无法补充
- 动态 JSON 数据且无法预知结构
- **必须添加注释说明原因**

### Q: 类型定义太大怎么办？
A: 拆分到多个文件：
```
module/
├── type.ts           # 主要类型和导出
├── types/
│   ├── config.ts     # 配置相关类型
│   ├── result.ts     # 结果相关类型
│   └── internal.ts   # 内部类型（不导出）
└── index.ts
```

### Q: 如何处理循环依赖？
A:
1. 将共享类型提升到父级 type.ts
2. 使用接口而非类（接口可以前向引用）
3. 重新设计模块边界

### Q: 重构大模块的最佳实践？
A:
1. 先设计新的类型结构
2. 创建新的实现（不修改旧代码）
3. 逐步迁移调用点
4. 删除旧代码
5. 清理未使用的类型

## 与其他 Skills 的配合

- **typescript-strict**: 提供严格的类型规范，本 skill 自动应用这些规范
- **typescript-review**: 代码完成后自动调用进行审查
- **typescript-write**: 可能冲突，本 skill 是更严格的版本

## 输出格式

编写代码时，我会：

1. **分析阶段**：说明将要修改的文件和理由
2. **类型定义**：先创建或更新 type.ts 文件
3. **实现代码**：编写符合规范的实现
4. **验证报告**：展示验证检查结果
5. **总结**：列出修改的文件和关键改动

**示例输出**：

```
我将为 trader 模块添加订单重试功能：

1. 类型定义（core/trader/type.ts）
   - 添加 RetryConfig 接口
   - 添加 RetryResult 类型

2. 实现（core/trader/index.ts）
   - 添加 retryOrder 方法
   - 遵循现有错误处理模式

[编写代码...]

验证检查：
✅ 类型安全：所有函数有明确类型
✅ 类型组织：新类型在 type.ts 中
✅ 代码质量：遵循单一职责原则
✅ 架构一致性：符合现有模式

修改文件：
- core/trader/type.ts（添加 2 个类型）
- core/trader/index.ts（添加 1 个方法）
```

## 最后提醒

**编写代码前先思考，重构优于打补丁，清晰胜过聪明。**

遵循这个 skill，你的代码将：
- ✅ 类型安全、易于维护
- ✅ 结构清晰、易于理解
- ✅ 风格一致、易于协作
- ✅ 质量稳定、减少 bug
