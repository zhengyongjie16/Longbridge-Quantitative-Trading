# 订单记录成本均价与智能平仓优化方案

## 一、需求分析

### 1.1 当前逻辑

**智能平仓判断**：

- 直接找出订单记录中 `成交价 < 当前价` 的订单
- 卖出这些盈利订单

**问题**：

- 未考虑整体成本均价
- 可能在整体盈利时仍保留部分高价订单
- 无法实现"整体盈利时全部卖出"的策略

### 1.2 新需求

**订单记录增强**：

- 每个标的（做多/做空）维护一个成本均价
- 每次更新订单记录时同步更新成本均价

**智能平仓优化**：

1. 若 `当前价 > 成本均价`：整体盈利，全部卖出
2. 若 `当前价 ≤ 成本均价`：整体未盈利，执行当前逻辑（仅卖出成交价 < 当前价的订单）

---

## 二、方案可行性分析

### 2.1 技术可行性 ✅

**成本均价计算公式**：

```
成本均价 = 所有未平仓买入订单的总成本 / 所有未平仓买入订单的总数量
         = Σ(买入价 × 买入量) / Σ(买入量)
```

**优势**：

- 公式简单，计算开销低
- 与现有 R1/N1 计算逻辑一致（可复用）
- 数据来源明确（订单记录）

### 2.2 业务合理性 ✅

**符合交易逻辑**：

- 成本均价是衡量整体盈亏的标准指标
- "整体盈利时全部卖出"符合止盈策略
- "整体未盈利时卖出盈利部分"保留了原有的分批止盈能力

**与现有机制兼容**：

- 不影响浮亏监控（R1/N1 仍用于浮亏计算）
- 不影响订单过滤算法
- 不影响防重机制

### 2.3 逻辑完整性 ✅

**全链路验证**：

1. **启动时**：从全量订单刷新 → 应用过滤算法 → 计算成本均价
2. **买入成交**：添加订单记录 → 重新计算成本均价
3. **卖出成交**：扣减订单记录 → 重新计算成本均价
4. **保护性清仓**：清空订单记录 → 成本均价归零
5. **智能平仓判断**：读取成本均价 → 决策卖出策略

**边界情况处理**：

- 无订单记录时：成本均价为 null，智能平仓保持持仓（符合现有逻辑）
- 订单记录不可用时：成本均价为 null，智能平仓保持持仓（符合现有逻辑）
- 成本均价为 0 时：视为异常，智能平仓保持持仓

---

## 三、初版系统性修改方案（已由下文「最终系统性完整修改方案」替代，仅作历史参考）

> 以下 3.1–3.5 为初稿设计。经二次审核与第三次验证后，成本均价改为复用 `calculateOrderStatistics` 且不缓存、整体盈利路径改为通过 `getProfitableSellOrders(sellAll: true)` 并统一用 `getBuyOrdersList` 获取订单，详见文档后半部分的「三次分析结论汇总」与「最终系统性完整修改方案」。

### 3.1 数据结构修改

#### 3.1.1 OrderStorage 新增状态

**位置**：`src/core/orderRecorder/orderStorage.ts`

**新增私有状态**：

```typescript
// 成本均价缓存：Map<symbol, number | null>
const longCostAveragePriceMap: Map<string, number | null> = new Map();
const shortCostAveragePriceMap: Map<string, number | null> = new Map();
```

#### 3.1.2 类型定义新增

**位置**：`src/core/orderRecorder/types.ts`

**新增接口方法**：

```typescript
export interface OrderStorage {
  // ... 现有方法 ...

  /** 获取指定标的的成本均价 */
  getCostAveragePrice(symbol: string, isLongSymbol: boolean): number | null;
}
```

### 3.2 成本均价计算逻辑

#### 3.2.1 计算函数（纯函数）

**位置**：`src/core/orderRecorder/utils.ts`

**新增函数**：

```typescript
/**
 * 计算成本均价
 * @param orders 订单记录列表
 * @returns 成本均价，无订单时返回 null
 */
export function calculateCostAveragePrice(orders: ReadonlyArray<OrderRecord>): number | null {
  if (orders.length === 0) {
    return null;
  }

  let totalCost = 0;
  let totalQuantity = 0;

  for (const order of orders) {
    const price = Number(order.executedPrice) || 0;
    const quantity = Number(order.executedQuantity) || 0;

    if (price > 0 && quantity > 0) {
      totalCost += price * quantity;
      totalQuantity += quantity;
    }
  }

  if (totalQuantity <= 0) {
    return null;
  }

  return totalCost / totalQuantity;
}
```

#### 3.2.2 OrderStorage 集成

**位置**：`src/core/orderRecorder/orderStorage.ts`

**修改点 1：添加辅助函数**

```typescript
/** 更新成本均价缓存 */
const updateCostAveragePrice = (symbol: string, isLongSymbol: boolean): void => {
  const orders = getBuyOrdersList(symbol, isLongSymbol);
  const avgPrice = calculateCostAveragePrice(orders);
  const targetMap = isLongSymbol ? longCostAveragePriceMap : shortCostAveragePriceMap;

  if (avgPrice === null) {
    targetMap.delete(symbol);
  } else {
    targetMap.set(symbol, avgPrice);
  }
};
```

**修改点 2：在所有订单记录更新处调用**

1. `setBuyOrdersList` 函数末尾：

```typescript
const setBuyOrdersList = (
  symbol: string,
  newList: ReadonlyArray<OrderRecord>,
  isLongSymbol: boolean,
): void => {
  const targetMap = isLongSymbol ? longBuyOrdersMap : shortBuyOrdersMap;

  if (newList.length === 0) {
    targetMap.delete(symbol);
  } else {
    targetMap.set(symbol, [...newList]);
  }

  // 新增：更新成本均价
  updateCostAveragePrice(symbol, isLongSymbol);
};
```

2. `addBuyOrder` 函数末尾（已调用 setBuyOrdersList，无需额外处理）

3. `updateAfterSell` 函数末尾（已调用 setBuyOrdersList，无需额外处理）

4. `clearBuyOrders` 函数末尾（已调用 setBuyOrdersList，无需额外处理）

**修改点 3：新增公有方法**

```typescript
/** 获取指定标的的成本均价 */
const getCostAveragePrice = (symbol: string, isLongSymbol: boolean): number | null => {
  const targetMap = isLongSymbol ? longCostAveragePriceMap : shortCostAveragePriceMap;
  return targetMap.get(symbol) ?? null;
};
```

**修改点 4：clearAll 函数**

```typescript
function clearAll(): void {
  longBuyOrdersMap.clear();
  shortBuyOrdersMap.clear();
  longSellRecordMap.clear();
  shortSellRecordMap.clear();
  pendingSells.clear();

  // 新增：清空成本均价缓存
  longCostAveragePriceMap.clear();
  shortCostAveragePriceMap.clear();
}
```

**修改点 5：返回对象**

```typescript
return {
  // ... 现有方法 ...
  getCostAveragePrice,
};
```

### 3.3 OrderRecorder 门面层透传

**位置**：`src/core/orderRecorder/index.ts`

**新增公有方法**：

```typescript
/** 获取指定标的的成本均价 */
function getCostAveragePrice(symbol: string, isLongSymbol: boolean): number | null {
  return storage.getCostAveragePrice(symbol, isLongSymbol);
}
```

**返回对象新增**：

```typescript
return {
  // ... 现有方法 ...
  getCostAveragePrice,
};
```

### 3.4 智能平仓逻辑修改

#### 3.4.1 修改卖出数量计算

**位置**：`src/core/signalProcessor/utils.ts`

**修改 `resolveSellQuantityBySmartClose` 函数**：

```typescript
export function resolveSellQuantityBySmartClose({
  orderRecorder,
  currentPrice,
  availableQuantity,
  direction,
  symbol,
}: {
  orderRecorder: OrderRecorder | null;
  currentPrice: number;
  availableQuantity: number;
  direction: 'LONG' | 'SHORT';
  symbol: string;
}): {
  quantity: number | null;
  shouldHold: boolean;
  reason: string;
  relatedBuyOrderIds: readonly string[];
} {
  if (!orderRecorder) {
    return {
      quantity: null,
      shouldHold: true,
      reason: '智能平仓：订单记录不可用，保持持仓',
      relatedBuyOrderIds: [],
    };
  }

  // 新增：获取成本均价
  const isLongSymbol = direction === 'LONG';
  const costAveragePrice = orderRecorder.getCostAveragePrice(symbol, isLongSymbol);

  // 新增：若成本均价有效且当前价高于成本均价，全部卖出
  if (
    costAveragePrice !== null &&
    Number.isFinite(costAveragePrice) &&
    costAveragePrice > 0 &&
    currentPrice > costAveragePrice
  ) {
    return {
      quantity: availableQuantity,
      shouldHold: false,
      reason: `智能平仓：当前价=${currentPrice.toFixed(3)} > 成本均价=${costAveragePrice.toFixed(3)}，整体盈利，全部卖出`,
      relatedBuyOrderIds: [],
    };
  }

  // 原有逻辑：当前价未高于成本均价，仅卖出盈利订单
  const result = orderRecorder.getProfitableSellOrders(
    symbol,
    direction,
    currentPrice,
    availableQuantity,
  );

  if (result.orders.length === 0 || result.totalQuantity <= 0) {
    return {
      quantity: null,
      shouldHold: true,
      reason: '智能平仓：无盈利订单或已被占用',
      relatedBuyOrderIds: [],
    };
  }

  const relatedBuyOrderIds = result.orders.map((order) => order.orderId);

  return {
    quantity: result.totalQuantity,
    shouldHold: false,
    reason: `智能平仓：当前价=${currentPrice.toFixed(3)}，成本均价=${costAveragePrice?.toFixed(3) ?? 'N/A'}，可卖出=${result.totalQuantity}股，关联订单=${relatedBuyOrderIds.length}个`,
    relatedBuyOrderIds,
  };
}
```

### 3.5 类型定义更新

**位置**：`src/types/services.ts`

**OrderRecorder 接口新增方法**：

```typescript
export interface OrderRecorder {
  // ... 现有方法 ...

  /** 获取指定标的的成本均价 */
  getCostAveragePrice(symbol: string, isLongSymbol: boolean): number | null;
}
```

---

## 四、修改文件清单

| 文件路径                                 | 修改类型 | 修改内容                                          |
| ---------------------------------------- | -------- | ------------------------------------------------- |
| `src/core/orderRecorder/utils.ts`        | 新增     | 新增 `calculateCostAveragePrice` 函数             |
| `src/core/orderRecorder/types.ts`        | 修改     | OrderStorage 接口新增 `getCostAveragePrice` 方法  |
| `src/core/orderRecorder/orderStorage.ts` | 修改     | 新增成本均价缓存、计算逻辑、公有方法              |
| `src/core/orderRecorder/index.ts`        | 修改     | 新增 `getCostAveragePrice` 透传方法               |
| `src/core/signalProcessor/utils.ts`      | 修改     | 修改 `resolveSellQuantityBySmartClose` 函数逻辑   |
| `src/types/services.ts`                  | 修改     | OrderRecorder 接口新增 `getCostAveragePrice` 方法 |

**共计 6 个文件**

---

## 五、测试验证要点

### 5.1 单元测试场景

**成本均价计算**：

- 空订单列表 → 返回 null
- 单笔订单 → 返回该订单价格
- 多笔订单 → 返回加权平均价
- 包含无效订单（价格或数量为 0） → 正确过滤

**智能平仓决策**：

- 当前价 > 成本均价 → 全部卖出
- 当前价 ≤ 成本均价 → 仅卖出盈利订单
- 成本均价为 null → 保持持仓
- 订单记录不可用 → 保持持仓

### 5.2 集成测试场景

**场景 1：整体盈利全部卖出**

- 买入 100 股 @ 1.00，买入 100 股 @ 1.20
- 成本均价 = (100×1.00 + 100×1.20) / 200 = 1.10
- 当前价 = 1.15 > 1.10
- 预期：卖出 200 股（全部）

**场景 2：整体未盈利仅卖盈利部分**

- 买入 100 股 @ 1.00，买入 100 股 @ 1.20
- 成本均价 = 1.10
- 当前价 = 1.05 ≤ 1.10
- 预期：卖出 100 股（仅 1.00 的订单）

**场景 3：卖出后成本均价更新**

- 初始：买入 100 股 @ 1.00，买入 100 股 @ 1.20，成本均价 = 1.10
- 卖出 100 股 @ 1.05（扣减 1.00 的订单）
- 预期：剩余 100 股 @ 1.20，成本均价 = 1.20

**场景 4：保护性清仓后成本均价归零**

- 初始：有订单记录，成本均价 = 1.10
- 触发保护性清仓
- 预期：订单记录清空，成本均价 = null

### 5.3 边界测试

- 成本均价恰好等于当前价
- 成本均价为极小值（接近 0）
- 订单数量极大（性能测试）
- 并发更新订单记录（线程安全，虽然 Node.js 单线程但需确保逻辑原子性）

---

## 六、风险评估与缓解

### 6.1 潜在风险

| 风险                               | 影响             | 概率 | 缓解措施                     |
| ---------------------------------- | ---------------- | ---- | ---------------------------- |
| 成本均价计算错误                   | 错误的卖出决策   | 低   | 单元测试覆盖所有场景         |
| 成本均价未及时更新                 | 使用过期数据决策 | 低   | 在所有订单记录更新处统一调用 |
| 整体盈利时全部卖出导致错失更大收益 | 收益优化不足     | 中   | 业务策略问题，可通过配置调整 |
| 与浮亏监控 R1 计算混淆             | 逻辑错误         | 低   | 明确区分用途，注释说明       |

### 6.2 回滚方案

若上线后发现问题，可快速回滚：

1. 恢复 `resolveSellQuantityBySmartClose` 函数为原版本
2. 移除成本均价相关代码（不影响其他功能）

---

## 七、实施步骤

### 7.1 开发阶段

1. **第一步**：实现 `calculateCostAveragePrice` 函数并编写单元测试
2. **第二步**：修改 `OrderStorage`，集成成本均价计算
3. **第三步**：修改 `OrderRecorder` 门面层透传
4. **第四步**：修改智能平仓逻辑
5. **第五步**：更新类型定义
6. **第六步**：运行 `bun run lint` 和 `bun run type-check`

### 7.2 测试阶段

1. 单元测试：成本均价计算函数
2. 集成测试：智能平仓决策逻辑
3. 回归测试：确保现有功能不受影响
4. 边界测试：极端场景验证

### 7.3 上线阶段

1. 代码审查
2. 灰度发布（可选）
3. 监控日志输出，验证成本均价计算正确性
4. 观察智能平仓行为是否符合预期

---

## 八、总结

### 8.1 方案优势

✅ **系统性完整**：覆盖数据结构、计算逻辑、业务决策全链路
✅ **逻辑正确**：成本均价计算公式标准，智能平仓决策合理
✅ **向后兼容**：不影响现有功能，仅增强智能平仓能力
✅ **易于维护**：代码结构清晰，职责分离明确
✅ **性能友好**：计算开销低，缓存机制高效

### 8.2 关键设计原则

1. **单一职责**：成本均价计算独立为纯函数
2. **依赖注入**：通过 OrderRecorder 接口透传
3. **不可变数据**：所有计算基于只读订单列表
4. **防御性编程**：边界情况全面处理
5. **类型安全**：严格类型定义，无 any 类型

### 8.3 业务价值

- **提升止盈效率**：整体盈利时全部卖出，避免错失最佳卖点
- **保留灵活性**：整体未盈利时仍可分批止盈
- **增强可观测性**：成本均价可用于监控和分析
- **符合交易直觉**：成本均价是交易者熟悉的指标

---

## 九、附录

### 9.1 成本均价 vs 浮亏监控 R1

| 指标           | 用途         | 计算方式        | 更新时机       |
| -------------- | ------------ | --------------- | -------------- |
| 成本均价       | 智能平仓决策 | 总成本 / 总数量 | 订单记录更新时 |
| R1（开仓成本） | 浮亏监控     | Σ(价格 × 数量)  | 订单记录更新时 |

**关系**：`成本均价 = R1 / N1`

### 9.2 示例计算

**订单记录**：

- 买入 100 股 @ 1.00
- 买入 150 股 @ 1.20
- 买入 50 股 @ 0.90

**成本均价计算**：

```
总成本 = 100×1.00 + 150×1.20 + 50×0.90 = 100 + 180 + 45 = 325
总数量 = 100 + 150 + 50 = 300
成本均价 = 325 / 300 = 1.0833
```

**智能平仓决策**：

- 当前价 = 1.10 > 1.0833 → 全部卖出 300 股
- 当前价 = 1.05 ≤ 1.0833 → 仅卖出 100 股 @ 1.00 + 50 股 @ 0.90 = 150 股

---

**方案编写完成时间**：2026-02-14  
**方案版本**：v1.0  
**方案状态**：已由三次分析合并为最终方案（见下文）

---

## 三次分析结论汇总

### 原方案（一稿）正确之处

- 成本均价公式正确：Σ(买入价 × 买入量) / Σ(买入量)
- 边界处理合理：空订单返回 null、成本均价为 0 视为异常
- 全链路触发点识别正确（启动刷新、买入/卖出、清仓、智能平仓）

### 二次审核发现的问题与结论

| 问题                                                                                       | 结论                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 已有 `calculateOrderStatistics` 计算 averagePrice，与新增 `calculateCostAveragePrice` 重复 | **复用** `calculateOrderStatistics`，不新增 `calculateCostAveragePrice` |
| 成本均价用 Map 缓存增加状态与同步复杂度                                                    | **不缓存**，在需要时基于 `getBuyOrdersList` 实时计算                    |
| 整体盈利时直接返回 `quantity: availableQuantity, relatedBuyOrderIds: []`                   | **严重**：防重失效，必须通过"可卖出订单"获取 `relatedBuyOrderIds`       |
| 整体盈利时未考虑待成交卖出占用                                                             | 通过"可卖出订单"接口（含防重与数量截断）统一处理                        |

### 第三次验证发现的问题与结论

| 问题                                                                                          | 结论                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getProfitableSellOrders` 加 `sellAll` 后语义为"有时返回全部订单"，与"盈利订单"命名不完全一致 | 保留 `sellAll` 参数，在接口/实现处用 JSDoc 明确：`sellAll=true` 时表示"可卖出的全部订单（用于整体盈利全部卖出）"，语义为"可卖出订单集合"的两种模式    |
| `sellAll=true` 时从 Map 直接取引用，与 `getBuyOrdersBelowPrice` 返回新数组形态不一致          | **实现修正**：`sellAll=true` 时统一用 `getBuyOrdersList(symbol, isLongSymbol)` 获取订单，与"盈利订单"路径一致，均为拷贝数组，保证数据形态一致、可维护 |

### 设计决策汇总

| 决策点                   | 最终方案                                                                              | 理由                                                   |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 成本均价计算             | 复用 `calculateOrderStatistics`，无订单/总量为 0 时返回 null                          | 避免重复逻辑，单一数据源                               |
| 缓存策略                 | 不缓存，实时计算                                                                      | 订单量小、计算简单，避免状态同步与 clearAll 等边界     |
| 整体盈利时可卖订单与防重 | 通过「可卖出订单」接口获取全部可卖订单并保留防重                                      | 复用防重与整笔截断逻辑，保证 `relatedBuyOrderIds` 正确 |
| 目标订单数据来源         | `includeAll` 时用 `getBuyOrdersList`，否则用 `getBuyOrdersBelowPrice`                 | 两条路径均为新数组，形态一致，易维护                   |
| 方法命名与语义           | 以 `getSellableOrders` 为核心实现，`getProfitableSellOrders` 委托（见下节全链路分析） | 命名与行为一致，符合「无补丁式代码」规范               |

---

## 最终系统性完整修改方案

本方案为**完整系统性修改**，非补丁式；所有代码需符合 **typescript-project-specifications** 规范。

### 1. 成本均价：不新增函数、不缓存

- **计算**：在 OrderStorage 的 `getCostAveragePrice` 内，用已有 `getBuyOrdersList` + `calculateOrderStatistics` 实时计算；无订单或 `totalQuantity === 0` 时返回 `null`。
- **不新增** `calculateCostAveragePrice`，不新增任何 Map 缓存；`clearAll` 无需改动。

### 2. OrderStorage（orderStorage.ts）

**2.1 新增依赖**

- 从 `./utils.js` 增加导入：`calculateOrderStatistics`。

**2.2 新增方法 getCostAveragePrice**

```typescript
const getCostAveragePrice = (symbol: string, isLongSymbol: boolean): number | null => {
  const orders = getBuyOrdersList(symbol, isLongSymbol);
  if (orders.length === 0) {
    return null;
  }
  const stats = calculateOrderStatistics(orders);
  return stats.totalQuantity > 0 ? stats.averagePrice : null;
};
```

**2.3 新增核心方法 getSellableOrders（语义：可卖出的订单）**

- 签名为：`getSellableOrders(symbol, direction, currentPrice, maxSellQuantity?, options?: { includeAll?: boolean }): ProfitableOrderResult`。
- **第一步**获取目标订单：
  - `options?.includeAll === true`：`targetOrders = getBuyOrdersList(symbol, direction === 'LONG')`（新数组拷贝）。
  - 否则：`targetOrders = getBuyOrdersBelowPrice(currentPrice, direction, symbol)`。
- **第二步及之后**与现有 `getProfitableSellOrders` 完全一致（实施时可直接复用其逻辑）：获取待成交卖出列表 → 构建占用订单 ID 集合 → 过滤掉被占用的订单 → 计算可用总数量 → 若 `maxSellQuantity` 有值且总数量超限则按低价优先、整笔选单截断 → 返回 `{ orders, totalQuantity }`。仅第一步「目标订单来源」按 `includeAll` 二选一，其余不变。
- 语义：**可卖出订单** = 在排除占用、可选数量截断后，要么「仅买入价 &lt; 当前价的订单」（includeAll 未设），要么「该标的该方向下全部订单」（includeAll 为 true）。命名与行为一致。

**2.4 getProfitableSellOrders 改为委托**

- 保持对外签名：`getProfitableSellOrders(symbol, direction, currentPrice, maxSellQuantity?, sellAll?: boolean): ProfitableOrderResult`。
- 实现为一层委托：`return getSellableOrders(symbol, direction, currentPrice, maxSellQuantity, { includeAll: sellAll });`。
- 不再在 getProfitableSellOrders 内重复"目标订单选取 + 防重 + 截断"逻辑，单一实现落在 getSellableOrders。

**2.5 返回对象**

- 在 `return { ... }` 中增加 `getCostAveragePrice`、`getSellableOrders`。

### 3. 类型与接口

**3.1 OrderStorage（types.ts）**

- `getCostAveragePrice(symbol: string, isLongSymbol: boolean): number | null`。
- `getSellableOrders(symbol, direction, currentPrice, maxSellQuantity?, options?: { includeAll?: boolean }): ProfitableOrderResult`。
- `getProfitableSellOrders(symbol, direction, currentPrice, maxSellQuantity?, sellAll?): ProfitableOrderResult`（保留，委托给 getSellableOrders）。

**3.2 OrderRecorder（services.ts）**

- `getCostAveragePrice(symbol: string, isLongSymbol: boolean): number | null`。
- `getSellableOrders(symbol, direction, currentPrice, maxSellQuantity?, options?: { includeAll?: boolean }): { orders: ReadonlyArray<OrderRecord>; totalQuantity: number }`。
- `getProfitableSellOrders(..., maxSellQuantity?, sellAll?): { orders: ReadonlyArray<OrderRecord>; totalQuantity: number }`（保留）。

### 4. OrderRecorder 门面（index.ts）

- 新增 `getCostAveragePrice(symbol, isLongSymbol)`，透传 `storage.getCostAveragePrice`。
- 新增 `getSellableOrders(symbol, direction, currentPrice, maxSellQuantity?, options?)`，透传 `storage.getSellableOrders`。
- `getProfitableSellOrders` 保持透传（storage 侧已改为委托 getSellableOrders）。
- 返回对象中导出 `getCostAveragePrice`、`getSellableOrders`。

### 5. 智能平仓（signalProcessor/utils.ts）resolveSellQuantityBySmartClose

- 若 `!orderRecorder`，保持现有"订单记录不可用，保持持仓"返回。
- 取 `costAveragePrice = orderRecorder.getCostAveragePrice(symbol, isLongSymbol)`。
- 定义 `isOverallProfitable = costAveragePrice !== null && Number.isFinite(costAveragePrice) && costAveragePrice > 0 && currentPrice > costAveragePrice`。
- **调用** `orderRecorder.getSellableOrders(symbol, direction, currentPrice, availableQuantity, { includeAll: isOverallProfitable })`（业务侧使用语义明确的 getSellableOrders，不再使用 getProfitableSellOrders 的第五参）。
- **使用肯定条件分支**（符合 typescript-project-specifications「禁止否定条件前置」）：若 `result.orders.length > 0 && result.totalQuantity > 0`，则 `relatedBuyOrderIds = result.orders.map(o => o.orderId)`，`quantity = result.totalQuantity`，reason 中可包含成本均价与可卖数量、关联订单数，返回 `quantity`、`shouldHold: false`、`reason`、`relatedBuyOrderIds`。
- **否则**（无可卖订单或数量为 0）：返回保持持仓；reason 用**局部变量**按 `isOverallProfitable` 区分：整体盈利时为「智能平仓：整体盈利但无可用订单或已被占用，保持持仓」，否则为「智能平仓：无盈利订单或已被占用」。禁止嵌套三元。

### 6. 修改文件清单

| 文件                                     | 修改类型 | 内容                                                                                                                                                    |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/orderRecorder/orderStorage.ts` | 修改     | 引入 `calculateOrderStatistics`；新增 `getCostAveragePrice`；**新增 getSellableOrders（核心实现）**；getProfitableSellOrders 改为委托 getSellableOrders |
| `src/core/orderRecorder/types.ts`        | 修改     | OrderStorage 增加 `getCostAveragePrice`、**getSellableOrders**，getProfitableSellOrders 保留并增加 `sellAll?`                                           |
| `src/types/services.ts`                  | 修改     | OrderRecorder 增加 `getCostAveragePrice`、**getSellableOrders**，getProfitableSellOrders 保留 `sellAll?`                                                |
| `src/core/orderRecorder/index.ts`        | 修改     | 透传 `getCostAveragePrice`、**getSellableOrders**，getProfitableSellOrders 仍透传                                                                       |
| `src/core/signalProcessor/utils.ts`      | 修改     | `resolveSellQuantityBySmartClose` 调用 **getSellableOrders(..., { includeAll: isOverallProfitable })**                                                  |

**共计 5 个文件**；不新增文件，不新增 `utils.ts` 中的成本均价函数。

---

## 全链路验证（简要）

| 场景                             | 成本均价                       | 智能平仓                                                  | 防重                    |
| -------------------------------- | ------------------------------ | --------------------------------------------------------- | ----------------------- |
| 启动刷新 / 买入成交 / 卖出部分   | 下次查询时实时计算             | 正常                                                      | 正常                    |
| 卖出全部 / 保护性清仓 / clearAll | 无订单则 null                  | 无订单保持持仓                                            | 正常                    |
| 整体盈利                         | 实时计算                       | getSellableOrders(..., { includeAll: true })，全部可卖    | relatedBuyOrderIds 正确 |
| 整体未盈利                       | 实时计算                       | getSellableOrders(..., { includeAll: false })，仅盈利部分 | 正常                    |
| 成本均价 null 或无效             | 保持持仓                       | 保持持仓                                                  | 正常                    |
| 待成交卖出占用                   | 不排除占用（按全部订单算均价） | 排除已占用订单                                            | 正常                    |

---

## TypeScript 规范符合性（要点）

- 无 `any`、无多余类型断言、无未说明的 `@ts-ignore`。
- 使用现有 `ReadonlyArray` / readonly，不引入可变全局状态（无缓存 Map）。
- 不新增重复类型或等价类型；类型与接口仅在 types.ts / services 中扩展。
- 不在 utils 中新增重复的成本均价函数；工具函数仍在 `utils.ts`，本方案仅在使用处组合。
- 函数参数 ≤7：`getSellableOrders` 与 `getProfitableSellOrders` 均为 5 个参数（含可选），符合。
- 禁止嵌套三元；**禁止否定条件前置**：`resolveSellQuantityBySmartClose` 中有可卖订单时的分支使用肯定条件 `if (result.orders.length > 0 && result.totalQuantity > 0)` 返回卖出结果，否则分支返回保持持仓（仅有 if 无 else 的 guard clause 如 `if (!orderRecorder)` 可例外）。
- 完成后运行 `bun run lint` 与 `bun run type-check` 并修复所有问题。

---

## 方法命名与语义：全链路分析与优化决策

### 全链路调用关系

- **OrderStorage**：实现并导出 `getProfitableSellOrders`（当前唯一承载"可卖出订单 + 防重 + 整笔截断"的实现）。
- **OrderRecorder（门面）**：透传 `getProfitableSellOrders`。
- **唯一业务调用方**：`signalProcessor/utils.ts` 的 `resolveSellQuantityBySmartClose` 调用 `orderRecorder.getProfitableSellOrders(symbol, direction, currentPrice, availableQuantity)`；方案中需在此处传入"是否整体盈利"以决定"仅盈利订单"或"全部可卖订单"。

结论：调用链短、调用点单一，引入语义正确的新方法并切换调用方为**系统性修改**，不影响其他模块。

### 为何必须优化（非补丁）

- **命名与行为一致**：`getProfitableSellOrders` 在"整体盈利"时返回的是**全部可卖出订单**，与"盈利订单"字面不符，长期可读性与维护性差。
- **规范要求**：typescript-project-specifications 要求「无兼容性代码、无补丁式代码、必须编写完整的系统性代码」。仅通过 JSDoc 说明"有时返回全部订单"属于以注释弥补命名缺陷，属补丁式处理。
- **单一职责与单一实现**："可卖出订单"的两种模式（仅盈利 / 全部）应落在**一个语义正确的方法**上，再由旧方法委托，避免同一逻辑两套命名。

### 优化结论（已纳入方案）

- **有修改与优化必要性**：采用以 **getSellableOrders** 为核心实现、**getProfitableSellOrders** 委托的系统性设计，已写入上文「最终系统性完整修改方案」。
- **getSellableOrders**：语义为「可卖出的订单」；通过 `options?.includeAll` 区分"仅买入价 &lt; 当前价"与"该标的该方向全部订单"；防重与整笔截断逻辑仅在此处实现一次。
- **getProfitableSellOrders**：保留对外签名（含 `sellAll?`），实现为一行委托 `getSellableOrders(..., { includeAll: sellAll })`，兼容既有接口。
- **业务调用方**：`resolveSellQuantityBySmartClose` 改为调用 `getSellableOrders(symbol, direction, currentPrice, availableQuantity, { includeAll: isOverallProfitable })`，意图清晰、命名与行为一致。

除上述命名与语义优化外，**未发现逻辑错误或与三次分析结论冲突之处**；方案在正确性、防重、数据形态一致性上已按三次分析修正完毕，且方法命名优化已作为方案一部分实施。

---

## 测试验证要点

- **成本均价**：空订单返回 null；单笔/多笔订单与 `calculateOrderStatistics` 的 averagePrice 一致；totalQuantity 为 0 时返回 null。
- **智能平仓**：当前价 > 成本均价时走 sellAll 路径、返回全部可卖数量及正确 relatedBuyOrderIds；当前价 ≤ 成本均价时仅卖盈利部分；成本均价为 null 或订单不可用时保持持仓。
- **防重**：整体盈利全部卖出时，relatedBuyOrderIds 非空，且与 getSellableOrders 返回的 orders 一致；存在待成交卖出时，可卖数量与订单列表排除占用后一致。
- **集成**：启动刷新、买入/卖出成交、保护性清仓、clearAll 后，成本均价与可卖订单行为符合上表全链路验证。

---

## 实施步骤

1. 修改 `orderStorage.ts`：从 `./utils.js` 导入 `calculateOrderStatistics`；实现 `getCostAveragePrice`（无订单或 `totalQuantity === 0` 返回 null）；**实现 getSellableOrders**：第一步按 `options?.includeAll` 取目标订单（includeAll 用 `getBuyOrdersList`，否则用 `getBuyOrdersBelowPrice`），第二步及之后**复用现有 getProfitableSellOrders 的待成交占用过滤与整笔截断逻辑**；将 `getProfitableSellOrders` 改为委托 `getSellableOrders(..., { includeAll: sellAll })`；返回对象增加 `getCostAveragePrice`、`getSellableOrders`。
2. 更新 `orderRecorder/types.ts` 与 `types/services.ts`：增加 `getCostAveragePrice`、`getSellableOrders` 签名，保留 `getProfitableSellOrders` 并增加可选参数 `sellAll?`。
3. 更新 `orderRecorder/index.ts`：透传 `getCostAveragePrice`、`getSellableOrders`；`getProfitableSellOrders` 透传时增加第五参 `sellAll?` 并传给 storage。
4. 修改 `signalProcessor/utils.ts`：`resolveSellQuantityBySmartClose` 中先取成本均价与 `isOverallProfitable`，再调用 `getSellableOrders(..., { includeAll: isOverallProfitable })`；使用肯定条件 `result.orders.length > 0 && result.totalQuantity > 0` 分支返回卖出结果，否则用局部变量拼接 reason 返回保持持仓。
5. 运行 `bun run lint` 与 `bun run type-check` 并修复所有问题；按「测试验证要点」补充/跑通单测与集成测试。

---

## 附录：关键代码形态（orderStorage）

**核心实现 getSellableOrders（第一步 + 说明）：**

```typescript
function getSellableOrders(
  symbol: string,
  direction: 'LONG' | 'SHORT',
  currentPrice: number,
  maxSellQuantity?: number,
  options?: { includeAll?: boolean },
): ProfitableOrderResult {
  const isLongSymbol = direction === 'LONG';
  const targetOrders =
    options?.includeAll === true
      ? getBuyOrdersList(symbol, isLongSymbol)
      : getBuyOrdersBelowPrice(currentPrice, direction, symbol);

  if (targetOrders.length === 0) {
    return { orders: [], totalQuantity: 0 };
  }
  // 后续与现有 getProfitableSellOrders 一致：getPendingSellOrders → occupiedOrderIds →
  // availableOrders = targetOrders.filter(未占用) → totalQuantity →
  // 若 maxSellQuantity 有值且 totalQuantity > maxSellQuantity 则按低价优先整笔截断 →
  // 返回 { orders, totalQuantity }
}
```

**getProfitableSellOrders 委托：**

```typescript
function getProfitableSellOrders(
  symbol: string,
  direction: 'LONG' | 'SHORT',
  currentPrice: number,
  maxSellQuantity?: number,
  sellAll?: boolean,
): ProfitableOrderResult {
  return getSellableOrders(symbol, direction, currentPrice, maxSellQuantity, {
    includeAll: sellAll,
  });
}
```

注意：`getBuyOrdersList` 已返回 `[...list]` 或 `[]`，与 `getBuyOrdersBelowPrice` 的 filter 结果均为新数组，形态一致。

---

**最终方案定稿时间**：2026-02-14  
**方案版本**：v2.2（全链路与规范复核后补充实施细节）  
**方案状态**：已通过全链路可行性与合理性分析及 typescript-project-specifications 规范复核，可作为实施依据。

---

## 全链路与规范复核结论（2026-02-14）

- **代码与方案一致性**：已核对 `orderStorage.ts`、`utils.ts`、`types.ts`、`services.ts`、`index.ts`、`signalProcessor/utils.ts`。`calculateOrderStatistics` 返回 `averagePrice`（无订单时 totalQuantity 为 0、averagePrice 为 0），方案通过 `totalQuantity > 0` 判断返回 null，正确。`getBuyOrdersList` 返回拷贝、`getBuyOrdersBelowPrice` 返回新数组，形态一致。
- **业务与防重**：整体盈利时通过 `getSellableOrders(..., { includeAll: true })` 走「可卖出订单」路径，防重与整笔截断逻辑复用，`relatedBuyOrderIds` 正确；整体未盈利时 `includeAll` 为 false，行为与现有一致。
- **规范符合性**：已按 typescript-project-specifications 在文档中明确禁止否定条件前置的写法（肯定条件分支）、getSellableOrders 与 getProfitableSellOrders 参数数量、无缓存/无重复类型、实施步骤与附录代码形态一致。
- **存在问题说明**：经复核**未发现方案逻辑错误或遗漏**。实施时需严格按「实施步骤」与「TypeScript 规范符合性」执行，尤其注意 `resolveSellQuantityBySmartClose` 使用肯定条件分支与 reason 局部变量，以及 `getSellableOrders` 完整复用现有防重与整笔截断逻辑。
