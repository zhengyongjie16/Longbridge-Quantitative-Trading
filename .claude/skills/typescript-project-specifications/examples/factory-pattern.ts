/**
 * 工厂函数模式示例
 *
 * 本示例展示如何使用工厂函数而非类来创建对象，遵循以下原则：
 * 1. 使用工厂函数而非类
 * 2. 所有依赖通过参数注入
 * 3. 返回对象包含方法和状态
 * 4. 类型使用 readonly 属性
 */

// ============================================================================
// 类型定义
// ============================================================================

export type Product = {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly stock: number;
};

export type OrderItem = {
  readonly productId: string;
  readonly quantity: number;
  readonly price: number;
};

export type Order = {
  readonly id: string;
  readonly items: ReadonlyArray<OrderItem>;
  readonly totalAmount: number;
  readonly createdAt: Date;
};

// ============================================================================
// 依赖接口定义
// ============================================================================

export interface ProductRepository {
  findById(id: string): Promise<Product | null>;
  updateStock(id: string, quantity: number): Promise<void>;
}

export interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
}

export interface IdGenerator {
  generate(): string;
}

// ============================================================================
// 工厂函数实现
// ============================================================================

/**
 * 创建订单服务的工厂函数
 *
 * @example
 * const orderService = createOrderService({
 *   productRepository: myProductRepo,
 *   orderRepository: myOrderRepo,
 *   idGenerator: myIdGenerator,
 * });
 *
 * const result = await orderService.createOrder([
 *   { productId: 'p1', quantity: 2 },
 * ]);
 */
export const createOrderService = ({
  productRepository,
  orderRepository,
  idGenerator,
}: {
  productRepository: ProductRepository;
  orderRepository: OrderRepository;
  idGenerator: IdGenerator;
}) => {
  // 私有辅助函数（闭包内部）
  const calculateTotal = (items: ReadonlyArray<OrderItem>): number => {
    return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  };

  const validateStock = async (
    productId: string,
    quantity: number,
  ): Promise<boolean> => {
    const product = await productRepository.findById(productId);
    return product !== null && product.stock >= quantity;
  };

  // 返回公共接口
  return {
    /**
     * 创建订单
     */
    async createOrder(
      items: ReadonlyArray<{ productId: string; quantity: number }>,
    ): Promise<Order> {
      // 验证库存
      for (const item of items) {
        const hasStock = await validateStock(item.productId, item.quantity);
        if (!hasStock) {
          throw new Error(`Product ${item.productId} out of stock`);
        }
      }

      // 获取产品价格并构建订单项
      const orderItems: OrderItem[] = [];
      for (const item of items) {
        const product = await productRepository.findById(item.productId);
        if (!product) {
          throw new Error(`Product ${item.productId} not found`);
        }
        orderItems.push({
          productId: item.productId,
          quantity: item.quantity,
          price: product.price,
        });
      }

      // 创建订单
      const order: Order = {
        id: idGenerator.generate(),
        items: orderItems,
        totalAmount: calculateTotal(orderItems),
        createdAt: new Date(),
      };

      // 保存订单并更新库存
      await orderRepository.save(order);
      for (const item of orderItems) {
        await productRepository.updateStock(item.productId, -item.quantity);
      }

      return order;
    },

    /**
     * 获取订单详情
     */
    async getOrder(orderId: string): Promise<Order | null> {
      return orderRepository.findById(orderId);
    },

    /**
     * 计算订单总额（纯函数示例）
     */
    calculateOrderTotal(items: ReadonlyArray<OrderItem>): number {
      return calculateTotal(items);
    },
  };
};

// ============================================================================
// 使用示例
// ============================================================================

/**
 * 示例：如何使用工厂函数创建服务实例
 */
export const exampleUsage = async () => {
  // 1. 准备依赖（通常从外部注入）
  const productRepo: ProductRepository = {
    findById: async (id) => ({
      id,
      name: 'Sample Product',
      price: 100,
      stock: 50,
    }),
    updateStock: async () => {},
  };

  const orderRepo: OrderRepository = {
    save: async () => {},
    findById: async () => null,
  };

  const idGen: IdGenerator = {
    generate: () => `order-${Date.now()}`,
  };

  // 2. 使用工厂函数创建服务实例
  const orderService = createOrderService({
    productRepository: productRepo,
    orderRepository: orderRepo,
    idGenerator: idGen,
  });

  // 3. 使用服务
  const order = await orderService.createOrder([
    { productId: 'p1', quantity: 2 },
    { productId: 'p2', quantity: 1 },
  ]);

  console.log('Order created:', order.id);
  console.log('Total amount:', order.totalAmount);
};

// ============================================================================
// 关键要点
// ============================================================================

/**
 * 工厂函数模式的优势：
 *
 * 1. ✅ 依赖注入：所有依赖通过参数传入，易于测试和替换
 * 2. ✅ 封装性：私有函数在闭包内部，不暴露给外部
 * 3. ✅ 不可变性：所有类型使用 readonly，数据不可变
 * 4. ✅ 组合优于继承：通过组合依赖实现功能
 * 5. ✅ 无 this 绑定问题：不需要担心 this 上下文
 * 6. ✅ 易于测试：可以轻松 mock 依赖进行单元测试
 *
 * 对比类的实现：
 * ❌ 类需要 new 关键字
 * ❌ 类的依赖通常在构造函数中创建（违反依赖注入）
 * ❌ 类的方法需要绑定 this
 * ❌ 类的私有方法需要 private 关键字（TypeScript 特性）
 */
