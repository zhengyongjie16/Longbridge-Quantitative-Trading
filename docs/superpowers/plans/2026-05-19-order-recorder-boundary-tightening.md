# Order Recorder Boundary Tightening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收紧 `orderRecorder` 剩余偏宽的公共分析边界，去掉四合一 `createOrderAnalysisTools` toolkit，并把只服务工厂的 `OrderRecorderFactoryDeps` 收回模块局部类型，同时保持现有业务语义不变。

**Architecture:** 采用最小边界收口方案：保留 `createOrderRecorder` 作为正式工厂；把当前跨域分析能力拆成两个正式公共面——面向 `dailyLossTracker` 的专用依赖工厂，以及面向恢复/席位链路的两个显式只读能力函数。这样外部调用方只依赖自己真正需要的能力，不再通过一个 omnibus toolkit 了解 `orderRecorder` 内部拆分。

**Tech Stack:** Bun, TypeScript strict mode, bun:test, Longbridge OpenAPI SDK, existing factory-function architecture.

---

## Safety note

本轮按用户要求直接执行设计与修复，但不创建 git commit；以 TDD、focused tests、`bun lint` 与 `bun type-check` 作为每个阶段的验证门禁。

## File map

- Modify `src/core/orderRecorder/index.ts`: 删除 `createOrderAnalysisTools`，新增更窄的正式公共边界。
- Modify `src/core/orderRecorder/types.ts`: 接住 `OrderRecorderFactoryDeps`，把工厂入参类型局部化。
- Modify `src/types/orderRecorder.ts`: 删除 `OrderAnalysisTools` 与 `OrderRecorderFactoryDeps` 共享公共面，只保留真正跨模块的公共类型。
- Modify `src/app/runtime/createPostGateRuntime.ts`: 改为使用面向 `dailyLossTracker` 的专用依赖工厂。
- Modify `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`: 改为直接使用正式 `resolveOrderOwnership` 边界，不再持有模块级 toolkit。
- Modify `src/main/recovery/seatPreparation.ts`: 改为直接使用正式 `getLatestTradedSymbol` 边界，不再持有模块级 toolkit。
- Modify `src/core/trader/orderMonitor/recoveryFlow.ts`: 改为直接使用正式 `resolveOrderOwnership` 边界，不再持有模块级 toolkit。
- Rename `tests/core/orderRecorder/orderAnalysisTools.test.ts` → `tests/core/orderRecorder/orderAnalysisBoundary.test.ts`: 测试新的公共分析边界。
- Modify `tests/core/riskController/dailyLossTracker.segment.business.test.ts`: 改为使用专用 daily-loss 依赖工厂。
- Modify `tests/architecture/typeOrganization.test.ts`: 增加共享类型面不再泄漏 `OrderRecorderFactoryDeps` / `TradeContext` / `RateLimiter` 的回归护栏。

---

### Task 1: 写出边界收口的 failing tests

**Files:**

- Rename: `tests/core/orderRecorder/orderAnalysisTools.test.ts` → `tests/core/orderRecorder/orderAnalysisBoundary.test.ts`
- Modify: `tests/core/riskController/dailyLossTracker.segment.business.test.ts`
- Modify: `tests/architecture/typeOrganization.test.ts`

- [ ] **Step 1: 把 order analysis test 改成新公共边界的失败用例**

把 `tests/core/orderRecorder/orderAnalysisTools.test.ts` 重命名为 `tests/core/orderRecorder/orderAnalysisBoundary.test.ts`，并替换成以下测试内容：

```ts
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import {
  createDailyLossOrderAnalysisDeps,
  getLatestTradedSymbol,
  resolveOrderOwnership,
} from '../../../src/core/orderRecorder/index.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';

function createRawOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly side: OrderSide;
  readonly updatedAt: Date;
  readonly executedPrice: number;
  readonly executedQuantity: number;
}): RawOrderFromAPI {
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName,
    side: params.side,
    status: OrderStatus.Filled,
    orderType: OrderType.LO,
    price: String(params.executedPrice),
    quantity: String(params.executedQuantity),
    executedPrice: String(params.executedPrice),
    executedQuantity: String(params.executedQuantity),
    submittedAt: params.updatedAt,
    updatedAt: params.updatedAt,
    remark: '',
  };
}

describe('orderRecorder public analysis boundary', () => {
  it('exposes dedicated daily loss analysis deps without omnibus toolkit', () => {
    const buyOrder = createRawOrder({
      orderId: 'BUY-1',
      symbol: '70000.HK',
      stockName: 'HSI RC',
      side: OrderSide.Buy,
      updatedAt: new Date('2026-05-18T01:30:00.000Z'),
      executedPrice: 1,
      executedQuantity: 100,
    });
    const sellOrder = createRawOrder({
      orderId: 'SELL-1',
      symbol: '70000.HK',
      stockName: 'HSI RC',
      side: OrderSide.Sell,
      updatedAt: new Date('2026-05-18T02:30:00.000Z'),
      executedPrice: 0.9,
      executedQuantity: 100,
    });

    const firstDeps = createDailyLossOrderAnalysisDeps();
    const secondDeps = createDailyLossOrderAnalysisDeps();
    const classified = firstDeps.classifyAndConvertOrders([buyOrder, sellOrder]);

    expect(firstDeps.filteringEngine).not.toBe(secondDeps.filteringEngine);
    expect(
      firstDeps.filteringEngine.applyFilteringAlgorithm(
        classified.buyOrders,
        classified.sellOrders,
      ),
    ).toEqual([]);
  });

  it('exposes ownership resolution and latest symbol lookup as separate public capabilities', () => {
    const buyOrder = createRawOrder({
      orderId: 'BUY-2',
      symbol: '70000.HK',
      stockName: 'HSI RC',
      side: OrderSide.Buy,
      updatedAt: new Date('2026-05-18T03:30:00.000Z'),
      executedPrice: 1,
      executedQuantity: 100,
    });

    expect(
      resolveOrderOwnership(buyOrder, [{ monitorSymbol: 'HSI', orderOwnershipMapping: ['HSI'] }]),
    ).toEqual({ monitorSymbol: 'HSI', direction: 'LONG' });
    expect(getLatestTradedSymbol([buyOrder], ['HSI'], 'LONG')).toBe('70000.HK');
  });
});
```

- [ ] **Step 2: 让 daily loss segment test 改为依赖新的专用工厂（先写失败改动）**

把 `tests/core/riskController/dailyLossTracker.segment.business.test.ts` 中的导入和 `createSegmentTracker` 改成：

```ts
import { createDailyLossOrderAnalysisDeps } from '../../../src/core/orderRecorder/index.js';
```

```ts
function createSegmentTracker(): DailyLossTracker {
  const orderAnalysisDeps = createDailyLossOrderAnalysisDeps();

  return createDailyLossTracker({
    ...orderAnalysisDeps,
    resolveOrderOwnership: (order) => resolveOrderOwnership(order),
    toHongKongTimeIso,
  });
}
```

- [ ] **Step 3: 先写共享类型面收紧的失败护栏**

在 `tests/architecture/typeOrganization.test.ts` 追加：

```ts
it('keeps orderRecorder factory deps out of shared public types', async () => {
  const sharedOrderRecorderTypesSource = await readProjectFile('src/types/orderRecorder.ts');

  expect(sharedOrderRecorderTypesSource).not.toContain('OrderRecorderFactoryDeps');
  expect(sharedOrderRecorderTypesSource).not.toContain('TradeContext');
  expect(sharedOrderRecorderTypesSource).not.toContain('RateLimiter');
});
```

- [ ] **Step 4: 运行 focused tests，确认 RED**

Run:

```bash
bun test tests/core/orderRecorder/orderAnalysisBoundary.test.ts tests/core/riskController/dailyLossTracker.segment.business.test.ts tests/architecture/typeOrganization.test.ts
```

Expected before implementation:

- `orderAnalysisBoundary.test.ts` 因 `createDailyLossOrderAnalysisDeps` / `resolveOrderOwnership` / `getLatestTradedSymbol` 未从 `src/core/orderRecorder/index.ts` 暴露而失败。
- `typeOrganization.test.ts` 因 `src/types/orderRecorder.ts` 仍包含 `OrderRecorderFactoryDeps` / `TradeContext` / `RateLimiter` 而失败。

---

### Task 2: 用最小正式边界替换四合一 toolkit

**Files:**

- Modify: `src/core/orderRecorder/index.ts`
- Modify: `src/core/orderRecorder/types.ts`
- Modify: `src/types/orderRecorder.ts`
- Modify: `src/app/runtime/createPostGateRuntime.ts`
- Modify: `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
- Modify: `src/main/recovery/seatPreparation.ts`
- Modify: `src/core/trader/orderMonitor/recoveryFlow.ts`
- Modify: `tests/core/riskController/dailyLossTracker.segment.business.test.ts`

- [ ] **Step 1: 把 `OrderRecorderFactoryDeps` 收回 orderRecorder 局部类型文件**

在 `src/core/orderRecorder/types.ts`、现有 `OrderRecorderDeps` 前后加入：

```ts
export type OrderRecorderFactoryDeps = {
  readonly ctx: TradeContext;
  readonly rateLimiter: RateLimiter;
};
```

并从 `src/types/orderRecorder.ts` 删除：

```ts
import type { TradeContext } from 'longbridge';
import type { OrderRecord, RateLimiter, RawOrderFromAPI } from './services.js';
```

改成：

```ts
import type { OrderRecord, RawOrderFromAPI } from './services.js';
```

同时删除整个 `OrderRecorderFactoryDeps` 与 `OrderAnalysisTools` 定义块，仅保留真正跨模块公共的 `OrderOwnership` 与 `OrderFilteringEngine`。

- [ ] **Step 2: 在 `orderRecorder` 正式边界定义更窄的公共能力**

在 `src/core/orderRecorder/index.ts` 做以下调整：

1. 把类型导入改为：

```ts
import type { MonitorConfig } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import type { DailyLossTrackerDeps } from '../../types/risk.js';
import type { OrderOwnership } from '../../types/orderRecorder.js';
```

2. 从 `./types.js` 导入 `OrderRecorderFactoryDeps`，并把 ownership parser 导入改为别名：

```ts
import type {
  OrderRecorderDeps,
  OrderRecorderFactoryDeps,
  OrderStatistics,
  OrderRefreshResultLogParams,
  PendingOrderClassificationForRebuild,
} from './types.js';
```

```ts
import {
  getLatestTradedSymbol as getLatestTradedSymbolInternal,
  resolveOrderOwnership as resolveOrderOwnershipInternal,
} from './orderOwnershipParser.js';
```

3. 删除整个 `createOrderAnalysisTools()`。

4. 在 `createOrderRecorder()` 后新增三个正式公共出口：

```ts
export function createDailyLossOrderAnalysisDeps(): Pick<
  DailyLossTrackerDeps,
  'filteringEngine' | 'resolveOrderOwnership' | 'classifyAndConvertOrders'
> {
  return {
    filteringEngine: createOrderFilteringEngine(),
    resolveOrderOwnership,
    classifyAndConvertOrders,
  };
}

export function resolveOrderOwnership(
  order: RawOrderFromAPI,
  monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
): OrderOwnership | null {
  return resolveOrderOwnershipInternal(order, monitors);
}

export function getLatestTradedSymbol(
  orders: ReadonlyArray<RawOrderFromAPI>,
  orderOwnershipMapping: ReadonlyArray<string>,
  direction: 'LONG' | 'SHORT',
): string | null {
  return getLatestTradedSymbolInternal(orders, orderOwnershipMapping, direction);
}
```

- [ ] **Step 3: 把调用方改成只拿自己需要的能力**

修改 `src/app/runtime/createPostGateRuntime.ts`：

```ts
import { createDailyLossOrderAnalysisDeps } from '../../core/orderRecorder/index.js';
```

```ts
const dailyLossTracker = createDailyLossTracker({
  ...createDailyLossOrderAnalysisDeps(),
  toHongKongTimeIso,
});
```

修改 `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`：

```ts
import { resolveOrderOwnership } from '../../core/orderRecorder/index.js';
```

并删除模块级 `orderAnalysisTools`，把：

```ts
const ownership = orderAnalysisTools.resolveOrderOwnership(order, tradingConfig.monitors);
```

改为：

```ts
const ownership = resolveOrderOwnership(order, tradingConfig.monitors);
```

修改 `src/main/recovery/seatPreparation.ts`：

```ts
import { getLatestTradedSymbol } from '../../core/orderRecorder/index.js';
```

并删除模块级 `orderAnalysisTools`，把两处 `orderAnalysisTools.getLatestTradedSymbol(...)` 改为 `getLatestTradedSymbol(...)`。

修改 `src/core/trader/orderMonitor/recoveryFlow.ts`：

```ts
import { resolveOrderOwnership } from '../../orderRecorder/index.js';
```

并删除模块级 `orderAnalysisTools`，把：

```ts
const resolved = orderAnalysisTools.resolveOrderOwnership(order, tradingConfig.monitors);
```

改为：

```ts
const resolved = resolveOrderOwnership(order, tradingConfig.monitors);
```

同时把 `tests/core/riskController/dailyLossTracker.segment.business.test.ts` 中的 `createSegmentTracker` 更新为最终形态：

```ts
function createSegmentTracker(): DailyLossTracker {
  const orderAnalysisDeps = createDailyLossOrderAnalysisDeps();

  return createDailyLossTracker({
    ...orderAnalysisDeps,
    resolveOrderOwnership: (order) => resolveOrderOwnership(order),
    toHongKongTimeIso,
  });
}
```

- [ ] **Step 4: 运行 focused tests，确认 GREEN**

Run:

```bash
bun test tests/core/orderRecorder/orderAnalysisBoundary.test.ts tests/core/riskController/dailyLossTracker.segment.business.test.ts tests/architecture/typeOrganization.test.ts
```

Expected after implementation: all pass.

---

### Task 3: 复核边界回归并跑完整验证

**Files:**

- Modify: `tests/core/orderRecorder/orderAnalysisBoundary.test.ts`
- Modify: `tests/architecture/typeOrganization.test.ts`
- Verify: `src/core/trader/index.ts`
- Verify: `src/core/orderRecorder/index.ts`

- [ ] **Step 1: 复读 `src/core/trader/index.ts` 与 `src/core/orderRecorder/index.ts`，确认没有回退到 toolkit 或内部穿透**

人工检查以下约束：

```ts
// trader 仍然只调用 createOrderRecorder({ ctx, rateLimiter })
const orderRecorder = createOrderRecorder({
  ctx,
  rateLimiter,
});
```

```ts
// orderRecorder 边界不再存在 createOrderAnalysisTools
export function createDailyLossOrderAnalysisDeps() { ... }
export function resolveOrderOwnership(...) { ... }
export function getLatestTradedSymbol(...) { ... }
```

- [ ] **Step 2: 运行与本次收口直接相关的测试集合**

Run:

```bash
bun test tests/architecture/typeOrganization.test.ts tests/core/orderRecorder/orderAnalysisBoundary.test.ts tests/core/riskController/dailyLossTracker.segment.business.test.ts tests/core/trader/index.business.test.ts
```

Expected: PASS，且不再出现对 `createOrderAnalysisTools` 的依赖。

- [ ] **Step 3: 运行仓库静态验证**

Run:

```bash
bun lint && bun type-check
```

Expected: exit 0。

- [ ] **Step 4: 总结是否还有必须修的问题**

输出时只保留三类结论：

```md
- 已修复且验证通过的问题
- 真实存在但本轮不必继续扩大的问题
- 未发现的问题（说明为什么原 reviewer concern 已被当前实现自然消除）
```

例如：

```md
- 已修复：createOrderAnalysisTools 四合一 toolkit 导致的偏宽依赖面；OrderRecorderFactoryDeps 共享类型外溢。
- 不必继续扩大：不做更高层场景门面，避免把本轮最小收口扩成大重构。
- 未发现：createTrader 边界未被锁死这一 concern 在现有 architecture test + 收口后正式边界下不再构成单独必须修项。
```
