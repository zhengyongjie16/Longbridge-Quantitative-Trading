# 代码风格规则

本文展示类型定义、三元表达式、函数参数、条件语句等代码风格规则。

---

## 1. 禁止重复的类型定义

不允许 `type A = B` 形式的类型别名，应直接使用原始类型 `B`。

**原因**：引入无意义的间接层，同一概念出现两个名字容易混淆。

### ❌ 错误

```typescript
// 假设 TradeStatus 和 QuoteData 已定义在某个 types.ts 中
type OrderStatus = TradeStatus; // 仅是 TradeStatus 的别名
type MarketData = QuoteData; // 仅是 QuoteData 的别名

const process = (status: OrderStatus, data: MarketData) => {
  /* ... */
};
```

### ✅ 正确

```typescript
// 直接使用原始类型
const process = (status: TradeStatus, data: QuoteData) => {
  /* ... */
};
```

---

## 2. 禁止等价的类型定义

不允许 `type A = number/string/boolean` 形式的基础类型重命名。`A` 完全等价于原始类型，TypeScript 结构化类型系统不会区分它们。

**原因**：引入虚假的"类型安全感"，实际上没有任何约束作用。语义应通过参数名表达。

### ❌ 错误

```typescript
type Price = number;
type Quantity = number;
type IsActive = boolean;

const calculateProfit = (buyPrice: Price, sellPrice: Price, qty: Quantity): Price =>
  (sellPrice - buyPrice) * qty;
```

### ✅ 正确

```typescript
// 直接使用基础类型，语义通过参数名表达
const calculateProfit = (buyPrice: number, sellPrice: number, quantity: number): number =>
  (sellPrice - buyPrice) * quantity;
```

### ⚠️ 注意区分

以下类型别名是**合理的**，因为它们封装了复合类型结构：

```typescript
type TradeSide = 'buy' | 'sell'; // 联合类型
type OrderCallback = (order: Order) => void; // 函数签名
type Nullable<T> = T | null; // 泛型工具类型
```

---

## 3. 禁止嵌套三元表达式

不允许三元运算符内部包含三元运算符。

**原因**：可读性极差，难以理解优先级和分支逻辑，修改时容易引入 bug。

### ❌ 错误

```typescript
const getAction = (signal: number): string => (signal > 0 ? 'BUY' : signal < 0 ? 'SELL' : 'HOLD');

const getLabel = (code: number): string =>
  code === 1 ? 'active' : code === 2 ? 'paused' : code === 3 ? 'error' : 'unknown';
```

### ✅ 正确方式一：if + early return

```typescript
const getAction = (signal: number): string => {
  if (signal > 0) return 'BUY';
  if (signal < 0) return 'SELL';
  return 'HOLD';
};
```

### ✅ 正确方式二：Record 映射（有限枚举值）

```typescript
const STATUS_LABELS: Readonly<Record<number, string>> = {
  1: 'active',
  2: 'paused',
  3: 'error',
};

const getLabel = (code: number): string => STATUS_LABELS[code] ?? 'unknown';
```

### ✅ 正确方式三：switch（复杂分支逻辑）

```typescript
const getRiskLevel = (score: number): string => {
  switch (true) {
    case score >= 80:
      return 'high';
    case score >= 50:
      return 'medium';
    case score >= 20:
      return 'low';
    default:
      return 'safe';
  }
};
```

---

## 4. 函数参数不超过 7 个

超过 7 个参数时必须使用对象参数（解构入参）。

**原因**：参数过多时调用者难以记住顺序，容易因位置错误导致 bug，对象参数扩展性更好。

### ❌ 错误：8 个参数

```typescript
const createOrder = (
  symbol: string,
  side: OrderSide,
  price: number,
  quantity: number,
  stopLoss: number,
  takeProfit: number,
  timeInForce: TimeInForce,
  trailingStop: number,
): void => {
  /* ... */
};

// 调用时完全看不出每个参数的含义
createOrder('AAPL', 'buy', 150, 100, 145, 160, 'day', 2);
```

### ✅ 正确：使用对象参数

```typescript
type CreateOrderParams = {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly price: number;
  readonly quantity: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly timeInForce: TimeInForce;
  readonly trailingStop: number;
};

const createOrder = ({
  symbol,
  side,
  price,
  quantity,
  stopLoss,
  takeProfit,
  timeInForce,
  trailingStop,
}: CreateOrderParams): void => {
  /* ... */
};

// 调用时每个参数含义清晰
createOrder({
  symbol: 'AAPL',
  side: 'buy',
  price: 150,
  quantity: 100,
  stopLoss: 145,
  takeProfit: 160,
  timeInForce: 'day',
  trailingStop: 2,
});
```

---

## 5. 禁止否定条件前置

在 `if-else` 语句中，`if` 条件不应使用否定表达式，应将肯定条件放在 `if` 分支。

**原因**：人脑更容易理解肯定条件，否定条件需要额外的心理反转，容易导致逻辑混乱。

**例外**：仅有 `if` 无 `else` 的 guard clause 中，否定条件是允许的。

### ❌ 错误：否定条件 + else

```typescript
if (!isValid) {
  handleError();
} else {
  executeOrder();
}

if (order.status !== 'filled') {
  retryOrder(order);
} else {
  confirmOrder(order);
}
```

### ✅ 正确：肯定条件在前

```typescript
if (isValid) {
  executeOrder();
} else {
  handleError();
}

if (order.status === 'filled') {
  confirmOrder(order);
} else {
  retryOrder(order);
}
```

### ✅ 例外：guard clause 允许否定

```typescript
const processOrder = (order: Order | null) => {
  if (!order) return; // guard clause，仅 if 无 else，允许否定
  executeOrder(order);
};
```
