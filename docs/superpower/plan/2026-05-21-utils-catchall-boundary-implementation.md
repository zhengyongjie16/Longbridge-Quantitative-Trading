# utils catch-all 边界收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/utils/utils.ts` 的 catch-all helper 按最近共同父级拆回各自 owner，删除旧公共入口，并保持现有业务语义与测试行为不变。

**Architecture:** 先收回单 owner helper 和局部协议，再处理同域复用 helper，最后迁移跨 `app/main` 的 seat projection helper。所有迁移都采用“最小落点 + 无兼容层”的方式：能内联就内联，必须共享时才建窄文件，最终删除 `src/utils/utils.ts` 与 `src/types/queue.ts`。

**Tech Stack:** Bun, TypeScript strict mode, bun:test, existing module-local helper patterns, current architecture tests.

---

## File map

- Modify `src/main/seatRuntimeCleanupDispatcher/types.ts`: 接住 `QueueClearResult` 的最终归属。
- Modify `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts`: 内联队列清理统计并改用本域类型。
- Modify `src/app/startup/runtimeValidation.ts`: 收回 `shouldSkipRuntimeValidationSymbol`。
- Modify `src/utils/runtime/index.ts`: 收回 `parseBooleanEnv`。
- Modify `src/services/accountDisplay/index.ts`: 收回 `formatNumber` / `formatAccountChannel`。
- Modify `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`: 改用同域 set helper。
- Modify `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`: 改用同域 set helper。
- Create `src/main/monitorQuoteEventRuntime/setUtils.ts`: 承载 `areStringSetsEqual`。
- Create `src/utils/seat/types.ts`: 承载 seat projection 的局部类型。
- Create `src/utils/seat/snapshots.ts`: 承载 seat/runtime snapshot helper。
- Modify `src/app/context/createMonitorContexts.ts`: 改用新的 seat snapshot helper。
- Modify `src/main/businessEventProgram/seatProjection.ts`: 改用新的 seat snapshot helper。
- Modify `src/main/tradingRiskEventRuntime/routingIndex.ts`: 改用新的 seat snapshot helper。
- Modify `src/main/lifecycle/cacheDomains/seatDomain.ts`: 改用新的 seat snapshot helper。
- Modify `src/main/lifecycle/rebuildTradingDayState.ts`: 改用新的 seat snapshot helper。
- Modify `tests/architecture/typeOrganization.test.ts`: 增加旧入口和旧协议消失的回归护栏。
- Modify / rename `tests/utils/utils.business.test.ts` → `tests/utils/seat/snapshots.business.test.ts`: 测试迁移后的 seat snapshot helper。
- Create `tests/services/accountDisplay/business.test.ts`: 直接验证账户展示格式化行为。
- Delete `src/utils/utils.ts`。
- Delete `src/types/queue.ts`。

---

### Task 1: 收回单 owner helper 和局部协议

**Files:**

- Modify: `src/main/seatRuntimeCleanupDispatcher/types.ts`
- Modify: `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts`
- Modify: `src/app/startup/runtimeValidation.ts`
- Modify: `src/utils/runtime/index.ts`
- Modify: `src/services/accountDisplay/index.ts`
- Modify: `tests/architecture/typeOrganization.test.ts`
- Create: `tests/services/accountDisplay/business.test.ts`

- [ ] **Step 1: 写会失败的结构护栏测试**

把 `tests/architecture/typeOrganization.test.ts` 追加成下面这种护栏，先让它在旧结构下失败：

```ts
it('removes catch-all utils and queue protocol from the shared public surface', async () => {
  expect(await exists('src/utils/utils.ts')).toBe(false);
  expect(await exists('src/types/queue.ts')).toBe(false);

  const runtimeValidationSource = await readProjectFile('src/app/startup/runtimeValidation.ts');
  const runtimeSource = await readProjectFile('src/utils/runtime/index.ts');
  const accountDisplaySource = await readProjectFile('src/services/accountDisplay/index.ts');
  const queueCleanupSource = await readProjectFile(
    'src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts',
  );

  expect(runtimeValidationSource).not.toContain("from '../../utils/utils.js'");
  expect(runtimeSource).not.toContain("from '../utils.js'");
  expect(accountDisplaySource).not.toContain("from '../../utils/utils.js'");
  expect(queueCleanupSource).not.toContain("from '../../utils/utils.js'");
  expect(queueCleanupSource).not.toContain("from '../../types/queue.js'");
});
```

新增 `tests/services/accountDisplay/business.test.ts`，用 logger mock 断言 `displayAccountAndPositions` 仍能输出格式化文本：

```ts
import { describe, expect, it, mock } from 'bun:test';

const infoLogs: string[] = [];

mock.module('../../../src/utils/logger/index.js', () => ({
  logger: {
    debug: () => {},
    info: (message: string) => {
      infoLogs.push(message);
    },
    warn: () => {},
    error: () => {},
  },
}));

import { displayAccountAndPositions } from '../../../src/services/accountDisplay/index.js';
import type { DisplayAccountAndPositionsParams } from '../../../src/services/accountDisplay/types.js';

it('formats account channel and numeric fields in display output', () => {
  infoLogs.length = 0;
  const params = {
    lastState: {
      cachedAccount: {
        currency: 'HKD',
        totalCash: 1234.5,
        netAssets: 2345.6,
        positionValue: 1111.1,
      },
      cachedPositions: [
        {
          symbol: '700.HK',
          symbolName: 'Tencent',
          accountChannel: 'cash',
          quantity: 100,
          availableQuantity: 80,
          currency: 'HKD',
        },
      ],
    },
    quotesMap: new Map([['700.HK', { symbol: '700.HK', name: 'Tencent', price: 40.125 }]]),
  } as DisplayAccountAndPositionsParams;

  displayAccountAndPositions(params);

  expect(infoLogs.join('\n')).toContain('账户概览 [HKD] 余额=1234.50');
  expect(infoLogs.join('\n')).toContain('Tencent(700.HK)');
  expect(infoLogs.join('\n')).toContain('现价=40.125');
});
```

- [ ] **Step 2: 运行 focused tests，确认旧结构下失败**

Run:

```bash
bun test tests/architecture/typeOrganization.test.ts tests/services/accountDisplay/business.test.ts tests/main/seatRuntimeCleanupDispatcher/business.test.ts tests/utils/runtime.business.test.ts
```

Expected before implementation:

- `typeOrganization.test.ts` 因旧入口与旧协议仍存在而失败。
- `accountDisplay/business.test.ts` 可以先通过行为，但后续实现需要确保它仍通过。

- [ ] **Step 3: 把单 owner helper 收回各自 owner 文件**

在 `src/main/seatRuntimeCleanupDispatcher/types.ts` 加入：

```ts
export type QueueClearResult = Readonly<{
  removedDelayed: number;
  removedBuy: number;
  removedSell: number;
  removedMonitorTasks: number;
}>;
```

在 `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts` 改成：

```ts
import type { QueueClearResult } from './types.js';

const totalRemoved =
  result.removedDelayed + result.removedBuy + result.removedSell + result.removedMonitorTasks;
```

并删除对 `src/utils/utils.js` 与 `src/types/queue.js` 的依赖。

在 `src/app/startup/runtimeValidation.ts` 内部加入：

```ts
function shouldSkipRuntimeValidationSymbol(
  symbol: string | null,
  requiredSymbols: ReadonlySet<string>,
): boolean {
  return !symbol || requiredSymbols.has(symbol);
}
```

并删除旧的 `src/utils/utils.js` 导入。

在 `src/utils/runtime/index.ts` 内部加入：

```ts
function parseBooleanEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return null;
}
```

并删除旧的 `src/utils/utils.js` 导入。

在 `src/services/accountDisplay/index.ts` 内部加入：

```ts
function formatNumber(num: number | null | undefined, digits: number = 2): string {
  if (num === null || num === undefined) return '-';
  return Number.isFinite(num) ? num.toFixed(digits) : String(num);
}

function formatAccountChannel(accountChannel: string | null | undefined): string {
  if (!accountChannel || typeof accountChannel !== 'string') return '未知账户';
  const key = accountChannel.toLowerCase();
  return ACCOUNT_CHANNEL_MAP[key] ?? accountChannel;
}
```

并删除旧的 `src/utils/utils.js` 导入，补上 `ACCOUNT_CHANNEL_MAP` 的本地导入。

- [ ] **Step 4: 运行相关测试，确认行为不变**

Run:

```bash
bun test tests/architecture/typeOrganization.test.ts tests/services/accountDisplay/business.test.ts tests/main/seatRuntimeCleanupDispatcher/business.test.ts tests/utils/runtime.business.test.ts
```

Expected: 业务测试继续通过，结构护栏仍会在后续阶段保持绿色。

---

### Task 2: 迁移同域 set helper 与 seat snapshot helper

**Files:**

- Create: `src/main/monitorQuoteEventRuntime/setUtils.ts`
- Modify: `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
- Modify: `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
- Create: `src/utils/seat/types.ts`
- Create: `src/utils/seat/snapshots.ts`
- Modify: `src/app/context/createMonitorContexts.ts`
- Modify: `src/main/businessEventProgram/seatProjection.ts`
- Modify: `src/main/tradingRiskEventRuntime/routingIndex.ts`
- Modify: `src/main/lifecycle/cacheDomains/seatDomain.ts`
- Modify: `src/main/lifecycle/rebuildTradingDayState.ts`
- Modify: `tests/utils/seat/snapshots.business.test.ts`
- Modify: `tests/architecture/typeOrganization.test.ts`

- [ ] **Step 1: 写新的 set helper 测试与 snapshot 测试，先让旧导入失败**

把 `tests/utils/utils.business.test.ts` 迁移成 `tests/utils/seat/snapshots.business.test.ts`，内容保留现有 seat snapshot 断言，但把 import 改成：

```ts
import {
  resolveMonitorContextRuntimeSnapshot,
  resolveMonitorContextSeatSnapshot,
} from '../../../src/utils/seat/snapshots.js';
```

新增一条 `typeOrganization.test.ts` 护栏，确认旧入口导入不再存在：

```ts
it('moves seat projection helpers out of catch-all utils', async () => {
  const source = await readProjectFile('src/utils/seat/snapshots.ts');
  expect(source).toContain('resolveMonitorContextSeatSnapshot');
  expect(source).toContain('resolveMonitorContextRuntimeSnapshot');
  expect(await exists('src/utils/utils.ts')).toBe(false);
});
```

- [ ] **Step 2: 把 `areStringSetsEqual` 收回 monitorQuoteEventRuntime 同域**

在 `src/main/monitorQuoteEventRuntime/setUtils.ts` 加入：

```ts
export function areStringSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
```

把 `monitorQuoteEventRuntime.ts` 和 `switchWakeupRuntime.ts` 的 import 改为：

```ts
import { areStringSetsEqual } from './setUtils.js';
```

并删除对 `../../utils/utils.js` 的引用。

- [ ] **Step 3: 把 seat projection helper 与类型迁移到 `src/utils/seat`**

在 `src/utils/seat/types.ts` 定义：

```ts
export type MonitorContextSeatSnapshot = Readonly<{
  seatState: {
    readonly long: SeatState;
    readonly short: SeatState;
  };
  seatVersion: {
    readonly long: number;
    readonly short: number;
  };
  longSymbol: string | null;
  shortSymbol: string | null;
}>;

export type MonitorContextRuntimeSnapshot = MonitorContextSeatSnapshot &
  Readonly<{
    longQuote: Quote | null;
    shortQuote: Quote | null;
    monitorQuote: Quote | null;
    longSymbolName: string;
    shortSymbolName: string;
    monitorSymbolName: string;
  }>;
```

在 `src/utils/seat/snapshots.ts` 定义：

```ts
function resolveActiveSeatSymbol(seatState: SeatState): string | null { ... }

export function resolveMonitorContextSeatSnapshot(...): MonitorContextSeatSnapshot { ... }

export function resolveMonitorContextRuntimeSnapshot(...): MonitorContextRuntimeSnapshot { ... }
```

并把原先 `src/utils/utils.ts` 中对应实现完整搬过来。

更新以下消费方 import：

```ts
import { resolveMonitorContextRuntimeSnapshot } from '../../utils/seat/snapshots.js';
```

```ts
import { resolveMonitorContextSeatSnapshot } from '../../utils/seat/snapshots.js';
```

对应文件：

- `src/app/context/createMonitorContexts.ts`
- `src/main/businessEventProgram/seatProjection.ts`
- `src/main/tradingRiskEventRuntime/routingIndex.ts`
- `src/main/lifecycle/cacheDomains/seatDomain.ts`
- `src/main/lifecycle/rebuildTradingDayState.ts`

- [ ] **Step 4: 运行 focused tests，确认迁移后行为不变**

Run:

```bash
bun test tests/utils/seat/snapshots.business.test.ts tests/architecture/typeOrganization.test.ts tests/main/monitorQuoteEventRuntime/business.test.ts tests/main/lifecycle/rebuildTradingDayState.test.ts tests/main/tradingRiskEventRuntime/routingIndex.test.ts
```

Expected: 相关业务测试继续通过，旧 `src/utils/utils.js` 入口只剩待清理状态。

---

### Task 3: 删除旧入口并做全链路复核

**Files:**

- Delete: `src/utils/utils.ts`
- Delete: `src/types/queue.ts`
- Modify: `tests/architecture/typeOrganization.test.ts`
- Verify: `src/app/context/createMonitorContexts.ts`
- Verify: `src/main/businessEventProgram/seatProjection.ts`
- Verify: `src/main/tradingRiskEventRuntime/routingIndex.ts`
- Verify: `src/main/lifecycle/cacheDomains/seatDomain.ts`
- Verify: `src/main/lifecycle/rebuildTradingDayState.ts`
- Verify: `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
- Verify: `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
- Verify: `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts`
- Verify: `src/services/accountDisplay/index.ts`
- Verify: `src/utils/runtime/index.ts`

- [ ] **Step 1: 把最终结构护栏写完整**

在 `tests/architecture/typeOrganization.test.ts` 追加最终断言：

```ts
it('keeps the old catch-all utils files deleted', async () => {
  expect(await exists('src/utils/utils.ts')).toBe(false);
  expect(await exists('src/types/queue.ts')).toBe(false);
});
```

并确认没有任何生产文件再从以下旧入口导入：

```ts
from '../../utils/utils.js'
from '../../../utils/utils.js'
from '../utils.js'
from '../../types/queue.js'
```

- [ ] **Step 2: 删除旧文件并清理残留引用**

删除 `src/utils/utils.ts` 与 `src/types/queue.ts` 后，全文 grep 确认没有残留旧导入。

- [ ] **Step 3: 跑完整的定向验证**

Run:

```bash
bun test tests/architecture/typeOrganization.test.ts tests/services/accountDisplay/business.test.ts tests/main/seatRuntimeCleanupDispatcher/business.test.ts tests/utils/runtime.business.test.ts tests/utils/seat/snapshots.business.test.ts
bun lint
bun type-check
```

Expected: 全部通过，且 `git grep "utils/utils.js" src tests` / `git grep "types/queue.js" src tests` 无命中。

- [ ] **Step 4: 输出最终复核结论**

只输出这三项：

```md
- 已修复且验证通过的问题
- 真实存在但本轮不再扩大的问题
- 未发现的问题
```

不要把已经确认是 scope 外的文件重新拉回本轮。
