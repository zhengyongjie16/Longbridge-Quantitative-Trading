# Startup Gate / Seat / Cooldown Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在满足门禁后立即完成账户/持仓与席位确定；冷却恢复改为“先取席位标的→查该标的最后一笔订单是否为保护性清仓”；新增 `npm run dev` 跳过启动门禁。

**Architecture:** 引入 `startup` 分层（Gate / Account+Position / Seat / Cooldown / ContextInit），由统一的启动编排器串联。冷却恢复不再以监控标的过滤日志，而是以席位标的为入口并回写监控标的方向的冷却。启动门禁以“策略对象 + 运行模式”控制，`dev` 模式只跳过启动门禁但保留运行期交易时段检查。

**Tech Stack:** TypeScript, Node.js, LongPort OpenAPI, pino

---

### Task 1: 启动门禁策略 + dev 脚本

**Files:**
- Create: `src/main/startup/gate.ts`
- Modify: `src/index.ts`
- Modify: `package.json`
- Modify: `src/types/index.ts`（若需要新增 RunMode/StartupGatePolicy）

**Step 1: Write the failing test**
```javascript
import assert from 'node:assert/strict';
import { createStartupGate } from '../../dist/src/main/startup/gate.js';

const gate = createStartupGate({
  nowMs: () => 0,
  sleep: async () => {},
  resolveTradingDayInfo: async () => ({ isTradingDay: false, isHalfDay: false }),
  isInSession: () => false,
  isInOpenProtection: () => false,
  logger: { info: () => {} },
});

const result = await gate.wait({ mode: 'skip' });
assert.deepEqual(result, { isTradingDay: true, isHalfDay: false });
```

**Step 2: Run test to verify it fails**
Run: `npm run build && node tests/startup/startup-gate.test.js`  
Expected: FAIL with "createStartupGate is not a function"

**Step 3: Write minimal implementation**
```typescript
export type StartupGateMode = 'strict' | 'skip';
export function createStartupGate(deps: GateDeps) {
  async function wait({ mode }: { mode: StartupGateMode }) {
    if (mode === 'skip') {
      return { isTradingDay: true, isHalfDay: false };
    }
    // strict: loop until trading day + session + not open protection
  }
  return { wait };
}
```

**Step 4: Run test to verify it passes**
Run: `npm run build && node tests/startup/startup-gate.test.js`  
Expected: PASS

**Step 5: Commit**
```bash
git add src/main/startup/gate.ts src/index.ts package.json src/types/index.ts tests/startup/startup-gate.test.js
git commit -m "refactor: add startup gate policy and dev mode"
```

---

### Task 2: 账户/持仓优先 + 席位确定分层

**Files:**
- Create: `src/main/startup/seat.ts`
- Modify: `src/index.ts`
- Modify: `src/services/autoSymbolManager/utils.ts`
- Modify: `src/types/index.ts`

**Step 1: Write the failing test**
```javascript
import assert from 'node:assert/strict';
import { resolveSeatSnapshot } from '../../dist/src/main/startup/seat.js';

const snapshot = resolveSeatSnapshot({
  monitors: [{ monitorSymbol: 'HSI' }],
  positions: [{ symbol: 'ABC.HK', quantity: 10 }],
  orders: [{ symbol: 'ABC.HK', stockName: 'HSI RC', status: 'FILLED', updatedAt: new Date() }],
});

assert.equal(snapshot.seats.get('HSI:LONG'), 'ABC.HK');
```

**Step 2: Run test to verify it fails**
Run: `npm run build && node tests/startup/seat.test.js`  
Expected: FAIL with "resolveSeatSnapshot is not a function"

**Step 3: Write minimal implementation**
```typescript
export function resolveSeatSnapshot(deps: SeatSnapshotDeps): SeatSnapshot {
  // 1) 读取持仓与全量订单
  // 2) 依监控标的+方向解析最新订单候选
  // 3) 有持仓才占位，否则保持空并交给寻标
}
```

**Step 4: Run test to verify it passes**
Run: `npm run build && node tests/startup/seat.test.js`  
Expected: PASS

**Step 5: Commit**
```bash
git add src/main/startup/seat.ts src/index.ts src/services/autoSymbolManager/utils.ts src/types/index.ts tests/startup/seat.test.js
git commit -m "refactor: prioritize account/position and seat bootstrap"
```

---

### Task 3: 冷却恢复改为“席位标的→最后订单→保护性清仓”

**Files:**
- Modify: `src/services/liquidationCooldown/tradeLogHydrator.ts`
- Modify: `src/services/liquidationCooldown/types.ts`
- Modify: `src/index.ts`
- Modify: `src/types/index.ts`

**Step 1: Write the failing test**
```javascript
import assert from 'node:assert/strict';
import { hydrateCooldownBySeat } from '../../dist/src/services/liquidationCooldown/tradeLogHydrator.js';

const log = [
  { symbol: 'AAA.HK', executedAtMs: 1000, isProtectiveClearance: true },
  { symbol: 'AAA.HK', executedAtMs: 2000, isProtectiveClearance: false },
];

const result = hydrateCooldownBySeat({
  seatSymbols: [{ monitorSymbol: 'HSI', direction: 'LONG', symbol: 'AAA.HK' }],
  tradeRecords: log,
});

assert.equal(result.get('HSI:LONG'), null);
```

**Step 2: Run test to verify it fails**
Run: `npm run build && node tests/startup/cooldown-hydrator.test.js`  
Expected: FAIL with "hydrateCooldownBySeat is not a function"

**Step 3: Write minimal implementation**
```typescript
// 先按 symbol 取最后一笔订单，再判断 isProtectiveClearance
function resolveLastRecordBySymbol(records: TradeRecord[]): Map<string, TradeRecord> { /* ... */ }
export function hydrateCooldownBySeat(/* ... */) { /* ... */ }
```

**Step 4: Run test to verify it passes**
Run: `npm run build && node tests/startup/cooldown-hydrator.test.js`  
Expected: PASS

**Step 5: Commit**
```bash
git add src/services/liquidationCooldown/tradeLogHydrator.ts src/services/liquidationCooldown/types.ts src/index.ts src/types/index.ts tests/startup/cooldown-hydrator.test.js
git commit -m "refactor: hydrate cooldown by seat symbols"
```

---

### Task 4: 启动编排重组 + 文档更新

**Files:**
- Modify: `src/index.ts`
- Modify: `docs/startup-initialization-flow.md`
- Modify: `docs/plan/2026-01-30-startup-seat-priority.md`（如需统一口径）

**Step 1: Write the failing test**
- 编写最小启动脚本（模拟 gate -> account -> seat -> cooldown -> init 顺序），断言日志顺序。

**Step 2: Run test to verify it fails**
Run: `npm run build && node tests/startup/startup-sequence.test.js`  
Expected: FAIL with "order mismatch"

**Step 3: Write minimal implementation**
- 将 `src/index.ts` 拆为 `startup` 阶段函数，并显式顺序：
  `gate → account/positions → seat → cooldown hydrate → seat-based init → run`.
- 仅在席位就绪后执行：行情订阅、monitorContext 创建、牛熊证信息、订单记录、浮亏初始化。

**Step 4: Run test to verify it passes**
Run: `npm run build && node tests/startup/startup-sequence.test.js`  
Expected: PASS

**Step 5: Commit**
```bash
git add src/index.ts docs/startup-initialization-flow.md docs/plan/2026-01-30-startup-seat-priority.md tests/startup/startup-sequence.test.js
git commit -m "refactor: recompose startup sequence around seat readiness"
```

---

## 验证建议
- `npm run dev` 启动时无需交易时段即可进入启动流程（但运行期仍会暂停监控）。
- 非交易日运行 `start`：启动门禁阻塞，日志周期输出等待信息。
- 席位标的切换后，冷却恢复只看当前席位标的的最后订单是否为保护性清仓。
- 席位未就绪时，席位相关初始化全部延后。
