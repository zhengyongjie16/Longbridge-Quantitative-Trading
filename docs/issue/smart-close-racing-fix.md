# 智能平仓竞态条件修复 - 实现文档

## 一、问题概述

**问题类型**：竞态条件（Race Condition）导致的过度卖出

**影响范围**：启用智能平仓功能时，多个卖出信号可能选中相同的盈利订单，导致同一买入订单被卖出两次。

---

## 二、问题根因分析

### 2.1 数据流断裂

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         修复前的数据流断裂                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   订单记录（历史成交）              待成交订单（TrackedOrders）           │
│         │                              │                                  │
│         │   买入成交 → recordLocalBuy   │                                  │
│         │──────────────────────────────│                                  │
│         │                              │                                  │
│         │   卖出成交 → recordLocalSell │                                  │
│         │──────────────────────────────│                                  │
│         │                              │                                  │
│         │                              │  卖出信号 → submitOrder          │
│         │                              │         → trackOrder            │
│         │                              │                                  │
│         │                              ▼                                  │
│         │                    查询不到！  ← getBuyOrdersBelowPrice         │
│         │                              │                                  │
│         ▼                              ▼                                  │
│   过时的订单记录 ← getBuyOrdersBelowPrice                                 │
│                                                                          │
│   问题：智能平仓查询的是"历史成交记录"，而非"当前待成交状态"              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 时序图分析

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         订单处理时序图                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  T0  卖出信号A生成                                                        │
│      │                                                                   │
│      ▼                                                                   │
│  T1  getBuyOrdersBelowPrice() → [订单X, 订单Y] (盈利订单)                │
│      │                                                                   │
│      ▼                                                                   │
│  T2  信号A提交卖出订单 → 订单进入WebSocket追踪                            │
│      │                                                                   │
│      ▼                                                                   │
│  T3  新卖出信号B生成 (独立异步任务)                                        │
│      │                                                                   │
│      ▼                                                                   │
│  T4  getBuyOrdersBelowPrice() → 仍返回 [订单X, 订单Y] ⚠️                  │
│      │    (订单X/Y尚未成交，订单记录未更新)                                 │
│      ▼                                                                   │
│  T5  信号B也提交卖出订单 → 选中同一批订单                                 │
│      │                                                                   │
│      ▼                                                                   │
│  T6  订单X/Y成交 → recordLocalSell() 更新订单记录                        │
│      │    (此时代订单X/Y已被卖出两次)                                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.3 核心矛盾

| 层面         | 订单记录        | 待成交订单追踪 |
| ------------ | --------------- | -------------- |
| 买入         | ✅ 即时更新     | ❌ 不追踪      |
| 卖出         | ❌ 成交后才更新 | ✅ 实时追踪    |
| 智能平仓查询 | 查询订单记录    | ❌ 不使用      |

---

## 三、解决方案

### 3.1 设计原则

1. **职责统一**：在 `orderRecorder` 中统一管理历史记录和待成交追踪
2. **原子查询**：计算可卖出订单时同时考虑历史记录和待成交状态
3. **提交即追踪**：订单提交时立即注册追踪信息
4. **状态闭环**：成交/取消时正确更新追踪状态

### 3.2 修复后的数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         修复后的数据流                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  卖出信号 → getProfitableSellOrders()                                    │
│                      │                                                   │
│                      ├── 1. 查询盈利订单 → [订单X, 订单Y]                │
│                      ├── 2. 查询待成交卖出 → 记录占用ID                  │
│                      └── 3. 过滤被占用订单 → []                          │
│                      │                                                   │
│                      ▼                                                   │
│              提交订单 → addPendingSell(关联ID)                            │
│                      │                                                   │
│                      ▼                                                   │
│              追踪订单 → pendingSells Map 包含占用信息                     │
│                                                                          │
│  新卖出信号 → getProfitableSellOrders()                                  │
│                      │                                                   │
│                      ├── 1. 查询盈利订单 → [订单X, 订单Y]                │
│                      ├── 2. 查询待成交卖出 → X,Y已被占用！                │
│                      └── 3. 过滤后 → []                                  │
│                      │                                                   │
│                      ▼                                                   │
│              返回空列表 → 信号 HOLD                                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 四、详细实现

### 4.1 类型定义

**文件**: `src/core/orderRecorder/types.ts`

```typescript
/**
 * 待成交卖出订单信息
 * 用于智能平仓防重追踪，记录已提交但未成交的卖出订单
 */
export interface PendingSellInfo {
  /** 卖出订单ID */
  readonly orderId: string;
  /** 标的代码 */
  readonly symbol: string;
  /** 方向 */
  readonly direction: 'LONG' | 'SHORT';
  /** 提交数量 */
  readonly submittedQuantity: number;
  /** 已成交数量 */
  readonly filledQuantity: number;
  /** 关联的买入订单ID列表（精确标记哪些订单被占用） */
  readonly relatedBuyOrderIds: readonly string[];
  /** 状态 */
  readonly status: 'pending' | 'partial' | 'filled' | 'cancelled';
  /** 提交时间 */
  readonly submittedAt: number;
}

/**
 * 盈利订单查询结果
 */
export interface ProfitableOrderResult {
  /** 可卖出的订单记录列表 */
  readonly orders: ReadonlyArray<OrderRecord>;
  /** 这些订单的总数量 */
  readonly totalQuantity: number;
}
```

**文件**: `src/types/index.ts` - Signal 类型扩展

```typescript
export type Signal = {
  // ... 现有字段

  /** 关联的买入订单ID列表（仅卖出订单使用，用于智能平仓防重） */
  relatedBuyOrderIds?: readonly string[] | null;
};
```

### 4.2 存储实现

**文件**: `src/core/orderRecorder/orderStorage.ts`

```typescript
export const createOrderStorage = (_deps: OrderStorageDeps = {}): OrderStorage => {
  // 现有数据结构
  const longBuyOrdersMap: Map<string, OrderRecord[]> = new Map();
  const shortBuyOrdersMap: Map<string, OrderRecord[]> = new Map();

  // ========== 新增：待成交卖出订单追踪 ==========
  const pendingSells = new Map<string, PendingSellInfo>();

  // ========== 核心：可卖出盈利订单计算（防重逻辑） ==========

  function getProfitableSellOrders(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    currentPrice: number,
    maxSellQuantity?: number,
  ): ProfitableOrderResult {
    // 1. 获取所有盈利订单（买入价 < 当前价）
    const profitableOrders = getBuyOrdersBelowPrice(currentPrice, direction, symbol);

    if (profitableOrders.length === 0) {
      return { orders: [], totalQuantity: 0 };
    }

    // 2. 获取已被待成交卖出订单占用的订单ID
    const pendingSellsList = getPendingSellOrders(symbol, direction);
    const occupiedOrderIds = new Set<string>();

    for (const sellOrder of pendingSellsList) {
      for (const buyOrderId of sellOrder.relatedBuyOrderIds) {
        occupiedOrderIds.add(buyOrderId);
      }
    }

    // 3. 过滤掉被占用的订单
    const availableOrders = profitableOrders.filter(
      (order) => !occupiedOrderIds.has(order.orderId),
    );

    // ... 数量截断逻辑

    return {
      orders: availableOrders,
      totalQuantity: Math.min(totalQuantity, maxSellQuantity ?? totalQuantity),
    };
  }

  // ========== 待成交订单追踪方法 ==========

  function addPendingSell(info: Omit<PendingSellInfo, 'filledQuantity' | 'status'>): void {
    const record: PendingSellInfo = {
      ...info,
      filledQuantity: 0,
      status: 'pending',
    };
    pendingSells.set(info.orderId, record);
  }

  function markSellFilled(orderId: string): PendingSellInfo | null {
    const record = pendingSells.get(orderId);
    if (!record) return null;
    pendingSells.delete(orderId);
    return { ...record, filledQuantity: record.submittedQuantity, status: 'filled' };
  }

  function markSellPartialFilled(orderId: string, filledQuantity: number): PendingSellInfo | null {
    const record = pendingSells.get(orderId);
    if (!record) return null;
    const status = filledQuantity >= record.submittedQuantity ? 'filled' : 'partial';
    if (status === 'filled') {
      pendingSells.delete(orderId);
    } else {
      pendingSells.set(orderId, { ...record, filledQuantity, status });
    }
    return { ...record, filledQuantity, status };
  }

  function markSellCancelled(orderId: string): PendingSellInfo | null {
    const record = pendingSells.get(orderId);
    if (!record) return null;
    pendingSells.delete(orderId);
    return record;
  }

  function getPendingSellOrders(
    symbol: string,
    direction: 'LONG' | 'SHORT',
  ): ReadonlyArray<PendingSellInfo> {
    return Array.from(pendingSells.values()).filter(
      (order) => order.symbol === symbol && order.direction === direction,
    );
  }

  function getBuyOrderIdsOccupiedBySell(orderId: string): ReadonlyArray<string> | null {
    return pendingSells.get(orderId)?.relatedBuyOrderIds ?? null;
  }

  return {
    // ... 现有方法
    getBuyOrdersBelowPrice,
    calculateTotalQuantity,

    // 新增方法
    addPendingSell,
    markSellFilled,
    markSellPartialFilled,
    markSellCancelled,
    getPendingSellOrders,
    getProfitableSellOrders,
    getBuyOrderIdsOccupiedBySell,
  };
};
```

### 4.3 对外接口扩展

**文件**: `src/core/orderRecorder/index.ts`

```typescript
export function createOrderRecorder(deps: OrderRecorderDeps): OrderRecorder {
  const storage = createOrderStorage(deps);

  return {
    ...storage,

    /** 提交卖出订单时调用（添加待成交追踪） */
    submitSellOrder(
      orderId: string,
      symbol: string,
      direction: 'LONG' | 'SHORT',
      quantity: number,
      relatedBuyOrderIds: readonly string[],
    ): void {
      storage.addPendingSell({
        orderId,
        symbol,
        direction,
        submittedQuantity: quantity,
        relatedBuyOrderIds,
        submittedAt: Date.now(),
      });
    },

    /** 标记卖出订单完全成交 */
    markSellFilled(orderId: string): PendingSellInfo | null {
      return storage.markSellFilled(orderId);
    },

    /** 标记卖出订单部分成交 */
    markSellPartialFilled(orderId: string, filledQuantity: number): PendingSellInfo | null {
      return storage.markSellPartialFilled(orderId, filledQuantity);
    },

    /** 标记卖出订单取消 */
    markSellCancelled(orderId: string): PendingSellInfo | null {
      return storage.markSellCancelled(orderId);
    },

    /** 获取待成交卖出订单列表 */
    getPendingSellOrders(
      symbol: string,
      direction: 'LONG' | 'SHORT',
    ): ReadonlyArray<PendingSellInfo> {
      return storage.getPendingSellOrders(symbol, direction);
    },

    /** 获取可卖出的盈利订单（核心防重逻辑） */
    getProfitableSellOrders(
      symbol: string,
      direction: 'LONG' | 'SHORT',
      currentPrice: number,
      maxSellQuantity?: number,
    ): ProfitableOrderResult {
      return storage.getProfitableSellOrders(symbol, direction, currentPrice, maxSellQuantity);
    },

    /** 获取被指定订单占用的买入订单ID列表 */
    getBuyOrderIdsOccupiedBySell(orderId: string): ReadonlyArray<string> | null {
      return storage.getBuyOrderIdsOccupiedBySell(orderId);
    },
  };
}
```

---

## 五、模块集成

### 5.1 信号处理器修改

**文件**: `src/core/signalProcessor/utils.ts`

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
    return { quantity: null, shouldHold: true, reason: '订单记录不可用', relatedBuyOrderIds: [] };
  }

  // 使用新增的防重查询接口
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
      reason: '无盈利订单或已被占用',
      relatedBuyOrderIds: [],
    };
  }

  // 提取关联的订单ID列表
  const relatedBuyOrderIds = result.orders.map((order) => order.orderId);

  return {
    quantity: result.totalQuantity,
    shouldHold: false,
    reason: `智能平仓：当前价=${currentPrice.toFixed(3)}，可卖出=${result.totalQuantity}股`,
    relatedBuyOrderIds,
  };
}
```

**文件**: `src/core/signalProcessor/sellQuantityCalculator.ts`

```typescript
export const processSellSignals = (
  signals: Signal[],
  // ...
): Signal[] => {
  for (const sig of signals) {
    if (sig.action !== 'SELLCALL' && sig.action !== 'SELLPUT') continue;

    // ... 验证逻辑 ...

    if (isDoomsdaySignal) {
      // 末日保护：无条件清仓
      sig.quantity = position.availableQuantity;
    } else {
      const result = calculateSellQuantity();
      // ...

      if (result.shouldHold) {
        sig.action = 'HOLD';
        sig.reason = result.reason;
        sig.relatedBuyOrderIds = null;
      } else {
        sig.quantity = result.quantity;
        sig.reason = result.reason;
        // 设置关联的买入订单ID列表（用于防重追踪）
        sig.relatedBuyOrderIds = result.relatedBuyOrderIds;
      }
    }
  }
  return signals;
};
```

### 5.2 订单监控修改

**文件**: `src/core/trader/orderMonitor.ts`

```typescript
function handleOrderChanged(event: PushOrderChanged): void {
  const trackedOrder = trackedOrders.get(orderId);
  if (!trackedOrder) return;

  if (event.status === OrderStatus.Filled) {
    // 买入成交
    if (trackedOrder.side === OrderSide.Buy) {
      orderRecorder.recordLocalBuy(/* ... */);
    }
    // 卖出成交
    else {
      orderRecorder.recordLocalSell(/* ... */);
      // ========== 新增：更新待成交追踪 ==========
      orderRecorder.markSellFilled(String(orderId));
    }
    trackedOrders.delete(orderId);
    return;
  }

  // 订单取消或拒绝
  if (event.status === OrderStatus.Canceled || event.status === OrderStatus.Rejected) {
    // ========== 新增：释放追踪 ==========
    if (trackedOrder.side === OrderSide.Sell) {
      orderRecorder.markSellCancelled(String(orderId));
    }
    trackedOrders.delete(orderId);
    return;
  }

  // 部分成交
  if (event.status === OrderStatus.PartialFilled) {
    // ========== 新增：更新追踪 ==========
    if (trackedOrder.side === OrderSide.Sell) {
      orderRecorder.markSellPartialFilled(String(orderId), executedQuantity);
    }
  }
}
```

### 5.3 订单执行修改

**文件**: `src/core/trader/orderExecutor.ts`

```typescript
async function submitOrder(
  ctx: TradeContext,
  signal: Signal,
  // ...
): Promise<void> {
  // ... 提交订单逻辑 ...

  // 提交成功后
  const orderId = resp.orderId;

  // ========== 新增：如果是卖出订单，注册待成交追踪 ==========
  const isSellOrder = side === OrderSide.Sell;
  if (isSellOrder && signal.relatedBuyOrderIds) {
    const direction = isLongSymbol ? 'LONG' : 'SHORT';
    orderRecorder.submitSellOrder(
      String(orderId),
      symbol,
      direction,
      submittedQuantityNum,
      signal.relatedBuyOrderIds,
    );
  }

  // ... 后续逻辑 ...
}
```

---

## 六、完整调用流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         完整卖出流程图                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  阶段一：信号处理                                                     │ │
│  ├─────────────────────────────────────────────────────────────────────┤ │
│  │  sellQuantityCalculator.processSellSignals()                        │ │
│  │       ↓                                                             │ │
│  │  resolveSellQuantityBySmartClose()                                  │ │
│  │       ↓                                                             │ │
│  │  orderRecorder.getProfitableSellOrders()                            │ │
│  │       ├── 查询盈利订单 [订单X, 订单Y]                                │ │
│  │       ├── 查询待成交卖出，发现无占用                                  │ │
│  │       └── 返回可用订单 + 关联ID [X, Y]                               │ │
│  │       ↓                                                             │ │
│  │  设置 sig.quantity = 10, sig.relatedBuyOrderIds = ['X', 'Y']        │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                    ↓                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  阶段二：订单执行                                                     │ │
│  ├─────────────────────────────────────────────────────────────────────┤ │
│  │  orderExecutor.executeSignals()                                      │ │
│  │       ↓                                                             │ │
│  │  submitOrder() → API提交成功                                         │ │
│  │       ↓                                                             │ │
│  │  orderRecorder.submitSellOrder(                                      │ │
│  │    orderId='A', symbol, LONG, 10, ['X', 'Y']                       │ │
│  │  )                                                                   │ │
│  │       ↓                                                             │ │
│  │  pendingSells.set('A', {orderId:'A', relatedBuyOrderIds:['X','Y']})│ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                    ↓                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  阶段三：订单监控                                                     │ │
│  ├─────────────────────────────────────────────────────────────────────┤ │
│  │  WebSocket 回调: OrderStatus.Filled                                  │ │
│  │       ↓                                                             │ │
│  │  orderRecorder.markSellFilled('A')                                   │ │
│  │       ↓                                                             │ │
│  │  pendingSells.delete('A')                                            │ │
│  │       ↓                                                             │ │
│  │  orderRecorder.recordLocalSell()                                     │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ═══════════════════════════════════════════════════════════════════════│
│                                                                          │
│  并发场景：第二个卖出信号                                                   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  新卖出信号B生成                                                      │ │
│  │       ↓                                                             │ │
│  │  resolveSellQuantityBySmartClose()                                   │ │
│  │       ↓                                                             │ │
│  │  orderRecorder.getProfitableSellOrders()                             │ │
│  │       ├── 查询盈利订单 [订单X, 订单Y, 订单Z]                        │ │
│  │       ├── 查询待成交卖出 → 发现订单A占用 [X, Y]                     │ │
│  │       └── 过滤后 → [订单Z]                                          │ │
│  │       ↓                                                             │ │
│  │  返回数量=5 (仅订单Z)                                                │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 七、边界情况处理

### 7.1 订单取消/拒绝

```typescript
// 在 handleOrderChanged 中
if (event.status === OrderStatus.Canceled || event.status === OrderStatus.Rejected) {
  if (trackedOrder.side === OrderSide.Sell) {
    // 释放占用的买入订单ID
    orderRecorder.markSellCancelled(String(orderId));
  }
}
```

### 7.2 末日保护清仓

末日保护信号不走智能平仓逻辑，不设置 `relatedBuyOrderIds`：

```typescript
if (isDoomsdaySignal) {
  // 无条件清仓，不走防重逻辑
  sig.quantity = position.availableQuantity;
  // 不设置 relatedBuyOrderIds
}
```

### 7.3 并发多个卖出订单

系统支持并发多个卖出订单，只要选中的盈利订单不重叠即可正常工作。

### 7.4 订单合并场景

如果启用卖出合并功能，合并后的订单需要合并关联的买入订单ID列表。

---

## 八、文件修改清单

| 序号 | 文件                                                 | 修改类型 | 说明                                                                           |
| ---- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| 1    | `src/core/orderRecorder/types.ts`                    | 修改     | 新增 `PendingSellInfo`、`ProfitableOrderResult` 类型，扩展 `OrderStorage` 接口 |
| 2    | `src/core/orderRecorder/orderStorage.ts`             | 修改     | 实现待成交追踪与防重计算                                                       |
| 3    | `src/core/orderRecorder/index.ts`                    | 修改     | 扩展 `OrderRecorder` 接口                                                      |
| 4    | `src/types/index.ts`                                 | 修改     | Signal 新增 `relatedBuyOrderIds` 字段，`OrderRecorder` 接口扩展                |
| 5    | `src/core/signalProcessor/utils.ts`                  | 修改     | 改用 `getProfitableSellOrders()`                                               |
| 6    | `src/core/signalProcessor/sellQuantityCalculator.ts` | 修改     | 传递关联订单ID                                                                 |
| 7    | `src/core/trader/orderMonitor.ts`                    | 修改     | 成交/取消/部分成交回调更新追踪                                                 |
| 8    | `src/core/trader/orderExecutor.ts`                   | 修改     | 提交时注册追踪                                                                 |
| 9    | `src/core/trader/types.ts`                           | 修改     | `OrderExecutorDeps` 添加 `orderRecorder` 依赖                                  |
| 10   | `src/core/trader/index.ts`                           | 修改     | 创建 `OrderExecutor` 时传入 `orderRecorder`                                    |

---

## 九、与现有功能的兼容性

| 现有功能             | 影响 | 处理             |
| -------------------- | ---- | ---------------- |
| RiskChecker 浮亏计算 | 无   | 继续使用现有接口 |
| 日内亏损追踪         | 无   | 继续使用现有接口 |
| 订单历史记录查询     | 无   | 继续使用现有接口 |
| 延迟信号验证         | 无   | 不涉及           |
| 末日保护清仓         | 无   | 独立逻辑         |
| 程序重启恢复         | 无   | 复用现有恢复逻辑 |
| 卖出订单合并         | 无   | 可扩展支持       |

---

## 十、测试建议

### 单元测试场景

| 测试场景                 | 预期结果                 |
| ------------------------ | ------------------------ |
| 单个卖出订单             | 后续信号无法选中相同订单 |
| 两个卖出订单选中不同订单 | 两者都能正常执行         |
| 订单部分成交             | 按比例释放关联订单       |
| 订单取消                 | 释放所有关联订单         |
| 无智能平仓（清仓）       | 不走防重逻辑             |

### 集成测试场景

| 测试场景                 | 预期结果                |
| ------------------------ | ----------------------- |
| 连续快速生成多个卖出信号 | 仅第一个执行，其余 HOLD |
| 高频信号场景             | 无重复卖出              |
| 订单成交延迟场景         | 仍能正确防重            |

---

## 十一、更新日志

| 日期       | 版本 | 说明                                  |
| ---------- | ---- | ------------------------------------- |
| 2025-02-05 | 1.0  | 初版文档                              |
| 2025-02-05 | 2.0  | 实现版本，在 orderRecorder 上扩展实现 |

---

## 相关文档

- [README.md](../README.md) - 项目整体说明
- [业务逻辑知识库](../.claude/skills/core-program-business-logic.md) - 交易策略与风控规则
- [问题分析文档](./smart-close-race-condition.md) - 原始问题分析
