---
name: typescript-project-specifications
description: 编写简洁、易于维护且遵循严格规范的 TypeScript 代码。在编写、修改或重构 .ts 文件时使用。强制执行核心原则（必须遵守）。适用场景：创建新 TypeScript 文件、重构现有代码、代码审查、修复类型错误、检查代码规范、代码简化、eslint 和 type-check。当用户提到"写代码"、"重构"、"修改"、"检查"、"简化"、"创建文件"、"添加功能"时自动使用这个skill。
---

# TypeScript Project Specifications

## 核心原则（必须遵守）

1. **严格的ts编写**：必须完全遵守[typescript-strict文档](./reference/typescript-strict.md)
2. **文件命名**：使用小写驼峰命名（camelCase）
3. **依赖注入模式**：所有依赖通过参数注入，永远不在内部创建
4. **工厂函数模式**：使用工厂函数而非类来创建对象
5. **不可变数据**：所有类型属性使用 `readonly`，数组使用 `ReadonlyArray`，可以视情况宽容（若存在必须要修改的属性可宽容，过多的只读性会影响性能）
6. **无兼容性代码**：不要编写兼容式、补丁式和临时性的代码，必须编写完整的系统性代码
7. **清除无用代码**：不要保留无用/无效的代码或已弃用的代码
8. **类型组织**：类型定义放在 `types.ts` 文件中，共享类型应定义在公共的`types.ts` 文件中（最近公共位置的types文件），不要定义重复的类型，类型不要重复导入导出(避免re-export模式)，应直接引入源类型
9. **工具函数组织**：工具函数定义放在 `utils.ts` 文件中，公共工具应定义在公共的`utils.ts` 文件中（最近公共位置的utils文件），不要定义重复的工具函数，注意纯函数不应使用create开头命名
10. **对象池模式例外**：对象池类型（如 `PoolableSignal`）使用可变属性和 `| null` 标记，这是性能优化的必要例外。使用对象池对象后**必须**及时释放，嵌套对象也需要递归释放
11. **完成检查**：编写完成后**必须**运行 `npm run lint` 和 `npm run type-check` 并修复所有问题

### 类型和工具函数定义位置（示例）

```
src/
├── core/                   # 核心业务模块（示例）
│   ├── types.ts            # core模块中的公共类型
│   ├── utils.ts            # core模块中的公共函数
│   └── risk/               # 风险检查模块（示例）
│        ├── index.ts       # 风险检查模块逻辑
│        ├── types.ts       # 风险检查模块独享类型
│        └── utils.ts       # 风险检查模块独享工具函数
├── utils/                  # 公共工具模块（包含主index的公共函数）
└── types/                  # 公共类型模块（包含主index的公共类型）
```

### 完整示例

```typescript
// type.ts - 类型定义
export type Order = {
  readonly id: string;
  readonly symbol: string;
  readonly price: number;
};

export interface OrderRepository {
  save(order: Order): Promise<void>;
}

export type OrderResult =
  | { readonly success: true; readonly data: Order }
  | { readonly success: false; readonly error: Error };

// index.ts - 实现
export const createOrderService = ({
  orderRepository,
  priceValidator,
}: {
  orderRepository: OrderRepository;
  priceValidator: PriceValidator;
}) => {
  return {
    async createOrder(data: Omit<Order, 'id'>): Promise<OrderResult> {
      const validation = priceValidator.validate(data.price);
      if (!validation.success) return validation;

      const order: Order = { ...data, id: generateId() };
      await orderRepository.save(order);
      return { success: true, data: order };
    },
  };
};
```

### 对象池模式示例

```typescript
// objectPool/types.ts - 对象池类型（例外：使用可变属性）
export type PoolableSignal = {
  symbol: string | null;
  action: SignalType | null;
  price: number | null;
  indicators: Record<string, number> | null;
};

export type ObjectPool<T> = {
  acquire(): T;
  release(obj: T | null | undefined): void;
};

// objectPool/index.ts - 对象池实现
export const createObjectPool = <T>(
  factory: () => T,
  reset: (obj: T) => T,
  maxSize: number = 100,
): ObjectPool<T> => {
  const pool: T[] = [];

  return {
    acquire: () => (pool.length > 0 ? pool.pop()! : factory()),
    release: (obj) => {
      if (!obj || pool.length >= maxSize) return;
      pool.push(reset(obj));
    },
  };
};

// 使用示例
export const signalPool = createObjectPool<PoolableSignal>(
  () => ({ symbol: null, action: null, price: null, indicators: null }),
  (obj) => {
    // 释放嵌套对象
    if (obj.indicators) indicatorPool.release(obj.indicators);
    obj.symbol = null;
    obj.action = null;
    obj.price = null;
    obj.indicators = null;
    return obj;
  },
);

// 使用对象池
const signal = signalPool.acquire() as Signal; // 类型断言是安全的
signal.symbol = 'AAPL';
signal.action = 'BUY';
// ... 使用 signal
signalPool.release(signal); // 必须释放！
```

## 验证检查清单

完成代码后必须逐项检查：

- [ ] 完全遵守[typescript-strict文档](./reference/typescript-strict.md)
- [ ] 所有依赖通过参数注入（没有在函数内部创建）
- [ ] 使用工厂函数而非类
- [ ] 所有类型属性使用 `readonly`，数组使用 `ReadonlyArray`，可以部分宽容
- [ ] 对象池类型使用可变属性和 `| null` 标记（例外情况）
- [ ] 使用对象池对象后及时调用 `release()`，嵌套对象也需要释放
- [ ] 类型定义放在 `type.ts` 文件中，公共类型在公共`type.ts` 文件中，不允许re-export模式
- [ ] 工具函数放在 `utils.ts` 文件中，公共工具函数在公共`utils.ts` 文件中
- [ ] 文件命名使用 camelCase
- [ ] 没有兼容式、补丁式和临时性的代码
- [ ] 已清理所有无用代码
- [ ] 已运行 `npm run lint` 和 `npm run type-check` 若有问题则修复所有问题并重新运行

