# 工厂函数与依赖注入模式

本文展示工厂函数模式和依赖注入模式的正确写法，涵盖：
- 使用工厂函数而非类
- 所有依赖通过参数注入
- 非闭包函数提升到模块顶层
- 返回对象封装公共接口

---

## 1. 工厂函数基本结构

```typescript
// 依赖接口定义（契约）
interface ProductRepository {
  findById(id: string): Promise<Product | null>;
  updateStock(id: string, quantity: number): Promise<void>;
}

interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
}

interface IdGenerator {
  generate(): string;
}

// 工厂函数：通过参数注入所有依赖
const createOrderService = ({
  productRepository,
  orderRepository,
  idGenerator,
}: {
  productRepository: ProductRepository;
  orderRepository: OrderRepository;
  idGenerator: IdGenerator;
}) => {
  // 闭包内的私有函数（使用了外层依赖 productRepository）
  const validateStock = async (productId: string, quantity: number): Promise<boolean> => {
    const product = await productRepository.findById(productId);
    return product !== null && product.stock >= quantity;
  };

  // 返回公共接口
  return {
    async createOrder(items: ReadonlyArray<{ productId: string; quantity: number }>): Promise<Order> {
      for (const item of items) {
        const hasStock = await validateStock(item.productId, item.quantity);
        if (!hasStock) throw new Error(`Product ${item.productId} out of stock`);
      }
      // ... 创建订单逻辑
    },

    async getOrder(orderId: string): Promise<Order | null> {
      return orderRepository.findById(orderId);
    },
  };
};
```

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

