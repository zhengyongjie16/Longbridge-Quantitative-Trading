---
name: typescript-project-specifications
description: 编写简洁、易于维护且遵循严格规范的 TypeScript 代码。在编写、修改或重构 .ts 文件时使用。强制执行核心原则（必须遵守）。适用场景：创建新 TypeScript 文件、重构现有代码、代码审查、修复类型错误、检查代码规范、eslint 和 type-check。当用户提到"写代码"、"重构"、"修改"、"检查"、"创建文件"、"添加功能"时自动使用。
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
8. **类型组织**：类型定义放在 `type.ts` 文件中，共享类型放在最近的公共位置，utils工具文件除外
9. **完成检查**：编写完成后**必须**运行 `npm run lint` 和 `npm run type-check` 并修复所有问题

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

## 验证检查清单

完成代码后必须逐项检查：

- [ ] 完全遵守[typescript-strict文档](./reference/typescript-strict.md)
- [ ] 所有依赖通过参数注入（没有在函数内部创建）
- [ ] 使用工厂函数而非类
- [ ] 所有类型属性使用 `readonly`，数组使用 `ReadonlyArray`，可以部分宽容
- [ ] 类型定义放在 `type.ts` 文件中，除开utils文件
- [ ] 文件命名使用 camelCase
- [ ] 没有兼容式、补丁式和临时性的代码
- [ ] 已清理所有无用代码
- [ ] 已运行 `npm run lint` 和 `npm run type-check` 若有问题则修复所有问题并重新运行

