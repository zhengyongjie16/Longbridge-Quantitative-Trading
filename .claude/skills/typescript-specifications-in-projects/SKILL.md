---
name: typescript-specifications-in-projects
description: 编写简洁、易于维护且遵循严格规范的 TypeScript 代码。在编写、修改或重构 .ts 文件以及需要检查代码是否符合编写规范时使用。强制执行 typescript-strict 和 typescript-review 模式、统一的类型组织以及写入后验证。减少补丁式代码并确保内聚性。
---

# TypeScript Specifications in Projects

严格遵循 TypeScript 编码规范的代码编写 skill，确保代码质量、可读性、类型安全和架构一致性。

## 核心规则（Core Rules）

### 1. 类型系统基础

- ✅ **禁止 `any`** - 使用 `unknown` 代替未知类型
- ✅ **数据结构用 `type`** - 带 `readonly`，强调不可变性
- ✅ **行为契约用 `interface`** - 清晰的实现边界
- ✅ **显式类型注解** - 所有函数参数、返回值、类属性
- ✅ **不可变性优先** - `readonly` 和 `ReadonlyArray<T>`
- ❌ **禁止非空断言 `!`** - 除非绝对确定
- ❌ **禁止 `@ts-ignore`** - 除非有充分理由和注释

### 2. 架构原则

1. **依赖注入**：依赖通过参数注入，禁止在函数内创建（`new`）
2. **工厂函数**：优先使用工厂函数，避免类（class）
3. **纯函数优先**：无副作用，确定性，不可变数据
4. **单一职责**：每个函数和模块只做一件事
5. **避免补丁式代码**：统一设计，不是临时兼容
6. **类型组织**：type.ts 文件，公共类型放最近共享位置
7. **Schema 不重复**：定义在核心，单一真相来源

---

## Type vs Interface

`type` 和 `interface` 的选择是架构性的：

- **数据结构 → `type`**：不可变数据（`readonly`），联合/交叉类型，函数式编程
- **行为契约 → `interface`**：必须实现的契约，依赖注入，层之间的边界

```typescript
// ✅ 数据结构用 type
export type User = {
  readonly id: string;
  readonly email: string;
  readonly roles: ReadonlyArray<string>;
};

// ✅ 行为契约用 interface
export interface UserRepository {
  findById(id: string): Promise<User | undefined>;
  save(user: User): Promise<void>;
}
```

---

## 严格模式配置（tsconfig.json）

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "forceConsistentCasingInFileNames": true,
    "allowUnusedLabels": false
  }
}
```

**关键配置**：
- `noUncheckedIndexedAccess` - 数组/对象访问返回 `T | undefined`
- `exactOptionalPropertyTypes` - 区分 `property?: T` 和 `property: T | undefined`
- `noUnusedParameters` - 可揭示架构问题（参数属于不同层）

---

## 核心模式

### 不可变性

```typescript
// ✅ 正确
type Config = {
  readonly url: string;
  readonly headers?: { readonly [key: string]: string };
  readonly items: ReadonlyArray<Item>;
};

// ❌ 错误
type Config = {
  url: string;
  headers?: { [key: string]: string };
  items: Item[];
};
```

### Result 类型错误处理

```typescript
export type Result<T, E = Error> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: E };

export const findUser = (userId: string): Result<User> => {
  const user = database.findById(userId);
  return user
    ? { success: true, data: user }
    : { success: false, error: new Error('User not found') };
};
```

**优点**：显式错误处理、无隐藏控制流、易于测试

### 依赖注入

```typescript
// ❌ 错误 - 内部创建依赖
const createService = () => {
  const repo = new Repository(); // 硬编码！
  return { save: (data) => repo.save(data) };
};

// ✅ 正确 - 注入依赖
const createService = (repo: Repository) => {
  return { save: (data) => repo.save(data) };
};
```

**优点**：可测试、松耦合、可切换实现

### 工厂函数

```typescript
// ✅ 正确 - 工厂函数
export const createOrderService = (
  orderRepository: OrderRepository,
  paymentGateway: PaymentGateway,
): OrderService => ({
  async createOrder(order) {
    const validation = validateOrder(order);
    if (!validation.success) return validation;
    await orderRepository.save(order);
    return { success: true, data: order };
  },
});

// ❌ 避免 - 类
export class OrderService {
  constructor(private repo: Repository) {}
  async createOrder(order: Order) { /* this... */ }
}
```

**优点**：无 `this` 问题、易组合、自然依赖注入

### Schema 组织

```typescript
// ✅ 定义一次，到处导入
// src/schemas/user.ts
export const UserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});
export type User = z.infer<typeof UserSchema>;

// 各处使用
import { UserSchema } from '../schemas/user';
const validated = UserSchema.parse(input);
```

**使用时机**：
- **需要**：数据跨越信任边界、有验证规则
- **不需要**：纯内部类型、Result 类型、行为契约

### 函数式编程

```typescript
// ✅ 纯函数
const addItem = (items: ReadonlyArray<Item>, item: Item): ReadonlyArray<Item> =>
  [...items, item];

// ✅ 不可变更新
const updateUser = (user: User, updates: Partial<User>): User =>
  ({ ...user, ...updates });

// ✅ 函数组合
const validate = (input: unknown) => UserSchema.parse(input);
const save = (user: User) => database.save(user);
const createUser = (input: unknown) => save(validate(input));

// ✅ 数组方法
const activeUsers = users.filter(u => u.active);
const emails = users.map(u => u.email);
```

---

## 编写流程

### 1. 分析现有代码
- 检查 type.ts 文件：`find src -name "type.ts"`
- 了解命名约定、代码风格
- 确定类型定义位置（模块/共享/全局）

### 2. 应用严格规范
- 显式类型注解、避免 `any`、使用 `readonly`
- 数据用 `type`，契约用 `interface`
- 空值处理：`?.`、`??`、类型守卫
- 错误处理：try-catch、Result 类型
- 纯函数、依赖注入、参数 ≤ 3
- 文件名小写驼峰（`userService.ts`）

### 3. 组织类型定义

```typescript
// module/type.ts
export interface Config {
  readonly key: string;
  readonly value: number;
}

export type Status = 'pending' | 'active' | 'completed';
```

**决策树**：
- 单文件使用 → 文件顶部
- 模块内共享 → `module/type.ts`
- 跨模块共享 → `parent-dir/type.ts`
- 全局使用 → `src/types.ts`

### 4. 避免"补丁式"代码

```typescript
// ❌ 补丁式
function process(data: any) {
  if (data.oldField) return data.oldField;
  if (data.newField) return data.newField;
  return data.field ?? null;
}

// ✅ 统一设计
function process(data: { readonly field: string }): string {
  return data.field;
}
```

### 5. 验证检查

**类型安全**：
- [ ] 所有函数参数/返回值有类型注解
- [ ] 无 `any`（或有注释）、无 `!`
- [ ] `readonly`、数据用 `type`、契约用 `interface`

**代码质量**：
- [ ] 单一职责、纯函数、无副作用
- [ ] 清晰命名、无魔法值、无重复
- [ ] 完整错误处理、Result 类型

**架构一致性**：
- [ ] 依赖注入、工厂函数
- [ ] Schema 不重复、type.ts 位置正确
- [ ] 遵循项目模式

**函数式编程**：
- [ ] 不可变数据、函数组合
- [ ] 数组方法（map/filter/reduce）

---

## 实际应用示例

### 重构补丁式代码

```typescript
// ❌ 重构前
function calculate(input: any): any {
  if (input.type === 'old') return input.value * 2;
  if (input.newType) return input.newValue * 3;
  return (input.val ?? input.value ?? 0) * 2;
}

// ✅ 重构后
type CalculationInput = {
  readonly value: number;
  readonly multiplier: number;
};

const calculate = (input: CalculationInput): number =>
  input.value * input.multiplier;
```

### 跨模块类型共享

```typescript
// core/type.ts - 共享位置
export type SignalType = 'BUYCALL' | 'SELLCALL' | 'BUYPUT' | 'SELLPUT';
export type Signal = {
  readonly type: SignalType;
  readonly timestamp: Date;
};

// core/strategy/index.ts
import type { Signal } from '../type';

// core/trader/index.ts
import type { Signal } from '../type';
```

---

## 高级技巧

### Branded Types

```typescript
type UserId = string & { readonly brand: unique symbol };
type PaymentAmount = number & { readonly brand: unique symbol };

const createUserId = (id: string): UserId => {
  if (!id) throw new Error('Invalid ID');
  return id as UserId;
};

const processPayment = (userId: UserId, amount: PaymentAmount) => {
  // 编译时类型安全，防止混淆
};
```

**优点**：编译时安全、零运行时开销、强制验证

---

## 常见问题

**Q: 何时可用 `any`？**
极少数情况：第三方库类型不完整、动态 JSON 无法预知结构。必须注释说明。

**Q: 类型定义太大？**
拆分到多个文件：`type.ts`（主要）+ `types/` 目录（细分）

**Q: 循环依赖？**
1. 提升共享类型到父级 type.ts
2. 使用接口（可前向引用）
3. 重新设计模块边界

**Q: 何时用 Schema？**
需要：数据跨信任边界、有验证规则。不需要：纯内部类型、Result 类型、接口。

**Q: 为何避免类？**
工厂函数更函数式、无 `this` 问题、易测试。但某些场景（实现接口、ORM）类是合适的。

**Q: 逐步应用？**
1. 新代码严格遵循
2. 重构时改进旧代码
3. 逐步启用严格规则
4. 代码审查和培训

---

## 核心原则总结

### 类型系统
1. 禁止 `any` - 使用 `unknown`
2. 数据用 `type` + `readonly`
3. 契约用 `interface`
4. 显式类型注解

### 架构模式
5. 依赖注入 - 参数传入
6. 工厂函数 - 避免类
7. Schema 不重复 - 单一来源

### 函数式编程
8. 纯函数 - 无副作用
9. 不可变 - `readonly`
10. 函数组合 - 小函数组合
11. Result 类型 - 显式错误

### 代码质量
12. 单一职责
13. 清晰命名
14. 避免补丁
15. type.ts 组织

---

## 输出格式

编写代码时：
1. **分析**：说明修改文件和理由
2. **类型**：先更新 type.ts
3. **实现**：符合规范的代码
4. **验证**：检查清单结果
5. **总结**：修改文件列表

示例：
```
为 trader 添加订单重试：

type.ts：RetryConfig、RetryResult
index.ts：retryOrder 方法，依赖注入，Result 类型

验证：
✅ 类型安全（Result<T>、readonly）
✅ 架构（依赖注入、工厂函数）
✅ 函数式（纯函数、不可变）

修改：
- core/trader/type.ts（+2 类型）
- core/trader/index.ts（+1 方法，62 行）
```

---

## 最后提醒

**编写前先思考，重构优于补丁，清晰胜过聪明。**

遵循本 skill，代码将：
✅ 类型安全、易维护
✅ 结构清晰、易理解
✅ 风格一致、易协作
✅ 架构清洁、易测试
✅ 函数式、可组合
