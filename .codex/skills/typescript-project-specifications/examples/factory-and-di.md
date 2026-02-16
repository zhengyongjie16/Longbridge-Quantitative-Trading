# 工厂函数与依赖注入模式

本文展示工厂函数模式和依赖注入模式的正确写法，涵盖：
- 使用工厂函数而非类
- 所有依赖通过参数注入
- 非闭包函数提升到模块顶层

---

## 1. 工厂函数 vs 类

### ❌ 错误：基于 class 的创建

```typescript
export class OrderService {
  constructor(
    private orderRepository: OrderRepository,
    private paymentGateway: PaymentGateway,
  ) {}

  async createOrder(order: Order) {
    const validation = validateOrder(order);
    if (!validation.success) return validation;
    await this.orderRepository.save(order);
    return { success: true, data: order };
  }

  async processPayment(orderId: string, paymentInfo: PaymentInfo) {
    const order = await this.orderRepository.findById(orderId);
    if (!order) return { success: false, error: new Error('Order not found') };
    return this.paymentGateway.charge(order.total, paymentInfo);
  }
}
```

### ✅ 正确：工厂函数

```typescript
export const createOrderService = ({
  orderRepository,
  paymentGateway,
}: {
  orderRepository: OrderRepository;
  paymentGateway: PaymentGateway;
}): OrderService => {
  return {
    async createOrder(order) {
      const validation = validateOrder(order);
      if (!validation.success) return validation;
      await orderRepository.save(order);
      return { success: true, data: order };
    },
    async processPayment(orderId, paymentInfo) {
      const order = await orderRepository.findById(orderId);
      if (!order) return { success: false, error: new Error('Order not found') };
      return paymentGateway.charge(order.total, paymentInfo);
    },
  };
};
```

### 为何用工厂函数

- 与函数式风格一致
- 无 `this` 上下文问题
- 更容易组合
- 依赖注入更自然
- 测试更简单（无需 `new`）

---

## 2. 非闭包函数提升

**判断标准：函数是否引用了工厂函数作用域中的变量（注入依赖、局部变量等）**

- 引用了外层变量 → 闭包，**留在工厂函数内部**
- 仅使用自身参数 → 非闭包，**必须提升到模块顶层**

### ❌ 错误：非闭包函数放在工厂内部

```typescript
const createOrderService = ({ productRepository, orderRepository, idGenerator }: Dependencies) => {
  // ❌ calculateTotal 只使用自身参数 items，不依赖任何外层变量
  //    每次调用 createOrderService 都会重新创建此函数
  const calculateTotal = (items: ReadonlyArray<OrderItem>): number =>
    items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  // ✅ validateStock 使用了外层变量 productRepository，是真正的闭包
  const validateStock = async (productId: string, quantity: number): Promise<boolean> => {
    const product = await productRepository.findById(productId);
    return product !== null && product.stock >= quantity;
  };

  return { /* ... */ };
};
```

### ✅ 正确：非闭包函数提升到模块顶层

```typescript
// 模块顶层：不依赖任何外层变量，避免重复创建
const calculateTotal = (items: ReadonlyArray<OrderItem>): number =>
  items.reduce((sum, item) => sum + item.price * item.quantity, 0);

const createOrderService = ({ productRepository, orderRepository, idGenerator }: Dependencies) => {
  // 闭包：使用了 productRepository
  const validateStock = async (productId: string, quantity: number): Promise<boolean> => {
    const product = await productRepository.findById(productId);
    return product !== null && product.stock >= quantity;
  };

  return {
    async createOrder(items: ReadonlyArray<{ productId: string; quantity: number }>): Promise<Order> {
      // 直接调用模块顶层的 calculateTotal
      const total = calculateTotal(orderItems);
      // ...
    },
  };
};
```

---

## 3. 依赖注入：正确 vs 错误

### ❌ 错误：在内部硬编码创建依赖

```typescript
const createAuthService = () => {
  // ❌ 硬编码依赖 - 无法替换、无法测试
  const userRepo = createUserRepository();
  const hasher = createPasswordHasher();
  const tokenGen = createTokenGenerator();

  return {
    async login(credentials: LoginCredentials) { /* ... */ },
  };
};
```

### ✅ 正确：所有依赖通过参数注入

```typescript
const createAuthService = ({
  userRepository,
  passwordHasher,
  tokenGenerator,
  logger,
}: {
  userRepository: UserRepository;
  passwordHasher: PasswordHasher;
  tokenGenerator: TokenGenerator;
  logger: Logger;
}) => {
  return {
    async login(credentials: LoginCredentials): Promise<AuthToken> {
      logger.info('User login attempt', { email: credentials.email });

      const user = await userRepository.findByEmail(credentials.email);
      if (!user) throw new Error('Invalid credentials');

      const isValid = await passwordHasher.verify(credentials.password, user.passwordHash);
      if (!isValid) throw new Error('Invalid credentials');

      return tokenGenerator.generate(user.id);
    },
  };
};
```

### 使用：组装依赖并创建服务

```typescript
const authService = createAuthService({
  userRepository: createInMemoryUserRepository(),
  passwordHasher: createBcryptHasher(),
  tokenGenerator: createJwtGenerator(),
  logger: createConsoleLogger(),
});

const token = await authService.login({ email: 'test@example.com', password: '123' });
```

### 测试：轻松替换为 mock 依赖

```typescript
const authService = createAuthService({
  userRepository: { findByEmail: async (email) => ({ id: 'u1', email, passwordHash: 'h' }), save: async () => {} },
  passwordHasher: { hash: async (p) => p, verify: async () => true },
  tokenGenerator: { generate: async (id) => ({ token: `tok-${id}`, expiresAt: new Date() }) },
  logger: { info: () => {}, error: () => {} },
});
```
