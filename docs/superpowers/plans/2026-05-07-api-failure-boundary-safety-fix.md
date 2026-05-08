# API Failure Boundary Safety Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复方案 A 中已确认必须修的 API failure / fail-fast / 外部事实边界问题，确保普通高时效信号不被误重试、任务性恢复链路可 retry、非 API 错误 fail-fast、非幂等下单失败不被静默消费。

**Architecture:** 保持现有事件驱动与异步处理器结构，不引入兼容层或兜底恢复框架。修复集中在错误分类边界、任务 owner 的 retry 语义、成交后一致性 freshness gate、外部订单事实校验。未经用户明确要求不创建 git commit；每个任务以测试和类型检查作为 checkpoint。

**Tech Stack:** TypeScript, bun test, bun format, bun lint, bun type-check, existing Longbridge SDK wrappers.

---

## File Structure

- Modify: `src/utils/apiFailure/types.ts`
  - 收紧 `ExternalApiRequestError` 类型，并新增外部 API 聚合失败参数类型。
- Modify: `src/utils/apiFailure/index.ts`
  - 新增 `createExternalApiAggregateRequestError()` / `isExternalApiRequestError()` 更严格判断 / `isAllExternalApiRequestErrors()`。
- Modify: `src/main/asyncProgram/buyProcessor/index.ts`
  - `TradeContext.submitOrder` 的 `ExternalApiRequestError` 不再被普通买入任务消费。
- Modify: `src/main/asyncProgram/sellProcessor/index.ts`
  - 同买入处理器，submit failure 进入 fatal。
- Modify: `src/main/asyncProgram/monitorTaskProcessor/types.ts`
  - 如现有 status 不足，增加 SEAT_REFRESH retry 所需状态或 task metadata。
- Modify: `src/main/asyncProgram/monitorTaskProcessor/index.ts`
  - 为 SEAT_REFRESH API failure 提供同 route 有界 retry owner。
- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`
  - API failure 不再 `markSeatAsEmpty()`；权威业务失败仍清空席位。
- Modify: `src/services/quoteClient/index.ts`
  - reset 聚合错误保持 API 分类，混合错误 fail-fast。
- Modify: `src/app/runtime/createPreGateRuntime.ts`
  - 只吞 `ExternalApiRequestError`。
- Modify: `src/app/runtime/createPostTradeConsistencyRuntime.ts`
  - 只对 `ExternalApiRequestError` retry；非 API 错误 fatal。
  - 检查 `refreshUnrealizedLossData()` 的 `null` 返回。
- Modify: `src/core/riskController/unrealizedLossChecker.ts`
  - 删除 catch-all；业务空结果与内部异常分离。
- Modify: `src/core/riskController/unrealizedLossMonitor.ts`
  - 已提交清仓后的本地收尾失败不再 catch-all 返回 false。
- Modify: `src/core/orderRecorder/orderApiManager.ts`
  - 校验 `historyOrders()` / `todayOrders()` 返回数组与订单最小字段。
- Tests:
  - `tests/main/asyncProgram/buyProcessor/business.test.ts`
  - `tests/main/asyncProgram/sellProcessor/business.test.ts`
  - `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`
  - `tests/services/quoteClient/business.test.ts`
  - `tests/app/runtime/createPreGateRuntime.minimalGate.test.ts`
  - `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`
  - `tests/core/orderRecorder/orderApiManager.business.test.ts` or nearest existing order recorder test file

---

## Task 1: 收紧 ExternalApiRequestError 与聚合分类

**Files:**

- Modify: `src/utils/apiFailure/types.ts`
- Modify: `src/utils/apiFailure/index.ts`
- Test: `tests/utils/apiFailure.business.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving stricter guard and aggregate classification:

```ts
import {
  createExternalApiAggregateRequestError,
  createExternalApiRequestError,
  isAllExternalApiRequestErrors,
  isExternalApiRequestError,
} from '../../src/utils/apiFailure/index.js';

it('rejects structurally similar errors with invalid operation or attempts', () => {
  const fake = Object.assign(new Error('fake'), {
    name: 'ExternalApiRequestError',
    operation: 123,
    attempts: '1',
  });

  expect(isExternalApiRequestError(fake)).toBeFalse();
});

it('classifies aggregate external API failures as ExternalApiRequestError', () => {
  const first = createExternalApiRequestError({
    operation: 'QuoteContext.unsubscribe.quote.reset',
    attempts: 2,
    cause: new Error('quote unavailable'),
  });
  const second = createExternalApiRequestError({
    operation: 'QuoteContext.unsubscribeCandlesticks.reset',
    attempts: 2,
    cause: new Error('kline unavailable'),
  });

  const aggregate = createExternalApiAggregateRequestError({
    operation: 'QuoteContext.resetRuntimeSubscriptionsAndCaches',
    attempts: 1,
    causes: [first, second],
  });

  expect(isExternalApiRequestError(aggregate)).toBeTrue();
  expect(isAllExternalApiRequestErrors([first, second])).toBeTrue();
  expect(isAllExternalApiRequestErrors([first, new Error('internal')])).toBeFalse();
});
```

- [ ] **Step 2: Run focused failing tests**

Run: `bun test tests/utils/apiFailure.business.test.ts`

Expected: fails because aggregate helpers do not exist and guard accepts invalid structural errors.

- [ ] **Step 3: Implement strict types and helpers**

In `src/utils/apiFailure/types.ts`, change the type shape to fixed `name` and add aggregate params:

```ts
export type ExternalApiRequestError = Error &
  Readonly<{
    name: 'ExternalApiRequestError';
    operation: string;
    attempts: number;
  }>;

export type ExternalApiAggregateRequestErrorParams = Readonly<{
  operation: string;
  attempts: number;
  causes: ReadonlyArray<ExternalApiRequestError>;
}>;
```

In `src/utils/apiFailure/index.ts`, update imports and helpers:

```ts
import type {
  ExternalApiAggregateRequestErrorParams,
  ExternalApiRequestError,
  ExternalApiRequestErrorParams,
  ExternalApiRetryConfig,
  WrapExternalApiRequestParams,
} from './types.js';

export function createExternalApiAggregateRequestError(
  params: ExternalApiAggregateRequestErrorParams,
): ExternalApiRequestError {
  const error = new AggregateError(
    params.causes,
    `[外部 API 请求失败] ${params.operation}: ${params.causes.length} 个请求失败`,
  );
  error.name = 'ExternalApiRequestError';
  return Object.assign(error, {
    operation: params.operation,
    attempts: params.attempts,
  });
}

export function isExternalApiRequestError(error: unknown): error is ExternalApiRequestError {
  return (
    error instanceof Error &&
    error.name === 'ExternalApiRequestError' &&
    'operation' in error &&
    typeof error.operation === 'string' &&
    error.operation.length > 0 &&
    'attempts' in error &&
    typeof error.attempts === 'number' &&
    Number.isInteger(error.attempts) &&
    error.attempts > 0
  );
}

export function isAllExternalApiRequestErrors(
  errors: ReadonlyArray<unknown>,
): errors is ReadonlyArray<ExternalApiRequestError> {
  return errors.length > 0 && errors.every(isExternalApiRequestError);
}
```

- [ ] **Step 4: Verify focused tests pass**

Run: `bun test tests/utils/apiFailure.business.test.ts`

Expected: PASS.

---

## Task 2: submitOrder failure 进入 fatal，不被普通处理器消费

**Files:**

- Modify: `src/main/asyncProgram/buyProcessor/index.ts`
- Modify: `src/main/asyncProgram/sellProcessor/index.ts`
- Test: `tests/main/asyncProgram/buyProcessor/business.test.ts`
- Test: `tests/main/asyncProgram/sellProcessor/business.test.ts`

- [ ] **Step 1: Write failing tests**

Add one buy processor test and one sell processor test where `trader.executeSignals()` throws:

```ts
const submitOrderFailure = Object.assign(new Error('submit timeout'), {
  name: 'ExternalApiRequestError' as const,
  operation: 'TradeContext.submitOrder',
  attempts: 1,
});
```

Expected assertions:

```ts
expect(fatalErrors).toHaveLength(1);
expect(fatalErrors[0]).toBe(submitOrderFailure);
expect(statuses).not.toContain('processed');
```

Also add/control-test where a non-submit API error is still logged and consumed:

```ts
const quoteFailure = Object.assign(new Error('quote timeout'), {
  name: 'ExternalApiRequestError' as const,
  operation: 'QuoteContext.realtimeQuote',
  attempts: 1,
});
```

Expected: no fatal error for non-submit failure in ordinary high-time-sensitivity path.

- [ ] **Step 2: Run focused failing tests**

Run:

```bash
bun test tests/main/asyncProgram/buyProcessor/business.test.ts tests/main/asyncProgram/sellProcessor/business.test.ts
```

Expected: submit failure tests fail because processors currently consume all `ExternalApiRequestError`.

- [ ] **Step 3: Implement minimal fatal classifier**

In both processors, change catch block to:

```ts
    } catch (err) {
      if (!isExternalApiRequestError(err)) {
        throw err;
      }

      if (err.operation === 'TradeContext.submitOrder') {
        throw err;
      }

      logProcessorTaskFailure('BuyProcessor', symbolDisplay, signal.action, err);
      return;
    }
```

For sell processor use `SellProcessor` in the log call.

- [ ] **Step 4: Verify focused tests pass**

Run:

```bash
bun test tests/main/asyncProgram/buyProcessor/business.test.ts tests/main/asyncProgram/sellProcessor/business.test.ts
```

Expected: PASS.

---

## Task 3: SEAT_REFRESH API failure 保留 ACTIVATING 并同 route retry

**Files:**

- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/types.ts` if needed
- Test: `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`

- [ ] **Step 1: Replace failing behavior test**

Update the existing test around `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts:1526-1575` to assert:

```ts
expect(statuses).toEqual(['failed']);
expect(fatalErrors).toEqual([]);
expect(context.symbolRegistry.getSeatState('HSI.HK', 'LONG')).toMatchObject({
  symbol: 'BULL.HK',
  status: 'ACTIVATING',
  callPrice: 20_000,
});
expect(context.longSymbolName).toBe('OLD_BULL');
expect(context.symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
```

Add a retry assertion using fake scheduler or processor flow already available in this test file. If the existing queue exposes pending task count, assert a new `SEAT_REFRESH` with same dedupe key/seatVersion is scheduled. If not, assert the second run executes `getQuotes` again without requiring a seat state change.

- [ ] **Step 2: Run focused failing test**

Run:

```bash
bun test tests/main/asyncProgram/monitorTaskProcessor/business.test.ts
```

Expected: fails because current handler clears seat and bumps version.

- [ ] **Step 3: Stop clearing seat on API failure**

In `seatRefresh.ts`, replace the catch block:

```ts
    } catch (error) {
      if (isExternalApiRequestError(error)) {
        throw error;
      }

      throw error;
    } finally {
```

Then simplify to:

```ts
    } catch (error) {
      throw error;
    } finally {
```

Keep `markSeatAsEmpty()` only for callPrice invalid and warrant info business failure.

- [ ] **Step 4: Add bounded route retry owner**

In `monitorTaskProcessor/index.ts`, in the `ExternalApiRequestError` catch for task processing, special-case `task.type === 'SEAT_REFRESH'` and schedule the same task once with the same dedupe key and same data after a fixed existing API retry delay. Use an existing constant if one already exists for API retry delay; otherwise use `API.DEFAULT_RETRY_DELAY_MS` from constants.

Implementation shape:

```ts
const seatRefreshRetryAttempts = new Map<string, number>();

function scheduleSeatRefreshRetry(task: MonitorTask<MonitorTaskDataMap>): void {
  if (task.type !== 'SEAT_REFRESH') {
    return;
  }

  const attempts = seatRefreshRetryAttempts.get(task.dedupeKey) ?? 0;
  if (attempts >= 1) {
    return;
  }

  seatRefreshRetryAttempts.set(task.dedupeKey, attempts + 1);
  setTimeout(() => {
    monitorTaskQueue.scheduleLatest(task);
  }, API.DEFAULT_RETRY_DELAY_MS);
}
```

On processed/skipped success for same dedupe key, clear the retry attempts.

- [ ] **Step 5: Verify focused tests pass**

Run:

```bash
bun test tests/main/asyncProgram/monitorTaskProcessor/business.test.ts
```

Expected: PASS. Seat remains ACTIVATING after API failure; retry behavior is bounded.

---

## Task 4: lifecycle reset aggregate API failure keeps retry classification

**Files:**

- Modify: `src/services/quoteClient/index.ts`
- Test: `tests/services/quoteClient/business.test.ts`
- Optional Test: `tests/main/lifecycle/dayLifecycleManager.test.ts`

- [ ] **Step 1: Write failing reset classification tests**

In quote client tests, add:

```ts
let caught: unknown = null;
try {
  await client.resetRuntimeSubscriptionsAndCaches();
} catch (error) {
  caught = error;
}

expect(isExternalApiRequestError(caught)).toBeTrue();
expect(caught).toBeInstanceOf(AggregateError);
```

For mixed error, seed one invalid candlestick key or otherwise trigger key format error plus API failure; assert:

```ts
expect(isExternalApiRequestError(caught)).toBeFalse();
expect(caught).toBeInstanceOf(AggregateError);
```

- [ ] **Step 2: Run focused failing tests**

Run: `bun test tests/services/quoteClient/business.test.ts`

Expected: pure API aggregate classification test fails.

- [ ] **Step 3: Implement reset classification**

In `quoteClient/index.ts`, import:

```ts
import {
  createExternalApiAggregateRequestError,
  isAllExternalApiRequestErrors,
} from '../../utils/apiFailure/index.js';
```

At throw site:

```ts
if (errors.length > 0) {
  if (isAllExternalApiRequestErrors(errors)) {
    throw createExternalApiAggregateRequestError({
      operation: 'QuoteContext.resetRuntimeSubscriptionsAndCaches',
      attempts: 1,
      causes: errors,
    });
  }

  throw new AggregateError(
    errors,
    `[行情重置] 退订失败 ${errors.length} 项，失败项已保留于订阅集合，可重试`,
  );
}
```

- [ ] **Step 4: Verify focused tests pass**

Run: `bun test tests/services/quoteClient/business.test.ts`

Expected: PASS.

---

## Task 5: createPreGateRuntime only swallows API failure

**Files:**

- Modify: `src/app/runtime/createPreGateRuntime.ts`
- Test: `tests/app/runtime/createPreGateRuntime.minimalGate.test.ts`

- [ ] **Step 1: Write failing tests**

Update existing minimal gate test so API failure uses `createExternalApiRequestError()`.

Add non-API rethrow test:

```ts
it('rethrows non API startup trading day resolver errors', async () => {
  const internalError = new Error('trading day parser broken');
  const createPreGateRuntime = createPreGateRuntimeFactory({
    ...DEFAULT_CREATE_PRE_GATE_RUNTIME_DEPS,
    createTradingDayInfoResolver: () => async () => {
      throw internalError;
    },
  });

  await expect(createPreGateRuntime({ env: {}, tradingConfig })).rejects.toBe(internalError);
});
```

Use the actual dependency override names from the existing test file.

- [ ] **Step 2: Run focused failing test**

Run: `bun test tests/app/runtime/createPreGateRuntime.minimalGate.test.ts`

Expected: non-API rethrow test fails because catch-all swallows.

- [ ] **Step 3: Implement API-only catch**

In `createPreGateRuntime.ts`, import `isExternalApiRequestError` and change:

```ts
    } catch {
      startupTradingDayInfo = null;
    }
```

to:

```ts
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        throw error;
      }

      startupTradingDayInfo = null;
    }
```

- [ ] **Step 4: Verify focused tests pass**

Run: `bun test tests/app/runtime/createPreGateRuntime.minimalGate.test.ts`

Expected: PASS.

---

## Task 6: PostTradeConsistencyRuntime only retries API failure

**Files:**

- Modify: `src/app/runtime/createPostTradeConsistencyRuntime.ts`
- Test: `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`

- [ ] **Step 1: Write failing tests**

Add test for ordinary `Error` fatal:

```ts
it('treats non API refresh errors as fatal', async () => {
  const internalError = new Error('position commit failed');
  const runtime = createPostTradeConsistencyRuntime({
    getTrader: () =>
      createTraderDouble({
        getAccountSnapshot: async () => createAccountSnapshotDouble(100),
        getStockPositions: async () => [createPositionDouble({ symbol: 'BULL.HK', quantity: 1 })],
      }),
    lastState: createLastState(),
    onPositionsCommitted: async () => {
      throw internalError;
    },
  });

  bindMinimalBusinessDeps(runtime);
  runtime.start();
  runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });

  await expect(runtime.waitForFatal()).resolves.toBe(internalError);
});
```

Add API failure retry test if not already present, using `createExternalApiRequestError()`.

- [ ] **Step 2: Run focused failing tests**

Run: `bun test tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`

Expected: ordinary Error test fails because runtime currently retries.

- [ ] **Step 3: Implement explicit retry/fatal split**

In catch block:

```ts
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        fatalInvariantDetected = true;
        recordFatalError(error);
        started = false;
        pendingNeed = createEmptyRefreshNeed();
        pendingVersion = null;
        refreshGate.abortWaiting('FATAL_INVARIANT');
        logger.error('[PostTradeConsistencyRuntime] 检测到不可恢复的一致性错误，停止运行时', {
          error: formatError(error),
        });
        throw error;
      }

      logger.warn('[PostTradeConsistencyRuntime] 刷新失败，准备重试', formatError(error));
    }
```

Keep existing `isAttributedSeatSymbolConflictError` only if it provides a more specific log before the same fatal behavior; do not let ordinary `Error` retry.

- [ ] **Step 4: Verify focused tests pass**

Run: `bun test tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`

Expected: PASS.

---

## Task 7: unrealizedLoss refresh must not hide internal errors or fake freshness

**Files:**

- Modify: `src/core/riskController/unrealizedLossChecker.ts`
- Modify: `src/app/runtime/createPostTradeConsistencyRuntime.ts`
- Test: `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`

- [ ] **Step 1: Write failing real-path test**

Add a test that binds a monitor context with real risk checker path or a risk checker whose `refreshUnrealizedLossData()` returns `null`.

For `null` return, expected behavior:

```ts
expect(runtime.getStatus().currentVersion).toBe(0);
expect(runtime.getStatus().staleVersion).toBe(1);
```

For thrown internal error, expected fatal:

```ts
await expect(runtime.waitForFatal()).resolves.toBe(internalError);
```

- [ ] **Step 2: Run focused failing test**

Run: `bun test tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`

Expected: fails because `null` is ignored or real checker catches internally.

- [ ] **Step 3: Remove catch-all in unrealizedLossChecker**

In `unrealizedLossChecker.ts`, remove the catch block around refresh. Keep only explicit `!orderRecorder` business empty branch:

```ts
  const refresh = (
    orderRecorder: OrderRecorder | null,
    symbol: string,
    isLongSymbol: boolean,
    quote?: Quote | null,
    dailyLossOffset?: number,
  ): Promise<{ r1: number; n1: number } | null> => {
    if (!orderRecorder) {
      const symbolDisplay = formatSymbolDisplayFromQuote(quote, symbol);
      logger.warn(`[浮亏监控] 未提供 OrderRecorder 实例，无法刷新标的 ${symbolDisplay} 的浮亏数据`);
      return Promise.resolve(null);
    }

    const buyOrders = orderRecorder.getBuyOrdersForSymbol(symbol, isLongSymbol);
    const { r1: baseR1, n1 } = calculateCostAndQuantity(buyOrders);
    ...
    return Promise.resolve({ r1: adjustedR1, n1 });
  };
```

- [ ] **Step 4: Check null return in post-trade runtime**

In `refreshAttributedUnrealizedLossData()`, store the result:

```ts
const refreshResult = await monitorContext.riskChecker.refreshUnrealizedLossData(
  monitorContext.orderRecorder,
  symbol,
  isLongSymbol,
  null,
  dailyLossOffset,
);
if (refreshResult === null) {
  refreshOk = false;
  logger.warn(`[PostTradeConsistencyRuntime] 浮亏缓存刷新未产生有效结果: ${symbol}`);
}
```

- [ ] **Step 5: Verify focused tests pass**

Run: `bun test tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`

Expected: PASS.

---

## Task 8: 保护性清仓已提交后的本地收尾失败不吞错

**Files:**

- Modify: `src/core/riskController/unrealizedLossMonitor.ts`
- Test: nearest test file covering unrealized loss monitor or trading risk runtime.

- [ ] **Step 1: Write failing test**

Create or update a test where `executeSignals()` succeeds but `riskChecker.refreshUnrealizedLossData()` throws `Error('refresh failed after liquidation submitted')`.

Expected:

```ts
await expect(monitor.checkAndLiquidate(...)).rejects.toThrow('refresh failed after liquidation submitted');
```

Use the actual public method name from `unrealizedLossMonitor.ts`.

- [ ] **Step 2: Run focused failing test**

Run the specific test file containing unrealized loss monitor coverage.

Expected: fails because current implementation catches and returns `false`.

- [ ] **Step 3: Implement submitted-boundary rethrow**

In `unrealizedLossMonitor.ts`, split the flow so errors before submit may return false if they are expected business failures, but after `executeSignals()` succeeds, local cleanup errors rethrow.

Implementation shape:

```ts
const executionResult = await trader.executeSignals([liquidationSignal]);
if (executionResult.submittedCount === 0) {
  return false;
}

orderRecorder.clearBuyOrders(symbol, isLongSymbol);
await riskChecker.refreshUnrealizedLossData(orderRecorder, symbol, isLongSymbol, quote);
return true;
```

Do not wrap this post-submit block in catch-all.

- [ ] **Step 4: Verify focused tests pass**

Run the focused test.

Expected: PASS.

---

## Task 9: orderApiManager validates external order facts

**Files:**

- Modify: `src/core/orderRecorder/orderApiManager.ts`
- Test: `tests/core/orderRecorder/orderApiManager.business.test.ts` or closest existing order recorder test.

- [ ] **Step 1: Write failing tests**

Add tests:

```ts
it('fails fast when historyOrders returns non-array value', async () => {
  const manager = createOrderApiManagerWithTradeContext({
    historyOrders: async () => ({ [Symbol.iterator]: function* () {} }) as never,
    todayOrders: async () => [],
  });

  await expect(manager.fetchAllOrdersFromAPI(true)).rejects.toThrow('historyOrders 返回值不是数组');
});

it('fails fast when API order misses required fields', async () => {
  const manager = createOrderApiManagerWithTradeContext({
    historyOrders: async () => [{ orderId: undefined }] as never,
    todayOrders: async () => [],
  });

  await expect(manager.fetchAllOrdersFromAPI(true)).rejects.toThrow('订单数据结构无效');
});
```

Use existing factory/helper names from the nearest order recorder tests.

- [ ] **Step 2: Run focused failing tests**

Run the order recorder test file.

Expected: fails because invalid values are currently accepted/mapped.

- [ ] **Step 3: Implement array and minimum field validation**

In `orderApiManager.ts`, add local validation helpers near `orderToRawOrderFromAPI`:

```ts
function assertOrderArray(
  value: unknown,
  operation: string,
): asserts value is ReadonlyArray<Order> {
  if (!Array.isArray(value)) {
    throw new TypeError(`[订单记录] ${operation} 返回值不是数组`);
  }
}

function assertValidOrder(value: Order, operation: string): void {
  const candidate = value as Partial<Order>;
  if (
    typeof candidate.orderId !== 'string' ||
    candidate.orderId.length === 0 ||
    typeof candidate.symbol !== 'string' ||
    candidate.symbol.length === 0 ||
    typeof candidate.stockName !== 'string' ||
    typeof candidate.side !== 'string' ||
    typeof candidate.status !== 'string' ||
    typeof candidate.orderType !== 'string' ||
    !(candidate.submittedAt instanceof Date)
  ) {
    throw new TypeError(`[订单记录] ${operation} 订单数据结构无效`);
  }
}
```

Before mapping:

```ts
    const historyOrdersRaw = await wrapExternalApiRequest<unknown>({ ... });
    assertOrderArray(historyOrdersRaw, 'TradeContext.historyOrders');
    for (const order of historyOrdersRaw) {
      assertValidOrder(order, 'TradeContext.historyOrders');
    }
```

Repeat for today orders.

- [ ] **Step 4: Verify focused tests pass**

Run the order recorder test file.

Expected: PASS.

---

## Task 10: Full verification and second-pass review

**Files:**

- No direct production changes unless previous tasks reveal compile failures.

- [ ] **Step 1: Run formatting**

Run: `bun format`

Expected: exits 0.

- [ ] **Step 2: Run lint**

Run: `bun lint`

Expected: exits 0.

- [ ] **Step 3: Run type-check**

Run: `bun type-check`

Expected: exits 0.

- [ ] **Step 4: Run targeted test suite**

Run:

```bash
bun test tests/utils/apiFailure.business.test.ts \
  tests/main/asyncProgram/buyProcessor/business.test.ts \
  tests/main/asyncProgram/sellProcessor/business.test.ts \
  tests/main/asyncProgram/monitorTaskProcessor/business.test.ts \
  tests/services/quoteClient/business.test.ts \
  tests/app/runtime/createPreGateRuntime.minimalGate.test.ts \
  tests/app/runtime/createPostTradeConsistencyRuntime.test.ts
```

Also run the order recorder and unrealized loss monitor test files selected in Tasks 8-9.

Expected: all pass.

- [ ] **Step 5: Second-pass logic review**

Read the modified catch blocks and verify:

```text
- Ordinary buy pre-check API failure: logged and current task abandoned.
- TradeContext.submitOrder API failure: rethrown to fatal channel.
- SEAT_REFRESH API failure: seat remains ACTIVATING and retry is same route.
- resetRuntimeSubscriptionsAndCaches pure API aggregate: classified as ExternalApiRequestError.
- createPreGateRuntime non-API error: rethrows.
- PostTradeConsistencyRuntime non-API error: fatal.
- unrealized loss refresh internal error: cannot markFresh.
- orderApiManager invalid external facts: fail-fast before RawOrderFromAPI mapping.
```

Expected: each statement is true by direct code inspection.

---

## Self-Review

- Spec coverage: All approved方案 A 必须修项 are mapped to Tasks 1-9, with verification in Task 10.
- Scope control: Deferred items remain deferred unless touched by required tasks; no doomsday result union or quotesMap unavailable refactor in this plan.
- Placeholder scan: Implementation tasks include exact target files, test intent, expected failing behavior, and concrete implementation snippets. Where exact test helper names depend on current test file internals, the plan names the required assertion and the exact file to adapt.
- Type consistency: `ExternalApiRequestError` remains the central retry classifier; aggregate API failure is represented as an `AggregateError` object that also satisfies `ExternalApiRequestError`.
