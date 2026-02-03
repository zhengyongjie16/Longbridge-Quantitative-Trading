# 浮亏检查中的当日方向盈亏实现计划

> **给 Claude：** 必须使用子技能 superpowers:executing-plans 按任务逐步执行此计划。

**目标：** 将当日已实现盈亏按“监控标的 + 方向”计入浮亏检查，避免自动换标导致当日亏损被重置。  
**架构：** 新增当日亏损跟踪器，启动时基于订单归属解析 + 既有过滤算法进行初始化；每笔成交时更新；将每个方向的亏损偏移传入 `unrealizedLossChecker.refresh` 以调整 R1。买入风险检查在无持仓时也必须考虑该偏移。  
**技术栈：** TypeScript (ES2022)、Node.js、现有的 orderRecorder/risk 模块。  
---

### 任务 1：当日亏损计算工具

**文件：**
- 新建：`src/core/risk/utils.ts`
- 修改：`src/core/risk/types.ts`
- 新建：`tools/dailyLossCalculatorCheck.ts`

**步骤 1：编写失败的检查脚本**
```typescript
import { OrderSide, OrderStatus } from 'longport';
import { calculateDailyLossOffsetForOrders } from '../src/core/risk/utils.js';

const now = new Date('2026-01-31T02:00:00Z'); // 10:00 HK
const monitors = [{ monitorSymbol: 'HSI.HK' }];

const orders = [
  {
    orderId: '1',
    symbol: '55131.HK',
    stockName: 'HSI RC ABC',
    side: OrderSide.Buy,
    status: OrderStatus.Filled,
    orderType: 'ELO',
    price: '1',
    quantity: '100',
    executedPrice: '1',
    executedQuantity: '100',
    submittedAt: new Date('2026-01-31T01:00:00Z'),
    updatedAt: new Date('2026-01-31T01:00:00Z'),
  },
  {
    orderId: '2',
    symbol: '55131.HK',
    stockName: 'HSI RC ABC',
    side: OrderSide.Sell,
    status: OrderStatus.Filled,
    orderType: 'ELO',
    price: '0.9',
    quantity: '100',
    executedPrice: '0.9',
    executedQuantity: '100',
    submittedAt: new Date('2026-01-31T01:30:00Z'),
    updatedAt: new Date('2026-01-31T01:30:00Z'),
  },
] as const;

const result = calculateDailyLossOffsetForOrders({
  orders,
  monitors,
  now,
});

const longLoss = result.get('HSI.HK')?.long ?? 0;
if (Math.abs(longLoss - 10) > 1e-6) {
  throw new Error(`expected loss=10, got ${longLoss}`);
}
console.log('OK');
```

**步骤 2：运行检查（预期失败）**
运行：`npm run build && node dist/tools/dailyLossCalculatorCheck.js`  
预期：FAIL（缺少导出 / 未实现）

**步骤 3：实现当日亏损计算工具**
```typescript
export function calculateDailyLossOffsetForOrders({
  orders,
  monitors,
  now,
}: {
  readonly orders: ReadonlyArray<RawOrderFromAPI>;
  readonly monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol'>>;
  readonly now: Date;
}): ReadonlyMap<string, { readonly long: number; readonly short: number }> {
  // 1) 以北京时间解析 todayKey
  // 2) 过滤当日已成交订单
  // 3) 通过 resolveOrderOwnership 按监控标的 + 方向分组
  // 4) 分类订单，使用 filteringEngine 计算 totalBuy/totalSell/openBuy
  // 5) dailyLossOffset = totalBuy - totalSell - openBuy
}
```

**步骤 4：重新运行检查（预期通过）**
运行：`npm run build && node dist/tools/dailyLossCalculatorCheck.js`  
预期：PASS 且输出 `OK`

**步骤 5：提交**
```bash
git add src/core/risk/utils.ts src/core/risk/types.ts tools/dailyLossCalculatorCheck.ts
git commit -m "feat: add daily loss calculation utilities"
```

### 任务 2：当日亏损跟踪器（有状态缓存）

**文件：**
- 新建：`src/core/risk/dailyLossTracker.ts`
- 修改：`src/core/risk/types.ts`
- 修改：`tools/dailyLossCalculatorCheck.ts`

**步骤 1：扩展检查脚本以使用跟踪器**
```typescript
import { createDailyLossTracker } from '../src/core/risk/dailyLossTracker.js';
// 用订单初始化，然后记录一笔新成交并重新检查亏损
```

**步骤 2：运行检查（预期失败）**
运行：`npm run build && node dist/tools/dailyLossCalculatorCheck.js`  
预期：FAIL（跟踪器缺失）

**步骤 3：实现跟踪器**
```typescript
export function createDailyLossTracker(/* deps */) {
  // initializeFromOrders(allOrders, monitors, now) 初始化
  // recordFilledOrder({ monitorSymbol, isLongSymbol, side, price, quantity, executedAt }) 记录成交
  // getLossOffset(monitorSymbol, isLongSymbol) 获取偏移
  // resetIfNewDay(now) 跨日重置
}
```

**步骤 4：重新运行检查（预期通过）**
运行：`npm run build && node dist/tools/dailyLossCalculatorCheck.js`  
预期：PASS

**步骤 5：提交**
```bash
git add src/core/risk/dailyLossTracker.ts src/core/risk/types.ts tools/dailyLossCalculatorCheck.ts
git commit -m "feat: add daily loss tracker"
```

### 任务 3：将亏损偏移集成到浮亏检查

**文件：**
- 修改：`src/core/risk/unrealizedLossChecker.ts`
- 修改：`src/core/risk/index.ts`
- 修改：`src/core/risk/types.ts`
- 修改：`src/types/index.ts`

**步骤 1：更新接口与数据结构**
```typescript
export type UnrealizedLossData = {
  readonly r1: number;
  readonly n1: number;
  readonly baseR1?: number;
  readonly dailyLossOffset?: number;
  readonly lastUpdateTime: number;
};
```

**步骤 2：在 refresh 中应用偏移**
```typescript
const baseR1 = r1;
const adjustedR1 = baseR1 + dailyLossOffset;
unrealizedLossData.set(symbol, { r1: adjustedR1, n1, baseR1, dailyLossOffset, lastUpdateTime: Date.now() });
```

**步骤 3：确保买入风险检查在 n1==0 时仍考虑偏移**
```typescript
if (!lossData) return null;
const { r1, n1 } = lossData;
// 允许在 n1 <= 0 且 r1 != 0 时仍进行检查
```

**步骤 4：类型检查**
运行：`npm run type-check`  
预期：PASS

**步骤 5：提交**
```bash
git add src/core/risk/unrealizedLossChecker.ts src/core/risk/index.ts src/core/risk/types.ts src/types/index.ts
git commit -m "feat: apply daily loss offset to unrealized loss"
```

### 任务 4：启动与运行时接线

**文件：**
- 修改：`src/index.ts`
- 修改：`src/services/monitorContext/index.ts`
- 修改：`src/types/index.ts`
- 修改：`src/main/processMonitor/index.ts`
- 修改：`src/main/mainProgram/index.ts`
- 修改：`src/core/trader/orderMonitor.ts`

**步骤 1：启动时初始化当日亏损跟踪器**
```typescript
const dailyLossTracker = createDailyLossTracker({ /* deps */ });
dailyLossTracker.initializeFromOrders(allOrders, tradingConfig.monitors, new Date());
monitorContext.dailyLossTracker = dailyLossTracker;
```

**步骤 2：将偏移传入 refreshUnrealizedLossData**
```typescript
const offset = monitorContext.dailyLossTracker.getLossOffset(monitorSymbol, isLongSymbol);
await riskChecker.refreshUnrealizedLossData(orderRecorder, seatSymbol, isLongSymbol, quote, offset);
```

**步骤 3：换标时基于全量订单重算当日盈亏并刷新浮亏缓存（非补丁式）**
```typescript
// refreshSeatAfterSwitch 内部（processMonitor）
const allOrders = await ensureAllOrders();
monitorContext.dailyLossTracker.recalculateFromAllOrders(
  allOrders,
  tradingConfig.monitors,
  new Date(),
);
const offset = monitorContext.dailyLossTracker.getLossOffset(monitorSymbol, isLongSymbol);
await riskChecker.refreshUnrealizedLossData(orderRecorder, nextSymbol, isLongSymbol, quote, offset);
```

**步骤 4：成交后更新跟踪器**
```typescript
dailyLossTracker.recordFilledOrder({
  monitorSymbol: trackedOrder.monitorSymbol,
  isLongSymbol: trackedOrder.isLongSymbol,
  side: trackedOrder.side,
  executedPrice,
  executedQuantity,
  executedTimeMs,
});
```

**步骤 5：跨日重置**
```typescript
dailyLossTracker.resetIfNewDay(new Date());
```

**步骤 6：提交**
```bash
git add src/index.ts src/services/monitorContext/index.ts src/types/index.ts \
  src/main/processMonitor/index.ts src/main/mainProgram/index.ts \
  src/core/trader/orderMonitor.ts
git commit -m "feat: wire daily loss offsets into refresh flow"
```

### 任务 5：验证

**步骤 1：Lint**
运行：`npm run lint`  
预期：PASS

**步骤 2：类型检查**
运行：`npm run type-check`  
预期：PASS

**步骤 3：手动冒烟检查**
运行：`npm run build && node dist/tools/dailyLossCalculatorCheck.js`  
预期：PASS 且输出 `OK`
