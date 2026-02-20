# Order Ownership Mapping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 引入 `ORDER_OWNERSHIP_MAPPING_N`，以归属缩写解析 `stockName`，确保订单归属与方向判定稳定可靠。  
**Architecture:** 新增监控标的级映射配置 → 配置校验（空值/重复/冲突）→ 归属解析基于映射缩写 + `RC/RP` → 启动席位/当日亏损等模块统一使用新规则。  
**Tech Stack:** TypeScript、Node.js 测试 (`node:test`)、配置解析工具 (`src/config/utils.ts`)

---

### Task 1: 订单归属映射测试（TDD）

**Files:**

- Create: `tests/orderOwnershipParser.test.ts`

**Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOrderOwnership,
  resolveOrderOwnership,
  getLatestTradedSymbol,
} from '../src/core/orderRecorder/orderOwnershipParser.js';

test('parseOrderOwnership resolves direction using ownership mapping', () => {
  const parser = parseOrderOwnership as unknown as (
    stockName: string,
    monitorSymbol: string,
    mapping: ReadonlyArray<string>,
  ) => 'LONG' | 'SHORT' | null;

  const result = parser('HS#ALIBARP2807F', '9988.HK', ['ALIBA']);
  assert.equal(result, 'SHORT');
});

test('resolveOrderOwnership matches monitor by mapping', () => {
  const monitors = [
    { monitorSymbol: '9988.HK', orderOwnershipMapping: ['ALIBA'] },
    { monitorSymbol: '0700.HK', orderOwnershipMapping: ['TENC'] },
  ];
  const order = { stockName: 'HS#ALIBARP2807F' } as { stockName: string };
  const result = resolveOrderOwnership(order as never, monitors as never);
  assert.equal(result?.monitorSymbol, '9988.HK');
  assert.equal(result?.direction, 'SHORT');
});

test('getLatestTradedSymbol uses mapping to pick latest fill', () => {
  const orders = [
    {
      stockName: 'HS#ALIBARC2301A',
      status: 2,
      updatedAt: new Date('2026-02-02T00:00:00Z'),
      symbol: 'AAA.HK',
    },
    {
      stockName: 'HS#ALIBARP2807F',
      status: 2,
      updatedAt: new Date('2026-02-02T01:00:00Z'),
      symbol: 'BBB.HK',
    },
  ];
  const getter = getLatestTradedSymbol as unknown as (
    orders: ReadonlyArray<{ stockName: string; status: number; updatedAt: Date; symbol: string }>,
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    mapping: ReadonlyArray<string>,
  ) => string | null;
  const result = getter(orders, '9988.HK', 'SHORT', ['ALIBA']);
  assert.equal(result, 'BBB.HK');
});
```

**Step 2: Run test to verify it fails**
Run: `npm test`  
Expected: 失败，解析结果为 `null` 或未命中映射

---

### Task 2: 配置与解析实现

**Files:**

- Modify: `src/types/index.ts`
- Modify: `src/config/utils.ts`
- Modify: `src/config/config.trading.ts`
- Modify: `src/config/config.validator.ts`
- Modify: `src/core/orderRecorder/orderOwnershipParser.ts`
- Modify: `src/core/risk/types.ts`
- Modify: `src/core/risk/dailyLossTracker.ts`
- Modify: `src/core/risk/utils.ts`
- Modify: `src/main/startup/seat.ts`
- Modify: `src/index.ts`

**Step 1: Implement mapping parsing**

```typescript
export function parseOrderOwnershipMapping(
  env: NodeJS.ProcessEnv,
  envKey: string,
): ReadonlyArray<string> {
  const value = getStringConfig(env, envKey);
  if (!value) return [];
  const normalized = value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item !== '');
  return Array.from(new Set(normalized));
}
```

**Step 2: Wire config + types + validation**

- `MonitorConfig` 增加 `orderOwnershipMapping: ReadonlyArray<string>`
- `config.trading.ts` 读取 `ORDER_OWNERSHIP_MAPPING_N`
- `config.validator.ts` 校验空值与跨标的重复映射

**Step 3: Update ownership parsing**

```typescript
export function parseOrderOwnership(
  stockName: string | null | undefined,
  monitorSymbol: string,
  orderOwnershipMapping: ReadonlyArray<string>,
): 'LONG' | 'SHORT' | null {
  /* ... */
}
```

**Step 4: Run test to verify it passes**
Run: `npm test`  
Expected: PASS

**Step 5: Commit**

```bash
git add tests/orderOwnershipParser.test.ts src/core/orderRecorder/orderOwnershipParser.ts src/config src/types src/main
git commit -m "feat: add order ownership mapping config"
```

---

### Task 3: 文档与示例更新

**Files:**

- Modify: `.env.example`
- Modify: `README.md`

**Step 1: Update .env.example**

```bash
# 新增：订单归属映射（stockName 缩写）
ORDER_OWNERSHIP_MAPPING_1=ALIBA
```

**Step 2: Update README config table**

```markdown
| `ORDER_OWNERSHIP_MAPPING_N` | 无 | stockName 归属缩写映射（逗号分隔） |
```

**Step 3: Run lint + type-check**
Run: `npm run lint`  
Run: `npm run type-check`  
Expected: 无错误

**Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document order ownership mapping"
```
