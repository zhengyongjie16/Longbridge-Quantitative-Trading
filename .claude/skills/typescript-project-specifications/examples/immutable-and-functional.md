# 不可变与函数式编程

本文展示不可变数据模式和函数式编程原则，涵盖：
- readonly 与 ReadonlyArray 模式
- Result 类型处理预期错误
- 纯函数与不可变更新、组合、数组方法

---

## 1. 不可变数据结构

### readonly 属性

```typescript
// ✅ 正确：不可变数据结构
type ApiRequest = {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  readonly url: string;
  readonly headers?: {
    readonly [key: string]: string;
  };
  readonly body?: unknown;
};

// ❌ 错误：可变数据结构
type ApiRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  headers?: {
    [key: string]: string;
  };
  body?: unknown;
};
```

### ReadonlyArray 与 Array

```typescript
// ✅ 正确：不可变数组
type ShoppingCart = {
  readonly id: string;
  readonly items: ReadonlyArray<CartItem>;
};

// ❌ 错误：可变数组
type ShoppingCart = {
  readonly id: string;
  readonly items: CartItem[];
};
```

---

## 2. Result 类型处理预期错误

对"预期内"的错误，优先用 `Result<T, E>` 而不是抛异常。

### 类型定义

```typescript
export type Result<T, E = Error> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: E };
```

### ❌ 错误：用异常处理预期错误

```typescript
const findUser = (userId: string): User => {
  const user = database.findById(userId);
  if (!user) {
    throw new Error('User not found'); // ❌ 调用方可能忘记 try/catch
  }
  return user;
};
```

### ✅ 正确：用 Result 类型

```typescript
const findUser = (userId: string): Result<User> => {
  const user = database.findById(userId);
  if (!user) {
    return { success: false, error: new Error('User not found') };
  }
  return { success: true, data: user };
};

// 调用方被类型系统强制处理错误
const result = findUser('u-123');
if (!result.success) {
  console.error(result.error.message);
  return;
}
console.log(result.data.name); // 类型安全
```

### 为何用 Result 类型

- 错误处理显式化（类型系统强制检查）
- 无隐藏控制流（不像异常）
- 与函数式风格一致
- 测试更简单（不必 try/catch）

---

## 3. 纯函数与不可变更新

不修改输入，始终返回新数据。适用于数组和对象。

### ❌ 错误：修改输入数据

```typescript
// 修改数组
const addItem = (items: Item[], newItem: Item): void => {
  items.push(newItem); // ❌ 修改了输入数组
};

// 修改对象
const updateUser = (user: User, updates: Partial<User>): void => {
  Object.assign(user, updates); // ❌ 修改了原对象
};
```

### ✅ 正确：返回新数据

```typescript
// 数组：展开运算创建新数组
const addItem = (
  items: ReadonlyArray<Item>,
  newItem: Item,
): ReadonlyArray<Item> => {
  return [...items, newItem];
};

// 对象：展开运算创建新对象
const updateUser = (
  user: User,
  updates: Partial<User>,
): User => {
  return { ...user, ...updates };
};
```

---

## 4. 组合优于复杂逻辑

用多个小函数组合出大逻辑，每个函数只做一件事。

### ❌ 错误：大而全的单体函数

```typescript
const createUser = (input: unknown) => {
  if (typeof input !== 'object' || !input) throw new Error('Invalid');
  if (!('email' in input)) throw new Error('Missing email');
  // ... 还有 50 行校验和注册逻辑
};
```

### ✅ 正确：组合函数

```typescript
const validate = (input: unknown) => UserSchema.parse(input);
const saveToDatabase = (user: User) => database.save(user);
const createUser = (input: unknown) => saveToDatabase(validate(input));
```

---

## 5. 数组方法替代循环

变换用 `map`、`filter`、`reduce`，声明式且天然不可变。

### ❌ 错误：命令式循环

```typescript
const activeUsers = [];
for (const u of users) {
  if (u.active) {
    activeUsers.push(u);
  }
}
```

### ✅ 正确：函数式数组方法

```typescript
const activeUsers = users.filter(u => u.active);
const userEmails = users.map(u => u.email);
const totalPrice = items.reduce((sum, item) => sum + item.price, 0);
```
