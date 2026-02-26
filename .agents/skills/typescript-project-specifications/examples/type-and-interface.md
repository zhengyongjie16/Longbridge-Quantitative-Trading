# type 与 interface 选择

选 `type` 还是 `interface` 是架构选择，不是风格问题。本文展示：

- 数据结构 → `type`
- 行为契约 → `interface`
- 品牌类型（Branded Types）

---

## 1. 行为契约 → 用 `interface`

**何时用：** 需要"必须被实现"的契约时。

**示例：** `UserRepository`、`PaymentGateway`、`EmailService`、`CacheProvider`

### 为何用 `interface`

1. **明确表达"实现契约"**：interface 表示"必须在别处实现"
2. **TypeScript 报错更清晰**：`class X implements UserRepository` 给出明确错误
3. **符合依赖注入惯例**：契约与实现分离清晰
4. **便于用 class 实现**：class 天然实现 interface

### 示例

```typescript
// 行为契约（接口）
export interface UserRepository {
  findById(id: string): Promise<User | undefined>;
  save(user: User): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface PaymentGateway {
  charge(amount: number, paymentInfo: PaymentInfo): Promise<PaymentResult>;
  refund(transactionId: string): Promise<RefundResult>;
}

// 具体实现
export class PostgresUserRepository implements UserRepository {
  async findById(id: string): Promise<User | undefined> {
    // 实现
  }
  // ... 其他方法
}
```

---

## 2. 数据结构 → 用 `type`

**何时用：** 定义不可变数据结构时。

**示例：** `User`、`Order`、`Config`、`ApiResponse`

### 为何用 `type`

1. **突出不可变**：带 `readonly` 的 type 表示"不要改"
2. **联合、交叉、映射类型更合适**：`type Result<T, E> = Success<T> | Failure<E>`
3. **减少意外修改**：`readonly` 在类型层面保证不可变
4. **组合更灵活**：与工具类型组合更方便

### 示例

```typescript
// 数据结构（类型）
export type User = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly roles: ReadonlyArray<string>;
};

export type Order = {
  readonly id: string;
  readonly userId: string;
  readonly items: ReadonlyArray<OrderItem>;
  readonly total: number;
};
```

---

## 3. 架构对应关系

| 场景                   | 选择                | 原因             |
| ---------------------- | ------------------- | ---------------- |
| 层间边界、依赖注入契约 | `interface`         | 表达"实现契约"   |
| 数据模型、配置、响应   | `type` + `readonly` | 不可变数据       |
| 联合类型、交叉类型     | `type`              | interface 不支持 |
| 映射类型、条件类型     | `type`              | interface 不支持 |
| 函数签名类型           | `type`              | 更简洁           |

---

## 4. 品牌类型（Branded Types）

用于对基本类型做类型安全的区分。适用于同一基本类型在不同语义下不应混用的场景。

### ❌ 错误：基本类型无法区分语义

```typescript
const processPayment = (userId: string, orderId: string, amount: number) => {
  // userId 和 orderId 都是 string，编译器无法检测传参顺序错误
};

// 以下调用参数顺序错误，但编译器不会报错
processPayment(orderId, userId, amount);
```

### ✅ 正确：使用品牌类型区分

```typescript
type UserId = string & { readonly brand: unique symbol };
type OrderId = string & { readonly brand: unique symbol };
type PaymentAmount = number & { readonly brand: unique symbol };

const processPayment = (userId: UserId, orderId: OrderId, amount: PaymentAmount) => {
  // 实现
};

// ❌ 编译器报错：不能将 string 赋给 UserId
processPayment('user-123', 'order-456', 100);

// ✅ 必须使用品牌类型
const userId = 'user-123' as UserId;
const orderId = 'order-456' as OrderId;
const amount = 100 as PaymentAmount;
processPayment(userId, orderId, amount);
```

### ⚠️ 使用建议

- 适用于参数易混淆的场景（多个同类型参数）
- 不必所有基本类型都加品牌——按需使用
- 与禁止等价类型（`type Price = number`）不冲突：品牌类型通过交叉类型**真正**创建了新类型，而等价类型仅是无意义的别名
