---
name: typescript-project-specifications
description: 编写简洁、易于维护且遵循严格规范的 TypeScript 代码。在编写、修改或重构 .ts 文件时使用。强制执行：禁用 any 类型、工厂函数模式、依赖注入、readonly 不可变数据、类型安全。适用场景：创建新 TypeScript 文件、重构现有代码、代码审查 code review、修复类型错误、检查代码规范、eslint type-check。当用户提到"写代码"、"重构"、"修改"，"检查"时自动使用。
---

# TypeScript Project Specifications

严格遵循 TypeScript 编码规范的代码编写 skill，确保代码质量、可读性、类型安全和架构一致性。

## 快速开始（Quick Start）

> **💡 提示**：当你编写或修改 .ts 文件时，此 Skill 会自动激活。你也可以手动使用 `/typescript-project-specifications` 调用。

在编写或修改任何 TypeScript 代码时，请遵循以下核心原则：

1. **类型安全优先**：禁止使用 `any`，优先使用 `unknown`并减少使用断言，不允许多重断言
2. **依赖注入模式**：所有依赖通过参数注入，永远不在内部创建
3. **工厂函数模式**：使用工厂函数而非类来创建对象
4. **不可变数据**：所有类型属性使用 `readonly`，数组使用 `ReadonlyArray`
5. **清除无用代码**：不要保留无用/无效的代码或者已弃用的代码
6. **类型组织**：类型定义放在 `type.ts` 文件中，共享类型放在最近的公共位置
7. **完成检查**：在编写完成后自动运行eslint和type-check检查并修复存在的问题

## 核心规则（Core Rules）

### 1. 严格类型安全

- ✅ **禁止使用 `any`**：使用 `unknown` 替代真正未知的类型
- ✅ **避免类型断言**：除非有充分理由，否则不使用 `as Type`
- ✅ **使用 `type` 定义数据结构**：优先使用 `type` 而非 `interface`
- ✅ **保留 `interface` 用于行为契约**：仅在定义服务接口时使用

```typescript
// ✅ 正确 - 使用 type 定义数据结构
type User = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
};

// ✅ 正确 - 使用 interface 定义服务契约
interface UserRepository {
  findById(id: string): Promise<User | undefined>;
  save(user: User): Promise<void>;
}

// ❌ 错误 - 使用 any
const data: any = getData();

// ❌ 错误 - 使用 interface 定义数据
interface User {
  id: string;
  email: string;
}
```

### 2. 依赖注入模式

**所有依赖必须通过参数注入，永远不要在函数内部创建依赖。**

```typescript
// ✅ 正确 - 所有依赖都注入
export const createOrderProcessor = ({
  paymentGateway,
  orderRepository,
}: {
  paymentGateway: PaymentGateway;
  orderRepository: OrderRepository;
}): OrderProcessor => {
  return {
    processOrder(order) {
      // 使用注入的依赖
      const payment = paymentGateway.charge(order.total);
      if (!payment.success) {
        return payment;
      }
      orderRepository.save(order);
      return { success: true, data: order };
    },
  };
};

// ❌ 错误 - 在内部创建依赖
export const createOrderProcessor = ({
  paymentGateway,
}: {
  paymentGateway: PaymentGateway;
}): OrderProcessor => {
  // ❌ 硬编码实现，无法测试和替换
  const orderRepository = new InMemoryOrderRepository();
  // ...
};
```

### 3. 工厂函数模式

**使用工厂函数而非类来创建对象。**

```typescript
// ✅ 正确 - 工厂函数
export const createUserService = (
  userRepository: UserRepository,
): UserService => {
  return {
    async createUser(data) {
      const user = { ...data, id: generateId() };
      await userRepository.save(user);
      return { success: true, data: user };
    },
  };
};

// ❌ 错误 - 类模式
export class UserService {
  constructor(private userRepository: UserRepository) {}

  async createUser(data: UserData) {
    // 使用 this 上下文
  }
}
```

### 4. 不可变数据结构

**所有数据类型必须使用 `readonly`，数组使用 `ReadonlyArray`。**

```typescript
// ✅ 正确 - 不可变数据
type Order = {
  readonly id: string;
  readonly userId: string;
  readonly items: ReadonlyArray<OrderItem>;
  readonly total: number;
};

type Config = {
  readonly apiUrl: string;
  readonly timeout: number;
  readonly headers: {
    readonly [key: string]: string;
  };
};

// ❌ 错误 - 可变数据
type Order = {
  id: string;
  items: OrderItem[];
  total: number;
};
```

### 5. 类型组织

**类型定义必须放在正确的位置，避免重复和分散。**

- **模块类型**：放在该模块目录下的 `type.ts` 文件中
- **共享类型**：放在最近的公共父目录的 `type.ts` 文件中
- **全局类型**：放在 `src/types/` 目录下

```
src/
├── types/              # 全局共享类型
│   └── common.ts
├── core/
│   ├── trader/
│   │   ├── type.ts     # trader 模块的类型
│   │   └── index.ts
│   └── risk/
│       ├── type.ts     # risk 模块的类型
│       └── index.ts
```

### 6. 文件命名规范

**所有 .ts 文件必须使用小写字母开头的驼峰命名法（camelCase）。**

```
✅ 正确：
- orderProcessor.ts
- userService.ts
- type.ts
- index.ts

❌ 错误：
- OrderProcessor.ts
- UserService.ts
- Types.ts
```

### 7. 代码验证

**在代码编写完成后，必须进行规范性检查。**

所有代码必须：
- ✅ 通过 ESLint 检查
- ✅ 通过 TypeScript 编译检查（无类型错误）
- ✅ 遵循所有 typescript-strict 规范

## 编写流程（Workflow）

当你需要编写或修改 TypeScript 代码时，请按以下步骤操作：

### 步骤 1: 理解需求

- 明确要实现的功能
- 识别需要的依赖和接口
- 确定数据结构

### 步骤 2: 设计类型

先在 `type.ts` 中定义类型：

```typescript
// src/core/trader/type.ts

// 数据结构 - 使用 type
export type Order = {
  readonly id: string;
  readonly symbol: string;
  readonly quantity: number;
  readonly price: number;
};

// 服务接口 - 使用 interface
export interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | undefined>;
}

// 结果类型
export type OrderResult =
  | { readonly success: true; readonly data: Order }
  | { readonly success: false; readonly error: Error };
```

### 步骤 3: 实现工厂函数

使用依赖注入模式实现：

```typescript
// src/core/trader/index.ts
import { Order, OrderRepository, OrderResult } from './type.js';

export const createOrderService = ({
  orderRepository,
  priceValidator,
}: {
  orderRepository: OrderRepository;
  priceValidator: PriceValidator;
}) => {
  return {
    async createOrder(data: Omit<Order, 'id'>): Promise<OrderResult> {
      // 验证
      const validation = priceValidator.validate(data.price);
      if (!validation.success) {
        return validation;
      }

      // 创建订单
      const order: Order = {
        ...data,
        id: generateId(),
      };

      // 保存
      await orderRepository.save(order);

      return { success: true, data: order };
    },
  };
};
```

### 步骤 4: 验证代码

编写完成后，**自动运行检查**：

```bash
npm run lint
npm run type-check
```

**关键检查点**：
1. **类型检查**：确保没有 `any` 类型，没有多重断言
2. **依赖注入**：确保所有依赖都是注入的
3. **不可变性**：确保所有类型属性都是 `readonly`
4. **文件命名**：确保文件名符合 camelCase 规范
5. **代码清理**：移除所有无用的代码、函数、类、变量和参数
6. **修复问题**：根据 eslint 和 type-check 的输出修复所有问题

## 常见场景（Common Scenarios）

### 场景 1: 创建新服务

```typescript
// 1. 定义类型（type.ts）
export type User = {
  readonly id: string;
  readonly email: string;
};

export interface UserRepository {
  save(user: User): Promise<void>;
}

export type UserResult =
  | { readonly success: true; readonly data: User }
  | { readonly success: false; readonly error: Error };

// 2. 实现服务（index.ts）
export const createUserService = ({
  userRepository,
}: {
  userRepository: UserRepository;
}) => {
  return {
    async createUser(email: string): Promise<UserResult> {
      const user: User = { id: generateId(), email };
      await userRepository.save(user);
      return { success: true, data: user };
    },
  };
};
```

### 场景 2: 重构类到工厂函数

```typescript
// ❌ 之前：类模式
class OrderService {
  constructor(private repo: OrderRepository) {}

  async create(data: OrderData) {
    return this.repo.save(data);
  }
}

// ✅ 之后：工厂函数
export const createOrderService = ({
  orderRepository,
}: {
  orderRepository: OrderRepository;
}) => {
  return {
    async create(data: OrderData) {
      return orderRepository.save(data);
    },
  };
};
```

### 场景 3: 添加错误处理

```typescript
// 使用 Result 类型模式
export type Result<T, E = Error> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: E };

export const processPayment = (
  amount: number,
): Result<Payment> => {
  if (amount <= 0) {
    return { success: false, error: new Error('Invalid amount') };
  }

  const payment: Payment = { id: generateId(), amount };
  return { success: true, data: payment };
};
```

## 最佳实践（Best Practices）

### ✅ 推荐做法

1. **优先使用纯函数**：无副作用，相同输入产生相同输出
2. **使用函数组合**：将小函数组合成大函数
3. **使用 Result 类型处理错误**：而非抛出异常
4. **使用数组方法**：`map`、`filter`、`reduce` 而非循环
5. **避免过早优化**：先保证正确性，再优化性能

### ❌ 避免的做法

1. **不要使用 `any` 类型**：使用 `unknown` 代替
2. **不要在函数内创建依赖**：始终通过参数注入
3. **不要使用类**：使用工厂函数模式
4. **不要直接修改数据**：使用扩展运算符创建新对象
5. **不要忽略类型错误**：不要使用 `@ts-ignore`

## 详细规范

完整的 TypeScript Strict Mode 规范请参考：

📖 [TypeScript Strict Mode 详细规范](./reference/typescript-strict.md)

包含：
- 严格模式配置
- Schema 组织模式
- 依赖注入深入讲解
- Type vs Interface 选择指南
- 不可变性模式
- 函数式编程原则
- 完整检查清单

## 检查清单（Checklist）

**在完成代码编写后，必须逐项检查并运行验证命令：**

- [ ] 没有使用 `any` 类型
- [ ] 没有使用类型断言（除非有充分理由）
- [ ] 没有使用多重断言（如 `as unknown as Type`）
- [ ] 数据结构使用 `type` + `readonly`
- [ ] 服务接口使用 `interface`
- [ ] 所有依赖都通过参数注入（没有在函数内部创建依赖）
- [ ] 使用工厂函数而非类
- [ ] 数组使用 `ReadonlyArray<T>` 或 `readonly T[]`
- [ ] 类型定义放在正确的 `type.ts` 文件中
- [ ] 文件命名使用小写驼峰命名（camelCase）
- [ ] 已清理所有无用的代码、函数、类、变量和参数
- [ ] 已运行 `npm run lint` 并修复所有问题
- [ ] 已运行 `npm run type-check` 并修复所有类型错误

## 故障排除（Troubleshooting）

### 问题：TypeScript 报错 "Type 'X' is not assignable to type 'readonly X[]'"

**解决方案**：使用 `ReadonlyArray` 或 `readonly` 修饰符

```typescript
// ❌ 错误
const items: readonly Item[] = [item1, item2];

// ✅ 正确
const items: ReadonlyArray<Item> = [item1, item2];
```

### 问题：如何处理需要修改数据的情况？

**解决方案**：创建新对象而非修改原对象

```typescript
// ✅ 正确 - 创建新对象
const updatedUser = { ...user, name: newName };

// ❌ 错误 - 修改原对象
user.name = newName;
```

### 问题：工厂函数如何共享内部状态？

**解决方案**：使用闭包捕获状态

```typescript
export const createCache = () => {
  // 闭包捕获的私有状态
  const cache = new Map<string, unknown>();

  return {
    get(key: string) {
      return cache.get(key);
    },
    set(key: string, value: unknown) {
      cache.set(key, value);
    },
  };
};
```

## 总结

本 Skill 强制执行严格的 TypeScript 编码规范，确保：
- **类型安全**：零 `any` 类型，完全的类型覆盖
- **可测试性**：依赖注入使得单元测试简单
- **可维护性**：清晰的代码结构和类型组织
- **不可变性**：数据不可变，减少 bug
- **一致性**：统一的编码风格和模式
