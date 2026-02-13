# 智能平仓「订单不可拆分」修复方案

## 一、问题概述

**问题类型**：业务逻辑违反「订单不可拆分」约束

**影响范围**：智能平仓在可卖数量超出可用持仓（`maxSellQuantity`）时，会创建「部分数量」的订单对象并参与防重占用，导致与订单过滤算法不一致，且占用粒度不准确。

**修复原则**：系统性、完整性修复，不采用兼容性或补丁式方案。

---

## 二、问题根因

### 2.1 业务约束

- **订单不可拆分**：订单记录中的每一笔订单视为不可拆分单位（见 `orderFilteringEngine.ts` 注释及过滤算法 3.2）。
- **智能平仓规则**：可卖数量 = 盈利订单中未被待成交卖出占用的部分，卖出数量 = min(可卖数量, 可用持仓)；超出时按买入价从低到高截断（便宜先卖）；提交卖出时登记**关联买入订单**用于防重。
- 「截断」在本文中统一理解为：只选择**完整订单**参与本次卖出，不创建部分数量订单对象；选单顺序为按买入价从低到高，直至再加入下一笔会超出可用持仓则停止。

### 2.2 当前错误实现

位置：`src/core/orderRecorder/orderStorage.ts` 中 `getProfitableSellOrders`。

当 `totalQuantity > maxSellQuantity` 时：

```typescript
// 错误：创建了部分数量订单对象
} else {
  finalOrders.push({
    ...order,
    executedQuantity: remaining,  // 修改数量，违反「订单不可拆分」
  });
  remaining = 0;
}
totalQuantity = maxSellQuantity;  // 强制等于 maxSellQuantity
```

后果：

1. 生成了「部分数量」的订单对象，与 `orderFilteringEngine.adjustOrdersByQuantityLimit` 的「订单不可拆分」处理不一致。
2. `relatedBuyOrderIds` 仅记录订单 ID，整笔订单被标记为占用，实际只卖出部分数量，剩余数量无法再通过智能平仓卖出。
3. 占用语义不清晰：防重机制无法表达「仅部分数量被占用」。

### 2.3 正确参照实现

同一项目内已有「按数量限制只保留完整订单」的实现：`orderFilteringEngine.ts` 中 `adjustOrdersByQuantityLimit`：

- 当 `accumulatedQuantity + order.executedQuantity > maxQuantity` 时 **跳过该订单**（`continue`），不拆分、不创建部分数量对象。
- 只将**完整订单**加入结果集。

智能平仓的「超出时按买入价从低到高截断」应与该语义对齐：只选择完整订单，不创建部分数量订单。

---

## 三、修复目标

1. **不再创建部分数量订单对象**：`getProfitableSellOrders` 返回的 `orders` 中每一项均为订单记录中的完整订单，不修改 `executedQuantity`。
2. **只标记完整订单为占用**：`relatedBuyOrderIds` 仅包含本次实际参与卖出的**完整订单**的 ID，与「订单不可拆分」一致。
3. **与订单过滤算法一致**：数量限制下的选单逻辑与 `adjustOrdersByQuantityLimit` 在「只选完整订单」这一点上保持一致（选单顺序不同：过滤算法按价格从高到低保留，智能平仓按价格从低到高选卖，均不拆分订单）。
4. **可卖数量可能小于可用持仓**：当最小一笔可卖订单数量仍大于剩余可用持仓时，不卖出该笔，最终 `totalQuantity` 可能小于 `maxSellQuantity`，甚至为 0（不执行卖出）。

---

## 四、影响范围与数据流

### 4.1 涉及模块

| 模块 | 文件 | 修改类型 |
|------|------|----------|
| 订单存储 | `src/core/orderRecorder/orderStorage.ts` | 修改 `getProfitableSellOrders` 截断逻辑 |
| 无 | 其他调用方 | 无需改接口或调用方式 |

### 4.2 数据流（修复后）

```
getProfitableSellOrders(symbol, direction, currentPrice, maxSellQuantity)
  → 盈利订单（排除占用）
  → 若 totalQuantity > maxSellQuantity：
      按买入价从低到高排序，仅加入「完整订单」直至加入下一笔会超限则停止
      finalOrders = 完整订单列表
      totalQuantity = calculateTotalQuantity(finalOrders)  // ≤ maxSellQuantity，可能为 0
  → 返回 { orders: finalOrders, totalQuantity }
       ↓
resolveSellQuantityBySmartClose
  → relatedBuyOrderIds = result.orders.map(o => o.orderId)  // 仅完整订单 ID
  → quantity = result.totalQuantity
       ↓
processSellSignals / 卖出提交 / 待成交登记
  → 仅完整订单被标记为占用；卖出数量 = totalQuantity
```

### 4.3 行为变化说明

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| 盈利订单 100 股，可用 80 股 | 创建部分数量对象 80 股，整笔订单被占用，实际卖 80 股 | 不选该笔（无法完整卖出），finalOrders=[]，totalQuantity=0，不卖出 |
| 盈利订单 50+50 股，可用 80 股 | 两笔都选，创建 50+30 的部分对象，卖 80 股 | 只选第一笔完整订单 50 股；第二笔 50 加入会超 80，不选。finalOrders=[第一笔]，totalQuantity=50，卖 50 股 |
| 盈利订单总量 ≤ 可用持仓 | 无截断，行为不变 | 无截断，行为不变 |

说明：`maxSellQuantity` 即可用持仓，所以「只选完整订单」时，最终 `totalQuantity` 一定 ≤ `maxSellQuantity`；若第一笔订单数量就大于 `maxSellQuantity`，则本次不选任何订单，不卖出。

---

## 五、详细修复方案

### 5.1 修改点：`src/core/orderRecorder/orderStorage.ts`

**函数**：`getProfitableSellOrders` 中「5. 数量截断」整块逻辑。

**当前逻辑（摘录）**：

```typescript
if (maxSellQuantity !== undefined && totalQuantity > maxSellQuantity) {
  const sortedOrders = [...availableOrders].sort((a, b) => a.executedPrice - b.executedPrice);
  let remaining = maxSellQuantity;
  const finalOrders: OrderRecord[] = [];

  for (const order of sortedOrders) {
    if (remaining <= 0) break;
    if (order.executedQuantity <= remaining) {
      finalOrders.push(order);
      remaining -= order.executedQuantity;
    } else {
      finalOrders.push({ ...order, executedQuantity: remaining });
      remaining = 0;
    }
  }
  totalQuantity = maxSellQuantity;
  // ...
  return { orders: finalOrders, totalQuantity };
}
```

**替换为（仅完整订单，不创建部分数量对象）**：

```typescript
if (maxSellQuantity !== undefined && totalQuantity > maxSellQuantity) {
  // 按买入价从低到高排序（便宜先卖），与业务「超出时按买入价从低到高截断」一致
  const sortedOrders = [...availableOrders].sort((a, b) => a.executedPrice - b.executedPrice);

  let remaining = maxSellQuantity;
  const finalOrders: OrderRecord[] = [];

  for (const order of sortedOrders) {
    if (remaining <= 0) break;
    // 订单不可拆分：仅当整笔订单加入后仍不超过限制时才加入
    if (order.executedQuantity <= remaining) {
      finalOrders.push(order);
      remaining -= order.executedQuantity;
    } else {
      // 本笔订单无法完整卖出，不加入、不创建部分数量对象；后续更高价订单也不再考虑（便宜先卖已满足）
      break;
    }
  }

  totalQuantity = calculateTotalQuantity(finalOrders);

  logger.info(
    `[订单存储] 数量超出限制按完整订单截断: ${symbol} ${direction} ` +
    `原数量=${calculateTotalQuantity(sortedOrders)} ` +
    `限制=${maxSellQuantity} 最终=${totalQuantity}（仅完整订单）`,
  );

  return { orders: finalOrders, totalQuantity };
}
```

**要点**：

- 不再出现 `executedQuantity: remaining` 或任何对订单数量的改写，不创建部分数量订单对象。
- 当下一笔订单整笔加入会超过 `remaining` 时 `break`，保证只选完整订单且符合「便宜先卖」顺序。
- `totalQuantity` 由 `calculateTotalQuantity(finalOrders)` 得到，可能小于 `maxSellQuantity`，也可能为 0。

### 5.2 注释与文档更新

- **同文件内**：将 `getProfitableSellOrders` 顶部注释中「如超出最大可卖数量，按价格从低到高排序截断（便宜先卖）」补充为「仅选择完整订单，不拆分订单、不创建部分数量订单对象」。
- **可选**：在 `core-program-business-logic` 的智能平仓规则中，将「超出时按买入价从低到高截断（便宜先卖）」补充一句：「仅选择完整订单参与本次卖出，不拆分订单。」以便与实现一致。

### 5.3 调用方无需改动

- `resolveSellQuantityBySmartClose`：仍使用 `result.orders` 与 `result.totalQuantity`，仅 `orders` 内容变为「仅完整订单」，接口不变。
- `orderExecutor` / 待成交登记：仍根据 `relatedBuyOrderIds` 登记占用，语义变为「仅完整订单被占用」，无需改类型或入参。

---

## 六、测试与验证建议

1. **单元测试**（建议在 `orderStorage` 或订单相关测试中）  
   - 用例 1：盈利订单 [100]，maxSellQuantity=80 → 期望 `orders=[]`，`totalQuantity=0`。  
   - 用例 2：盈利订单 [50, 50]，maxSellQuantity=80 → 第一笔 50 加入后 remaining=30，第二笔 50>30 不选；期望 `orders=[第一笔]`，`totalQuantity=50`。  
   - 用例 3：盈利订单 [30, 50, 20]，maxSellQuantity=80 → 选 30+50=80，第三笔不选；期望 `orders=[30,50]`，`totalQuantity=80`。  
   - 用例 4：盈利订单 [30, 60, 20]，maxSellQuantity=80 → 30+60>80，故只选 30；期望 `orders=[30]`，`totalQuantity=30`。

2. **回归**  
   - 智能平仓 E2E：可用持仓充足时行为与现有一致；可用持仓不足且存在「单笔大于剩余可用」的盈利订单时，不再卖出（或只卖出能完整卖出的订单），且不出现部分数量订单对象。

3. **日志**  
   - 确认出现「数量超出限制按完整订单截断」且「仅完整订单」的日志，且不再出现「部分数量」相关逻辑。

---

## 七、总结

| 项目 | 内容 |
|------|------|
| 根因 | 在可卖数量超出可用持仓时创建了部分数量订单对象，违反「订单不可拆分」且与订单过滤算法不一致 |
| 修复 | 仅在 `orderStorage.getProfitableSellOrders` 中改写截断逻辑：只选完整订单，不创建部分数量对象，超出时按低价优先选满后 break |
| 影响 | 仅订单存储一处逻辑；调用方接口与类型不变；可能不卖出或卖出数量小于可用持仓（当无法再选完整订单时） |
| 原则 | 系统性对齐「订单不可拆分」与现有过滤算法，不做兼容性/补丁式保留部分数量对象的实现 |
