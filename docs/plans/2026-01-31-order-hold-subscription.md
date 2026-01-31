# Order Hold Subscription Implementation Plan
#
> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
#
**Goal:** 在订阅集合中引入 ORDER_HOLD 原因，确保非席位挂单标的能持续订阅且仅在完全成交后才允许退订。
#
**Architecture:** 新增 OrderHoldRegistry 统一管理订单保留集合，订单事件驱动更新；订阅集合由监控/席位/持仓/ORDER_HOLD 四类原因统一合并。启动阶段从全量订单种子化 ORDER_HOLD，运行阶段不再依赖 pending API。
#
**Tech Stack:** TypeScript (ES2022), Node.js, LongPort OpenAPI
#
---
#
### Task 1: 添加 ORDER_HOLD 测试（先红）
#
**Files:**
- Create: `tools/tests/orderHoldSubscriptionTest.js`
#
**Step 1: Write the failing test**
```javascript
import assert from 'node:assert/strict';
import { createOrderHoldRegistry } from '../../src/core/trader/orderHoldRegistry.js';
import { collectRuntimeQuoteSymbols } from '../../src/utils/helpers/quoteHelpers.js';
#
function buildSymbolRegistry(seats) {
  return {
    getSeatState(monitorSymbol, direction) {
      const key = `${monitorSymbol}:${direction}`;
      return seats[key] ?? { symbol: null };
    },
  };
}
#
const registry = createOrderHoldRegistry();
registry.trackOrder('o-1', 'AAA.HK');
registry.trackOrder('o-2', 'AAA.HK');
registry.markOrderFilled('o-1');
assert.ok(registry.getHoldSymbols().has('AAA.HK'), '填一笔仍保留');
registry.markOrderFilled('o-2');
assert.ok(!registry.getHoldSymbols().has('AAA.HK'), '全部成交后移除');
#
const symbols = collectRuntimeQuoteSymbols(
  [{ monitorSymbol: 'HSI.HK', longSymbol: 'L1', shortSymbol: 'S1' }],
  buildSymbolRegistry({ 'HSI.HK:LONG': { symbol: 'L2' }, 'HSI.HK:SHORT': { symbol: 'S2' } }),
  [{ symbol: 'POS1.HK' }],
  new Set(['AAA.HK']),
);
assert.ok(symbols.has('AAA.HK'), 'ORDER_HOLD 应进入订阅集合');
```
#
**Step 2: Run test to verify it fails**
Run: `npm run build && node dist/tools/tests/orderHoldSubscriptionTest.js`
Expected: FAIL with "Cannot find module" or missing export errors.
#
---
#
### Task 2: 实现 OrderHoldRegistry（最小实现）
#
**Files:**
- Create: `src/core/trader/orderHoldRegistry.ts`
- Modify: `src/core/trader/types.ts`
#
**Step 1: Write minimal implementation**
```typescript
export type OrderHoldRegistry = {
  trackOrder(orderId: string, symbol: string): void;
  markOrderFilled(orderId: string): void;
  seedFromOrders(orders: ReadonlyArray<RawOrderFromAPI>): void;
  getHoldSymbols(): ReadonlySet<string>;
};
```
#
**Step 2: Run test to verify it passes**
Run: `npm run build && node dist/tools/tests/orderHoldSubscriptionTest.js`
Expected: PASS
#
---
#
### Task 3: 订单事件驱动 ORDER_HOLD
#
**Files:**
- Modify: `src/core/trader/orderMonitor.ts`
- Modify: `src/core/trader/types.ts`
- Modify: `src/core/trader/index.ts`
- Modify: `src/types/index.ts`
#
**Step 1: Write failing test (update to cover fill behavior if needed)**
Add case to `tools/tests/orderHoldSubscriptionTest.js` to verify filled removes, cancel doesn't remove.
#
**Step 2: Run test to verify it fails**
Run: `npm run build && node dist/tools/tests/orderHoldSubscriptionTest.js`
Expected: FAIL for cancel rule.
#
**Step 3: Implement minimal code**
- `trackOrder()` 调用 registry.trackOrder
- `OrderStatus.Filled` 时调用 registry.markOrderFilled
- `Canceled/Rejected` 不处理
- Trader 暴露 `getOrderHoldSymbols()` 与 `seedOrderHoldSymbols()`
#
**Step 4: Run tests**
Run: `npm run build && node dist/tools/tests/orderHoldSubscriptionTest.js`
Expected: PASS
#
---
#
### Task 4: 订阅集合基于原因统一计算
#
**Files:**
- Modify: `src/utils/helpers/quoteHelpers.ts`
- Modify: `src/index.ts`
- Modify: `src/main/mainProgram/index.ts`
- Modify: `src/types/index.ts`
#
**Step 1: Write failing test (extend Task 1 test)**
Add assertion that撤销不触发退订（用 ORDER_HOLD 模拟，不依赖 pending API）。
#
**Step 2: Run test to verify it fails**
Run: `npm run build && node dist/tools/tests/orderHoldSubscriptionTest.js`
Expected: FAIL
#
**Step 3: Implement minimal code**
- `collectRuntimeQuoteSymbols` 增加 `orderHoldSymbols` 参数并合并
- 启动阶段 `seedOrderHoldSymbols(allOrders)` 后再计算订阅
- 主循环移除 `getPendingOrders` 逻辑，改为 `orderHoldSymbols` 判断
#
**Step 4: Run tests**
Run: `npm run build && node dist/tools/tests/orderHoldSubscriptionTest.js`
Expected: PASS
#
---
#
### Task 5: 全量校验
#
**Files:**
- Modify: `package.json` (if adding test script)
#
**Step 1: Run lint**
Run: `npm run lint`
Expected: PASS
#
**Step 2: Run type-check**
Run: `npm run type-check`
Expected: PASS
#
---
#
**Execution note:** 本次按用户指示在当前分支执行，不创建 worktree。
