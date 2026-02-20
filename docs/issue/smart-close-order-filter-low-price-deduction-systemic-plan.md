# 智能平仓订单记录过滤改造方案（低价整笔消除，全链路系统性修复）

## 1. 背景与目标

### 1.1 核心问题

当前订单记录过滤逻辑依赖"买入价与卖出成交价比较"来识别剩余买入订单。该逻辑在卖出委托实时改价场景下会失真：

**问题场景示例**：

- 假设有 3 笔买入订单：A(100股@1.00)、B(100股@1.10)、C(100股@1.20)
- 智能平仓时当前价 1.15，选出 A 和 B（共 200 股），提交卖出委托价 1.15
- 实时监控改价机制下，价格下跌，委托价改为 1.05，最终成交价 1.05
- **当前过滤逻辑**：保留成交价 >= 1.05 的订单 → 保留 B(1.10) 和 C(1.20)，过滤掉 A(1.00)
- **正确结果**：应该过滤掉 A 和 B（智能平仓选中的），保留 C

**根本原因**：卖出成交价在"实时监控+改单"机制下不是稳定边界，真实不变式应是：每笔卖出只会从当时可卖买单中扣减"卖出数量"。

### 1.2 改造目标

将过滤依据从"价格比较"改为"与智能平仓一致的低价优先整笔消除"，并确保启动、运行、重建、风控口径一致，属于系统性重构，不采用兼容性补丁。

---

## 2. 现状问题（根因与链路）

### 2.1 现状规则验证（代码级确认）

**文档规则**（`.claude/skills/core-program-business-logic/SKILL.md`）：

- 卖出数量不足时保留 `买入价 >= 卖出成交价` 的订单

**代码实现验证**：

1. **启动/重建过滤**（`src/core/orderRecorder/orderFilteringEngine.ts:141-142`）：

```typescript
let filteredBuyOrders = buyOrdersBeforeSell.filter(
  (buyOrder) => buyOrder.executedPrice >= sellPrice,
);
```

2. **运行时成交更新**（`src/core/orderRecorder/orderStorage.ts:196-200`）：

```typescript
const filtered = list.filter(
  (order) => Number.isFinite(order.executedPrice) && order.executedPrice >= executedPrice,
);
```

3. **智能平仓选单**（`src/core/orderRecorder/orderStorage.ts:477`）：

```typescript
const sortedOrders = [...availableOrders].sort((a, b) => a.executedPrice - b.executedPrice);
// 低价优先选单
```

4. **智能平仓部分数量问题**（`src/core/orderRecorder/orderStorage.ts:488-492`）：

```typescript
} else {
  // 部分数量 - 与"整笔消除"原则冲突
  finalOrders.push({
    ...order,
    executedQuantity: remaining,
  });
  remaining = 0;
}
```

5. **日内亏损偏移计算**（`src/core/riskController/dailyLossTracker.ts:47-48`）：

```typescript
const openBuyOrders =
  buyOrders.length > 0
    ? filteringEngine.applyFilteringAlgorithm([...buyOrders], [...sellOrders])
    : [];
```

**结论**：代码与文档一致，但业务上在改价场景下不稳定。

### 2.2 根因分析

1. **价格比较的不稳定性**：卖出成交价在"实时监控+改单"机制下会偏离信号生成时的预期价格
2. **语义不一致**：智能平仓是"低价优先选单"，但过滤是"价格比较"，两者语义不匹配
3. **真实不变式**：每笔卖出只会从当时可卖买单中按低价优先扣减"卖出数量"，与最终成交价无关

### 2.3 影响链路

1. **运行中链路**：`orderMonitor -> recordLocalSell -> updateAfterSell`
2. **启动/重建链路**：全量订单 -> `applyFilteringAlgorithm` -> 订单记录
3. **风控链路**：`dailyLossTracker` 使用过滤引擎计算未平仓成本
4. **智能平仓链路**：`getProfitableSellOrders` 选单 -> 提交卖出 -> 登记待成交占用

**一致性要求**：四条链路必须使用统一的"低价优先整笔消除"算法，否则会出现：

- 运行中正确、重启后错误
- 风控口径与持仓口径不一致
- 智能平仓选单与过滤结果不匹配
- 待成交占用防重失效

---

## 3. 可行性与合理性分析

### 3.1 结论

该方案**可行且合理**，前提是按"全链路统一算法 + 整笔语义一致"落地。

### 3.2 合理性依据

1. **与智能平仓一致**：智能平仓本身就是低价优先选单（`orderStorage.ts:477`），过滤也应低价优先消除
2. **与改价机制解耦**：不依赖最终成交价，避免改价导致的失真
3. **可复现性**：启动重建和运行时更新使用同一算法，结果一致
4. **风控口径统一**：日内亏损偏移、浮亏监控、订单记录三者口径一致

### 3.3 必须同时满足的约束

1. **统一策略内核**：过滤与本地更新必须共用同一个扣减策略函数
2. **整笔订单语义**：只允许整笔订单参与消除，不允许在过滤阶段引入"按股拆分补丁"
3. **智能平仓整笔选单**：`getProfitableSellOrders` 必须改为"仅返回完整订单"，totalQuantity 可能小于 maxSellQuantity
4. **待成交占用协调**：新的扣减策略应与待成交占用防重机制兼容
5. **业务边界明确**：若存在系统外人工卖出且不遵循低价优先，系统只能按既定策略回放

### 3.4 关键设计决策

**Q1：如果完整订单总量小于 maxSellQuantity，是否允许？**

- **答案**：允许。智能平仓返回的 totalQuantity 可能小于 maxSellQuantity，这是正常的"整笔语义"结果。

**Q2：排序规则如何确保稳定性和可复现性？**

- **答案**：主键为 `executedPrice asc`（低价优先），次键为 `executedTime asc`（时间早优先），三键为 `orderId asc`（ID 小优先），确保同价订单的排序稳定。

**Q3：待成交占用如何与新扣减策略协调？**

- **答案**：待成交占用机制通过 `relatedBuyOrderIds` 标记已占用订单，扣减策略在选单时排除已占用订单，两者独立但协调。

---

## 4. 系统性修改方案（详细设计）

### 4.1 统一策略内核（新增核心模块）

**文件**：`src/core/orderRecorder/sellDeductionPolicy.ts`（新增）

**职责**：提供统一的"低价优先整笔消除"纯函数，供过滤引擎、本地更新、智能平仓共用。

**核心函数签名**：

```typescript
/**
 * 低价优先整笔消除策略
 *
 * @param candidateBuyOrders 候选买单列表（会被内部排序，不修改原数组）
 * @param sellQuantity 卖出数量
 * @returns 剩余买单列表（整笔订单，不拆分）
 */
export function deductSellQuantityFromBuyOrders(
  candidateBuyOrders: ReadonlyArray<OrderRecord>,
  sellQuantity: number,
): OrderRecord[];
```

**算法详细说明**：

1. **输入验证**：
   - 如果 `candidateBuyOrders` 为空或 `sellQuantity <= 0`，直接返回候选列表副本
   - 如果 `sellQuantity` 不是有效正数，记录警告并返回候选列表副本

2. **排序规则**（确保稳定且可复现）：

   ```typescript
   const sorted = [...candidateBuyOrders].sort((a, b) => {
     // 主键：买入价从低到高（低价优先）
     if (a.executedPrice !== b.executedPrice) {
       return a.executedPrice - b.executedPrice;
     }
     // 次键：成交时间从早到晚（早成交优先）
     if (a.executedTime !== b.executedTime) {
       return a.executedTime - b.executedTime;
     }
     // 三键：订单 ID 字典序（确保稳定排序）
     return a.orderId.localeCompare(b.orderId);
   });
   ```

3. **整笔扣减逻辑**：

   ```typescript
   let remainingToDeduct = sellQuantity;
   const remainingOrders: OrderRecord[] = [];

   for (const order of sorted) {
     if (remainingToDeduct <= 0) {
       // 已扣减完毕，后续订单全部保留
       remainingOrders.push(order);
       continue;
     }

     if (order.executedQuantity <= remainingToDeduct) {
       // 整笔消除
       remainingToDeduct -= order.executedQuantity;
       // 不加入 remainingOrders（被消除）
     } else {
       // 订单数量大于剩余扣减量，保留该订单（整笔保留，不拆分）
       remainingOrders.push(order);
     }
   }

   return remainingOrders;
   ```

4. **输出**：剩余买单列表（整笔订单，不拆分）

**关键特性**：

- ✅ 纯函数，无副作用
- ✅ 稳定排序，可复现
- ✅ 整笔语义，不拆分订单
- ✅ 易于单元测试

### 4.2 改造过滤引擎（启动/重建真相源）

**文件**：`src/core/orderRecorder/orderFilteringEngine.ts`

**修改点 1**：删除价格比较过滤逻辑（第 141-148 行）

**修改前**：

```typescript
let filteredBuyOrders = buyOrdersBeforeSell.filter(
  (buyOrder) => buyOrder.executedPrice >= sellPrice,
);

filteredBuyOrders = adjustOrdersByQuantityLimit(filteredBuyOrders, maxRetainQuantity);
```

**修改后**：

```typescript
// 使用统一扣减策略：低价优先整笔消除
const filteredBuyOrders = deductSellQuantityFromBuyOrders(buyOrdersBeforeSell, sellQuantity);
```

**修改点 2**：删除 `adjustOrdersByQuantityLimit` 函数（第 64-99 行）

**原因**：该函数仅服务于旧的"价格过滤后数量超限"场景，新算法不需要。

**修改点 3**：更新顶部算法说明（第 9-24 行）

**修改后**：

```typescript
/**
 * 过滤算法（从旧到新累积过滤）：
 * 1. M0：成交时间 > 最新卖出订单时间的买入订单（无条件保留）
 * 2. 从最旧的卖出订单 D1 开始依次处理：
 *    - 获取成交时间 < D1 的买入订单
 *    - 若 D1 数量 >= 这些买入订单总量，视为全部卖出
 *    - 否则使用"低价优先整笔消除"策略扣减 D1 数量
 *    - M1 = 扣减结果 + 成交时间在 (D1, D2) 之间的买入订单（从原始候选订单获取）
 * 3. 对 D2 使用 M1 重复上述过程，得到 M2，以此类推
 * 4. 最终记录 = M0 + MN
 *
 * 关键约束：
 * - 必须按时间顺序从旧到新处理卖出订单
 * - 每轮过滤基于上一轮的结果（累积过滤）
 * - 时间间隔订单必须从原始候选订单获取，而非上一轮结果
 * - 使用"低价优先整笔消除"策略，不拆分订单
 */
```

**结果**：全量订单重放不再受卖出成交价波动影响，与智能平仓语义一致。

### 4.3 改造本地卖出更新（运行时链路）

**文件**：`src/core/orderRecorder/orderStorage.ts`

**修改点**：`updateAfterSell` 函数（第 195-204 行）

**修改前**：

```typescript
// 否则，仅保留成交价 >= 本次卖出价的买入订单
const filtered = list.filter(
  (order) => Number.isFinite(order.executedPrice) && order.executedPrice >= executedPrice,
);
setBuyOrdersList(symbol, filtered, isLongSymbol);
logger.info(
  `[现存订单记录] 本地卖出更新：${positionType} ${symbol} 卖出数量=${executedQuantity}，按价格过滤后剩余买入记录 ${filtered.length} 笔`,
);
```

**修改后**：

```typescript
// 使用统一扣减策略：低价优先整笔消除
const filtered = deductSellQuantityFromBuyOrders(list, executedQuantity);
setBuyOrdersList(symbol, filtered, isLongSymbol);

const deductedQuantity = calculateTotalQuantity(list) - calculateTotalQuantity(filtered);
logger.info(
  `[现存订单记录] 本地卖出更新：${positionType} ${symbol} 卖出数量=${executedQuantity}，` +
    `低价优先整笔消除后剩余买入记录 ${filtered.length} 笔（消除数量=${deductedQuantity}）`,
);
```

**关键变化**：

- ✅ 不再使用 `executedPrice` 参与过滤判定
- ✅ `executedPrice` 仅用于记录 `latestSellRecord`（审计/展示）
- ✅ 运行时更新与重启重建结果同构

**结果**：运行中成交后的订单记录与重启重建结果一致。

### 4.4 对齐智能平仓整笔语义（避免内部冲突）

**文件**：`src/core/orderRecorder/orderStorage.ts`

**修改点**：`getProfitableSellOrders` 函数（第 475-506 行）

**问题**：当前实现会创建"部分数量订单对象"（第 488-492 行），与"整笔消除"原则冲突。

**修改前**：

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
      // 部分数量 - 与"整笔消除"原则冲突
      finalOrders.push({
        ...order,
        executedQuantity: remaining,
      });
      remaining = 0;
    }
  }

  totalQuantity = maxSellQuantity;
  return { orders: finalOrders, totalQuantity };
}
```

**修改后**：

```typescript
if (maxSellQuantity !== undefined && totalQuantity > maxSellQuantity) {
  // 按价格从低到高排序（便宜的先卖）- 使用统一排序规则
  const sortedOrders = [...availableOrders].sort((a, b) => {
    if (a.executedPrice !== b.executedPrice) {
      return a.executedPrice - b.executedPrice;
    }
    if (a.executedTime !== b.executedTime) {
      return a.executedTime - b.executedTime;
    }
    return a.orderId.localeCompare(b.orderId);
  });

  let remaining = maxSellQuantity;
  const finalOrders: OrderRecord[] = [];

  for (const order of sortedOrders) {
    if (remaining <= 0) break;

    // 整笔语义：只选择完整订单
    if (order.executedQuantity <= remaining) {
      finalOrders.push(order);
      remaining -= order.executedQuantity;
    }
    // 如果订单数量大于剩余量，跳过该订单（不拆分）
  }

  // totalQuantity 为实际选中的订单总量，可能小于 maxSellQuantity
  totalQuantity = calculateTotalQuantity(finalOrders);

  logger.info(
    `[订单存储] 整笔截断: ${symbol} ${direction} ` +
      `原数量=${calculateTotalQuantity(sortedOrders)} ` +
      `限制=${maxSellQuantity} 实际=${totalQuantity}`,
  );

  return { orders: finalOrders, totalQuantity };
}
```

**关键变化**：

- ✅ 不再创建"部分数量订单对象"
- ✅ totalQuantity 可能小于 maxSellQuantity（整笔语义的自然结果）
- ✅ 排序规则与扣减策略一致

**结果**：智能平仓选单、防重占用、过滤回放三者语义一致。

### 4.5 文档与注释同步更新

**必改文档**：

1. **`.claude/skills/core-program-business-logic/SKILL.md`**：
   - 第 3.2 节"过滤算法"：删除"保留成交价 >= 卖出成交价"表述
   - 改为"使用低价优先整笔消除策略扣减卖出数量"
   - 第 3.3 节"本地记录更新"：同步修改

2. **`orderFilteringEngine.ts` 顶部算法说明**：已在 4.2 节说明

3. **`orderRecorder/index.ts` 相关注释**：更新订单记录器的算法描述

4. **`orderStorage.ts` 相关注释**：更新 `updateAfterSell` 和 `getProfitableSellOrders` 的注释

**要求**：删除所有"保留成交价 >= 卖出成交价"表述，统一为"低价优先整笔消除"。

---

## 5. 全链路一致性校验方案（上线门槛）

### 5.1 核心一致性断言

对任一 `symbol + direction`，以下结果必须恒等：

1. **运行时路径**：按成交事件序列逐笔调用本地更新后的剩余买单
2. **重建路径**：同一批历史订单一次性调用过滤引擎后的剩余买单

**验证方法**：

```typescript
// 伪代码
const runtimeResult = simulateRuntimeUpdates(buyOrders, sellOrders);
const rebuildResult = filteringEngine.applyFilteringAlgorithm(buyOrders, sellOrders);

assert.deepEqual(runtimeResult, rebuildResult, '运行时与重建结果必须一致');
```

**判定标准**：若不一致，视为逻辑错误，不允许上线。

### 5.2 最小测试矩阵

#### 5.2.1 基础场景测试

| 测试场景                   | 输入                                                                       | 预期输出                      | 验证点                       |
| -------------------------- | -------------------------------------------------------------------------- | ----------------------------- | ---------------------------- |
| 改单导致成交价低于部分买价 | 买入：A(100@1.00)、B(100@1.10)、C(100@1.20)<br>卖出：200股@1.05（改价后）  | 剩余：C(100@1.20)             | 旧逻辑会误删 A，新逻辑应稳定 |
| 多笔卖出串行               | 买入：A(100@1.00)、B(100@1.10)、C(100@1.20)<br>卖出1：100股<br>卖出2：50股 | 剩余：B(50@1.10)、C(100@1.20) | 验证逐笔累计结果             |
| 同价多单                   | 买入：A(100@1.00,t1)、B(100@1.00,t2)<br>卖出：100股                        | 剩余：B(100@1.00,t2)          | 验证稳定排序（时间早优先）   |
| 卖出量等于总量             | 买入：A(100@1.00)、B(100@1.10)<br>卖出：200股                              | 剩余：[]                      | 应清空                       |
| 卖出量大于总量             | 买入：A(100@1.00)、B(100@1.10)<br>卖出：300股                              | 剩余：[]                      | 应清空                       |
| 卖出量为0                  | 买入：A(100@1.00)、B(100@1.10)<br>卖出：0股                                | 剩余：A、B                    | 不应修改                     |

#### 5.2.2 智能平仓整笔语义测试

| 测试场景             | 输入                                              | 预期输出                      | 验证点                          |
| -------------------- | ------------------------------------------------- | ----------------------------- | ------------------------------- |
| 完整订单总量小于限制 | 盈利订单：A(100@1.00)、B(100@1.10)<br>限制：300股 | 返回：A、B，totalQuantity=200 | totalQuantity < maxSellQuantity |
| 完整订单总量等于限制 | 盈利订单：A(100@1.00)、B(100@1.10)<br>限制：200股 | 返回：A、B，totalQuantity=200 | totalQuantity = maxSellQuantity |
| 需要截断但不拆分     | 盈利订单：A(100@1.00)、B(150@1.10)<br>限制：200股 | 返回：A，totalQuantity=100    | 不返回 B（不拆分）              |

#### 5.2.3 运行时与重建一致性测试

| 测试场景           | 验证方法                                                         | 判定标准         |
| ------------------ | ---------------------------------------------------------------- | ---------------- |
| 运行中后重启       | 1. 模拟运行时逐笔更新<br>2. 重启后重建<br>3. 比较结果            | 订单列表完全一致 |
| 日内亏损偏移一致性 | 1. 运行时计算偏移<br>2. dailyLossTracker 计算偏移<br>3. 比较结果 | 偏移值完全一致   |

#### 5.2.4 待成交占用防重测试

| 测试场景         | 输入                                                          | 预期输出                   | 验证点     |
| ---------------- | ------------------------------------------------------------- | -------------------------- | ---------- |
| 待成交占用排除   | 盈利订单：A(100@1.00)、B(100@1.10)<br>待成交占用：A           | 返回：B，totalQuantity=100 | A 被排除   |
| 待成交成交后释放 | 盈利订单：A(100@1.00)、B(100@1.10)<br>待成交占用：A（已成交） | 返回：B，totalQuantity=100 | A 已被消除 |

### 5.3 回归测试要求

1. **单元测试**：`sellDeductionPolicy.ts` 的纯函数必须有完整单元测试覆盖
2. **集成测试**：过滤引擎、本地更新、智能平仓的集成测试
3. **端到端测试**：模拟完整交易流程，验证运行时与重建一致性
4. **性能测试**：确保新算法性能不低于旧算法（排序复杂度 O(n log n)）

---

## 6. 变更范围清单

### 6.1 必改代码文件

| 文件路径                                         | 变更类型 | 变更内容                                                                                  |
| ------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------- |
| `src/core/orderRecorder/sellDeductionPolicy.ts`  | **新增** | 统一扣减策略内核（纯函数）                                                                |
| `src/core/orderRecorder/orderFilteringEngine.ts` | **重构** | 删除价格比较过滤，改用统一扣减策略；删除 `adjustOrdersByQuantityLimit` 函数；更新算法说明 |
| `src/core/orderRecorder/orderStorage.ts`         | **重构** | `updateAfterSell` 改用统一扣减策略；`getProfitableSellOrders` 改为整笔语义（不拆分订单）  |
| `src/core/orderRecorder/index.ts`                | **更新** | 更新注释，说明新的过滤算法                                                                |
| `src/core/riskController/dailyLossTracker.ts`    | **验证** | 确保继续复用同一过滤引擎（无需修改代码，但需验证）                                        |

### 6.2 必改文档文件

| 文件路径                                                                   | 变更内容                                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `.claude/skills/core-program-business-logic/SKILL.md`                      | 第 3.2 节"过滤算法"、第 3.3 节"本地记录更新"：删除"保留成交价 >= 卖出成交价"表述，改为"低价优先整笔消除" |
| `docs/issue/smart-close-order-filter-low-price-deduction-systemic-plan.md` | 本文档（已更新）                                                                                         |

### 6.3 必改测试文件

| 文件路径                                                | 变更类型      | 变更内容                                                       |
| ------------------------------------------------------- | ------------- | -------------------------------------------------------------- |
| `tests/unit/orderRecorder/sellDeductionPolicy.test.ts`  | **新增**      | 统一扣减策略的单元测试                                         |
| `tests/unit/orderRecorder/orderFilteringEngine.test.ts` | **更新**      | 更新测试用例，覆盖新的过滤逻辑                                 |
| `tests/unit/orderRecorder/orderStorage.test.ts`         | **更新**      | 更新 `updateAfterSell` 和 `getProfitableSellOrders` 的测试用例 |
| `tests/integration/orderRecorder.test.ts`               | **新增/更新** | 运行时与重建一致性集成测试                                     |

### 6.4 变更影响评估

| 影响域             | 影响程度 | 说明                                |
| ------------------ | -------- | ----------------------------------- |
| 订单记录准确性     | **高**   | 修复改价场景下的过滤错误            |
| 运行时与重建一致性 | **高**   | 确保重启后订单记录一致              |
| 风控口径一致性     | **中**   | 日内亏损偏移计算与订单记录口径一致  |
| 智能平仓语义       | **中**   | 整笔选单与过滤逻辑一致              |
| 性能               | **低**   | 排序复杂度 O(n log n)，与旧逻辑相当 |
| 向后兼容性         | **无**   | 系统性重构，不保留旧规则            |

---

## 7. 实施顺序（推荐）

### 7.1 阶段 1：核心策略实现（1-2 天）

**目标**：建立统一扣减策略内核，确保算法正确性。

1. **新增 `sellDeductionPolicy.ts`**：
   - 实现 `deductSellQuantityFromBuyOrders` 纯函数
   - 编写完整单元测试（覆盖所有边界情况）
   - 验证排序稳定性和可复现性

2. **代码审查**：
   - 确认算法逻辑正确
   - 确认排序规则稳定
   - 确认边界情况处理完善

### 7.2 阶段 2：过滤引擎改造（1-2 天）

**目标**：改造启动/重建链路，确保重放场景正确。

1. **修改 `orderFilteringEngine.ts`**：
   - 删除价格比较过滤逻辑
   - 删除 `adjustOrdersByQuantityLimit` 函数
   - 调用统一扣减策略
   - 更新算法说明注释

2. **更新单元测试**：
   - 更新 `orderFilteringEngine.test.ts`
   - 验证重放场景（特别是改价场景）

3. **集成测试**：
   - 验证全量订单重放结果正确

### 7.3 阶段 3：本地更新改造（1 天）

**目标**：改造运行时链路，确保运行中更新正确。

1. **修改 `orderStorage.ts` 的 `updateAfterSell`**：
   - 删除价格比较过滤逻辑
   - 调用统一扣减策略
   - 更新日志输出

2. **更新单元测试**：
   - 更新 `orderStorage.test.ts` 中 `updateAfterSell` 的测试用例

3. **运行时与重建一致性测试**：
   - 编写集成测试，验证运行时与重建结果一致
   - 测试多笔卖出串行场景

### 7.4 阶段 4：智能平仓整笔语义（1 天）

**目标**：改造智能平仓选单，确保整笔语义一致。

1. **修改 `orderStorage.ts` 的 `getProfitableSellOrders`**：
   - 删除"部分数量订单对象"逻辑
   - 改为整笔选单（不拆分订单）
   - 更新排序规则与扣减策略一致

2. **更新单元测试**：
   - 更新 `orderStorage.test.ts` 中 `getProfitableSellOrders` 的测试用例
   - 验证 totalQuantity 可能小于 maxSellQuantity

3. **智能平仓集成测试**：
   - 验证智能平仓选单与过滤结果一致

### 7.5 阶段 5：风控口径验证（1 天）

**目标**：验证风控链路使用统一算法，确保口径一致。

1. **验证 `dailyLossTracker.ts`**：
   - 确认继续使用 `filteringEngine.applyFilteringAlgorithm`
   - 无需修改代码

2. **日内亏损偏移测试**：
   - 验证日内亏损偏移计算与订单记录口径一致
   - 测试已实现亏损场景下的偏移调整

3. **浮亏监控测试**：
   - 验证浮亏监控使用正确的未平仓成本

### 7.6 阶段 6：文档更新与全链路回归（1 天）

**目标**：更新文档，执行全链路回归测试。

1. **更新业务逻辑文档**：
   - 修改 `.claude/skills/core-program-business-logic/SKILL.md`
   - 删除所有"保留成交价 >= 卖出成交价"表述
   - 统一为"低价优先整笔消除"

2. **更新代码注释**：
   - `orderRecorder/index.ts`
   - `orderFilteringEngine.ts`
   - `orderStorage.ts`

3. **全链路回归测试**：
   - 执行所有单元测试
   - 执行所有集成测试
   - 执行端到端测试（模拟完整交易流程）
   - 验证性能无明显下降

4. **上线前检查清单**：
   - ✅ 所有测试通过
   - ✅ 运行时与重建一致性验证通过
   - ✅ 日内亏损偏移一致性验证通过
   - ✅ 智能平仓选单与过滤结果一致
   - ✅ 文档与代码同步更新
   - ✅ 代码审查通过

### 7.7 预估工作量

| 阶段                     | 预估时间   | 关键里程碑                 |
| ------------------------ | ---------- | -------------------------- |
| 阶段 1：核心策略实现     | 1-2 天     | 统一扣减策略通过单元测试   |
| 阶段 2：过滤引擎改造     | 1-2 天     | 重放场景测试通过           |
| 阶段 3：本地更新改造     | 1 天       | 运行时与重建一致性测试通过 |
| 阶段 4：智能平仓整笔语义 | 1 天       | 智能平仓集成测试通过       |
| 阶段 5：风控口径验证     | 1 天       | 风控链路测试通过           |
| 阶段 6：文档更新与回归   | 1 天       | 全链路回归测试通过         |
| **总计**                 | **6-8 天** | 所有测试通过，准备上线     |

---

## 8. 风险评估与缓解措施

### 8.1 技术风险

| 风险项             | 风险等级 | 影响                       | 缓解措施                                |
| ------------------ | -------- | -------------------------- | --------------------------------------- |
| 算法逻辑错误       | **高**   | 订单记录错误，影响交易决策 | 完整单元测试 + 集成测试 + 代码审查      |
| 运行时与重建不一致 | **高**   | 重启后订单记录错误         | 一致性集成测试 + 端到端测试             |
| 性能下降           | **中**   | 影响主循环性能             | 性能测试 + 算法复杂度分析（O(n log n)） |
| 边界情况遗漏       | **中**   | 特殊场景下行为异常         | 完整测试矩阵覆盖                        |

### 8.2 业务风险

| 风险项               | 风险等级 | 影响                       | 缓解措施                       |
| -------------------- | -------- | -------------------------- | ------------------------------ |
| 智能平仓行为变化     | **中**   | 卖出数量可能小于预期       | 文档说明 + 日志记录 + 监控告警 |
| 历史订单回放结果变化 | **低**   | 启动时订单记录与旧版本不同 | 预期行为，文档说明             |
| 系统外人工卖出       | **低**   | 无法按低价优先回放         | 业务边界明确，文档说明         |

### 8.3 缓解措施详细说明

1. **完整测试覆盖**：
   - 单元测试覆盖率 > 90%
   - 集成测试覆盖所有关键链路
   - 端到端测试模拟真实交易场景

2. **代码审查**：
   - 核心算法必须经过至少 2 人审查
   - 关注边界情况和错误处理

3. **灰度发布**：
   - 先在测试环境运行 1-2 周
   - 验证订单记录准确性
   - 验证运行时与重建一致性

4. **监控告警**：
   - 监控订单记录数量异常
   - 监控智能平仓卖出数量异常
   - 监控日内亏损偏移异常

5. **回滚方案**：
   - 保留旧版本代码分支
   - 如发现严重问题，可快速回滚

### 8.4 上线检查清单

- [ ] 所有单元测试通过（覆盖率 > 90%）
- [ ] 所有集成测试通过
- [ ] 运行时与重建一致性验证通过
- [ ] 日内亏损偏移一致性验证通过
- [ ] 智能平仓选单与过滤结果一致
- [ ] 性能测试通过（无明显下降）
- [ ] 文档与代码同步更新
- [ ] 代码审查通过（至少 2 人）
- [ ] 测试环境运行 1-2 周无异常
- [ ] 监控告警配置完成
- [ ] 回滚方案准备完成

---

## 9. 最终结论

### 9.1 方案评估

该改造方向**正确且必要**，是对现有业务约束（智能平仓低价优先）的系统性收敛。

**核心优势**：

1. ✅ 修复改价场景下的订单记录过滤错误
2. ✅ 确保运行时与重建一致性
3. ✅ 统一风控口径（日内亏损偏移、浮亏监控）
4. ✅ 对齐智能平仓语义（低价优先整笔选单）
5. ✅ 算法简洁清晰，易于理解和维护

**关键成功因素**：

1. 严格执行"统一策略内核 + 启动/运行/重建同口径 + 整笔语义一致"
2. 完整测试覆盖（单元测试 + 集成测试 + 端到端测试）
3. 运行时与重建一致性验证通过
4. 文档与代码同步更新

### 9.2 预期效果

**修复前**：

- ❌ 改价场景下订单记录过滤错误
- ❌ 运行时与重建结果可能不一致
- ❌ 智能平仓选单与过滤逻辑语义不一致
- ❌ 风控口径可能偏差

**修复后**：

- ✅ 改价场景下订单记录过滤正确
- ✅ 运行时与重建结果完全一致
- ✅ 智能平仓选单与过滤逻辑语义一致
- ✅ 风控口径统一准确

### 9.3 后续优化建议

1. **性能优化**：如果订单数量很大（> 1000 笔），可考虑使用更高效的数据结构（如优先队列）
2. **监控增强**：增加订单记录准确性监控指标
3. **文档完善**：补充更多业务场景示例和故障排查指南

---

## 附录 A：核心代码示例

### A.1 统一扣减策略（sellDeductionPolicy.ts）

```typescript
import type { OrderRecord } from '../../types/services.js';

/**
 * 低价优先整笔消除策略
 *
 * 算法说明：
 * 1. 按 executedPrice asc -> executedTime asc -> orderId asc 排序
 * 2. 从低到高整笔消除，直到消除量达到卖出数量或无单可消除
 * 3. 返回剩余买单列表（整笔订单，不拆分）
 *
 * @param candidateBuyOrders 候选买单列表（会被内部排序，不修改原数组）
 * @param sellQuantity 卖出数量
 * @returns 剩余买单列表（整笔订单，不拆分）
 */
export function deductSellQuantityFromBuyOrders(
  candidateBuyOrders: ReadonlyArray<OrderRecord>,
  sellQuantity: number,
): OrderRecord[] {
  // 输入验证
  if (candidateBuyOrders.length === 0 || sellQuantity <= 0) {
    return [...candidateBuyOrders];
  }

  if (!Number.isFinite(sellQuantity) || sellQuantity < 0) {
    console.warn(`[扣减策略] 无效的卖出数量: ${sellQuantity}，返回原列表`);
    return [...candidateBuyOrders];
  }

  // 排序：低价优先 -> 时间早优先 -> ID 小优先
  const sorted = [...candidateBuyOrders].sort((a, b) => {
    // 主键：买入价从低到高（低价优先）
    if (a.executedPrice !== b.executedPrice) {
      return a.executedPrice - b.executedPrice;
    }
    // 次键：成交时间从早到晚（早成交优先）
    if (a.executedTime !== b.executedTime) {
      return a.executedTime - b.executedTime;
    }
    // 三键：订单 ID 字典序（确保稳定排序）
    return a.orderId.localeCompare(b.orderId);
  });

  // 整笔扣减
  let remainingToDeduct = sellQuantity;
  const remainingOrders: OrderRecord[] = [];

  for (const order of sorted) {
    if (remainingToDeduct <= 0) {
      // 已扣减完毕，后续订单全部保留
      remainingOrders.push(order);
      continue;
    }

    if (order.executedQuantity <= remainingToDeduct) {
      // 整笔消除
      remainingToDeduct -= order.executedQuantity;
      // 不加入 remainingOrders（被消除）
    } else {
      // 订单数量大于剩余扣减量，保留该订单（整笔保留，不拆分）
      remainingOrders.push(order);
    }
  }

  return remainingOrders;
}
```

### A.2 过滤引擎调用示例（orderFilteringEngine.ts）

```typescript
// 修改前（旧逻辑）
let filteredBuyOrders = buyOrdersBeforeSell.filter(
  (buyOrder) => buyOrder.executedPrice >= sellPrice,
);

filteredBuyOrders = adjustOrdersByQuantityLimit(filteredBuyOrders, maxRetainQuantity);

// 修改后（新逻辑）
const filteredBuyOrders = deductSellQuantityFromBuyOrders(buyOrdersBeforeSell, sellQuantity);
```

### A.3 本地更新调用示例（orderStorage.ts）

```typescript
// 修改前（旧逻辑）
const filtered = list.filter(
  (order) => Number.isFinite(order.executedPrice) && order.executedPrice >= executedPrice,
);

// 修改后（新逻辑）
const filtered = deductSellQuantityFromBuyOrders(list, executedQuantity);
```

---

## 附录 B：测试用例示例

### B.1 基础扣减测试

```typescript
describe('deductSellQuantityFromBuyOrders', () => {
  it('应该按低价优先整笔消除', () => {
    const buyOrders = [
      { orderId: 'A', executedPrice: 1.0, executedQuantity: 100, executedTime: 1000 },
      { orderId: 'B', executedPrice: 1.1, executedQuantity: 100, executedTime: 2000 },
      { orderId: 'C', executedPrice: 1.2, executedQuantity: 100, executedTime: 3000 },
    ];

    const result = deductSellQuantityFromBuyOrders(buyOrders, 150);

    expect(result).toEqual([
      { orderId: 'B', executedPrice: 1.1, executedQuantity: 100, executedTime: 2000 },
      { orderId: 'C', executedPrice: 1.2, executedQuantity: 100, executedTime: 3000 },
    ]);
  });

  it('应该在同价时按时间早优先', () => {
    const buyOrders = [
      { orderId: 'A', executedPrice: 1.0, executedQuantity: 100, executedTime: 2000 },
      { orderId: 'B', executedPrice: 1.0, executedQuantity: 100, executedTime: 1000 },
    ];

    const result = deductSellQuantityFromBuyOrders(buyOrders, 100);

    expect(result).toEqual([
      { orderId: 'A', executedPrice: 1.0, executedQuantity: 100, executedTime: 2000 },
    ]);
  });

  it('应该整笔保留无法完全消除的订单', () => {
    const buyOrders = [
      { orderId: 'A', executedPrice: 1.0, executedQuantity: 100, executedTime: 1000 },
      { orderId: 'B', executedPrice: 1.1, executedQuantity: 150, executedTime: 2000 },
    ];

    const result = deductSellQuantityFromBuyOrders(buyOrders, 120);

    // A 被消除（100），B 保留（150 > 20，整笔保留）
    expect(result).toEqual([
      { orderId: 'B', executedPrice: 1.1, executedQuantity: 150, executedTime: 2000 },
    ]);
  });
});
```

---

## 附录 C：变更历史

| 版本 | 日期       | 变更内容                                       | 作者   |
| ---- | ---------- | ---------------------------------------------- | ------ |
| 1.0  | 2025-01-XX | 初始版本                                       | -      |
| 2.0  | 2025-01-XX | 详细设计补充：增加代码示例、测试矩阵、风险评估 | Claude |
