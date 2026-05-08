# API Retry Boundary Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复真实存在的 API retry / fail-fast / 非幂等提交边界问题，确保外部 API 失败不会伪造成空事实或业务失败，内部错误不会被吞掉。

**Architecture:** 采用边界型外科修复：API failure 只能通过受控 brand 分类，高时效读取使用 no-retry，非 API 程序错误直接 fail-fast。席位激活、末日清仓、post-trade、延迟验证和 route runtime 都保留现有架构，只补齐明确 owner 或 fatal 可观测通道。

**Tech Stack:** Bun, TypeScript strict mode, bun:test, Longbridge OpenAPI SDK, existing factory-function architecture.

---

## Safety note

本仓库会话规则要求：除非用户明确要求，否则不要创建 git commit。因此本计划不包含 commit 步骤；每个任务以 targeted tests 和状态检查作为 checkpoint。

## File map

- Modify `src/utils/apiFailure/types.ts`: 给 `ExternalApiRequestError` 类型增加只读 brand 字段。
- Modify `src/utils/apiFailure/index.ts`: 增加模块私有 brand symbol，工厂创建时打 brand，识别时检查 brand。
- Modify `tests/utils/apiFailure.business.test.ts`: 增加合法字段 fake error 不能通过识别的测试。
- Modify `src/core/trader/accountService.ts`: 给账户与持仓读取增加可选 retryConfig 参数。
- Modify `src/core/trader/types.ts`: 更新 `AccountService` 方法签名，允许传入 retryConfig。
- Modify `src/core/signalProcessor/riskCheckPipeline.ts`: 买入前实时账户/持仓读取使用 no-retry；普通非 API 错误直接抛出。
- Modify `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`: 增加 no-retry 与普通 Error fail-fast 测试。
- Modify `src/core/trader/orderExecutor/quantityResolver.ts`: 卖出持仓读取使用 no-retry。
- Modify focused quantity/order executor tests: 增加 stockPositions attempts=1 覆盖。
- Modify `src/main/recovery/seatPreparation.ts`: recovery search 的 API failure 不冻结；非 API 失败传播。
- Modify recovery tests: 覆盖 API failure 不冻结、非 API fail-fast、恢复 ACTIVATING 调度刷新 owner。
- Modify seat activation scheduling owner file if needed, likely `src/main/seatActivationDispatcher/index.ts` or app/runtime wiring: 保证恢复阶段 ACTIVATING 调度 `SEAT_REFRESH`。
- Modify `src/main/asyncProgram/monitorTaskProcessor/index.ts`: `SEAT_REFRESH` retry 耗尽后回 `EMPTY`，不再停留 `ACTIVATING`。
- Modify `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`: 更新 retry 耗尽测试期望。
- Modify `src/main/timeWakeupEvaluationProgram/index.ts`: `TradeContext.submitOrder` unknown outcome 不进入普通 `API_RETRY`。
- Modify `tests/main/timeWakeupEvaluationProgram/business.test.ts`: 覆盖 submitOrder failure 不安排重提。
- Modify `src/core/trader/orderCacheManager.ts`: `todayOrders` 单条结构错误 fail-fast。
- Modify trader/order cache tests: 覆盖坏订单结构抛 `TypeError`。
- Modify `src/app/runtime/createPostTradeConsistencyRuntime.ts`: `refreshUnrealizedLossData() === null` 抛 `TypeError`。
- Modify `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`: 覆盖 null fatal 且不 retry。
- Modify `src/main/asyncProgram/delayedSignalVerifier/types.ts`: 如需新增 fatal callback 端口，更新依赖类型。
- Modify `src/main/asyncProgram/delayedSignalVerifier/index.ts`: `onVerified` 回调错误可观测。
- Modify `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`: 覆盖回调错误不吞。
- Modify `src/main/tradingRiskEventRuntime/types.ts`: 增加可选 `onFatalError` 端口。
- Modify `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`: route 异常进入 fatal 通道。
- Modify `src/main/monitorQuoteEventRuntime/types.ts`: 给 `SwitchWakeupRuntime` deps 增加可选 `onFatalError`。
- Modify `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`: pending switch route 异常进入 fatal 通道。
- Modify `src/app/runtime/createAsyncRuntime.ts` or runtime wiring if needed: 将 fatal handler 注入 route runtimes where available.
- Modify route runtime tests: 覆盖内部错误可观测，`STOP_AND_DRAIN` 仍忽略。

---

### Task 1: Brand ExternalApiRequestError

**Files:**

- Modify: `src/utils/apiFailure/types.ts`
- Modify: `src/utils/apiFailure/index.ts`
- Test: `tests/utils/apiFailure.business.test.ts`

- [ ] **Step 1: Write failing fake-brand test**

Add this test to `tests/utils/apiFailure.business.test.ts` inside `describe('apiFailure boundary', () => { ... })`:

```ts
it('rejects structurally valid fake ExternalApiRequestError objects', () => {
  const fake = Object.assign(new Error('internal failure with fake fields'), {
    name: 'ExternalApiRequestError',
    operation: 'TradeContext.accountBalance',
    attempts: 1,
  });

  expect(isExternalApiRequestError(fake)).toBeFalse();
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
bun test tests/utils/apiFailure.business.test.ts
```

Expected before implementation: the new test fails because `isExternalApiRequestError(fake)` returns `true`.

- [ ] **Step 3: Add brand type field**

Modify `src/utils/apiFailure/types.ts` so `ExternalApiRequestError` includes a readonly brand. Use a string-key brand because the symbol remains private to the implementation module:

```ts
export type ExternalApiRequestError = Error &
  Readonly<{
    name: 'ExternalApiRequestError';
    operation: string;
    attempts: number;
    __externalApiRequestErrorBrand: true;
  }>;
```

- [ ] **Step 4: Brand controlled constructors and guard**

Modify `src/utils/apiFailure/index.ts` near the retry config constants:

```ts
const EXTERNAL_API_REQUEST_ERROR_BRAND = '__externalApiRequestErrorBrand';
```

Update both constructors to set the brand:

```ts
return Object.assign(error, {
  name: 'ExternalApiRequestError' as const,
  operation: params.operation,
  attempts: params.attempts,
  [EXTERNAL_API_REQUEST_ERROR_BRAND]: true as const,
});
```

Update `isExternalApiRequestError` to require the brand:

```ts
export function isExternalApiRequestError(error: unknown): error is ExternalApiRequestError {
  return (
    error instanceof Error &&
    error.name === 'ExternalApiRequestError' &&
    EXTERNAL_API_REQUEST_ERROR_BRAND in error &&
    error[EXTERNAL_API_REQUEST_ERROR_BRAND] === true &&
    'operation' in error &&
    typeof error.operation === 'string' &&
    error.operation.length > 0 &&
    'attempts' in error &&
    typeof error.attempts === 'number' &&
    Number.isInteger(error.attempts) &&
    error.attempts > 0
  );
}
```

- [ ] **Step 5: Run focused test and verify pass**

Run:

```bash
bun test tests/utils/apiFailure.business.test.ts
```

Expected: all tests pass.

---

### Task 2: Add no-retry account and position reads

**Files:**

- Modify: `src/core/trader/types.ts`
- Modify: `src/core/trader/accountService.ts`
- Test: existing focused trader/account/risk tests, primarily `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`

- [ ] **Step 1: Update AccountService type signature**

In `src/core/trader/types.ts`, locate `AccountService`. Change the methods from zero-arg reads to accept an optional retry config object:

```ts
export interface AccountService {
  readonly getAccountSnapshot: (params?: {
    readonly retryConfig?: ExternalApiRetryConfig;
  }) => Promise<AccountSnapshot>;
  readonly getStockPositions: (params?: {
    readonly symbols?: ReadonlyArray<string> | null;
    readonly retryConfig?: ExternalApiRetryConfig;
  }) => Promise<ReadonlyArray<Position>>;
}
```

If `ExternalApiRetryConfig` is not already imported in that file, add:

```ts
import type { ExternalApiRetryConfig } from '../../utils/apiFailure/types.js';
```

Use the correct relative path from `src/core/trader/types.ts`; if the file already imports from `../../utils/...`, keep that style.

- [ ] **Step 2: Implement optional retryConfig in accountService**

In `src/core/trader/accountService.ts`, update `getAccountSnapshot`:

```ts
  const getAccountSnapshot = async (params?: {
    readonly retryConfig?: ExternalApiRetryConfig;
  }): Promise<AccountSnapshot> => {
    await rateLimiter.throttle();
    const balances = await wrapExternalApiRequest({
      operation: 'TradeContext.accountBalance',
      request: () => ctx.accountBalance(),
      ...(params?.retryConfig ? { retryConfig: params.retryConfig } : {}),
    });
```

Update `getStockPositions` to accept params while preserving current callers:

```ts
  const getStockPositions = async (params?: {
    readonly symbols?: ReadonlyArray<string> | null;
    readonly retryConfig?: ExternalApiRetryConfig;
  }): Promise<ReadonlyArray<Position>> => {
    const symbols = params?.symbols ?? null;
    await rateLimiter.throttle();

    const resp = await wrapExternalApiRequest({
      operation: 'TradeContext.stockPositions',
      request: () => ctx.stockPositions(symbols ? [...symbols] : undefined),
      ...(params?.retryConfig ? { retryConfig: params.retryConfig } : {}),
    });
```

Add the type import:

```ts
import type { ExternalApiRetryConfig } from '../../utils/apiFailure/types.js';
```

- [ ] **Step 3: Preserve existing positional stock position callers if needed**

If TypeScript reports callers using `trader.getStockPositions(symbolsArray)`, update those callers to:

```ts
trader.getStockPositions({ symbols: symbolsArray });
```

Do not add overload shims; use the new object parameter consistently.

- [ ] **Step 4: Run type-check for signature issues**

Run:

```bash
bun type-check
```

Expected at this step: either pass, or show only call-site type errors for `getStockPositions(...)` that must be updated as described in Step 3.

---

### Task 3: Make riskCheckPipeline high-time reads no-retry and fail-fast

**Files:**

- Modify: `src/core/signalProcessor/riskCheckPipeline.ts`
- Test: `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`

- [ ] **Step 1: Add failing no-retry test**

Add a test in `tests/core/signalProcessor/riskCheckPipeline.business.test.ts` that builds a buy signal passing earlier gates and a trader double whose `getAccountSnapshot` rejects with a normal API-like error twice if retried. The expected assertion should prove the method is called once.

Use this shape for the trader double override:

```ts
let accountAttempts = 0;
const trader = createTraderDouble({
  getAccountSnapshot: async () => {
    accountAttempts += 1;
    throw createExternalApiRequestError({
      operation: 'TradeContext.accountBalance',
      attempts: 1,
      cause: new Error('temporary account failure'),
    });
  },
  getStockPositions: async () => [],
});
```

After invoking the pipeline, assert:

```ts
expect(accountAttempts).toBe(1);
```

- [ ] **Step 2: Add failing ordinary Error fail-fast test**

Add another test where `getAccountSnapshot` throws `new Error('unexpected parser failure')`. Assert the pipeline rejects:

```ts
await expect(runRiskPipeline()).rejects.toThrow('unexpected parser failure');
```

Also assert the basic risk checker was not called if the test harness exposes that counter.

- [ ] **Step 3: Run focused test and verify failure**

Run:

```bash
bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts
```

Expected before implementation: the ordinary Error test fails because the code converts it to a rejected buy signal; no-retry may also fail depending on the double path.

- [ ] **Step 4: Implement no-retry and fail-fast**

In `src/core/signalProcessor/riskCheckPipeline.ts`, define a local constant near the function body or module constants:

```ts
const HIGH_FRESHNESS_API_RETRY_CONFIG = {
  retries: 0,
  delayMs: 0,
} as const;
```

Update the realtime reads:

```ts
[realtimeAccount, realtimePositions] = await Promise.all([
  trader.getAccountSnapshot({ retryConfig: HIGH_FRESHNESS_API_RETRY_CONFIG }),
  trader.getStockPositions({ retryConfig: HIGH_FRESHNESS_API_RETRY_CONFIG }),
]);
```

Update the catch block to fail-fast all non-API errors:

```ts
        } catch (err) {
          lastRiskCheckTime.delete(cooldownKey);
          throw err;
        }
```

This is intentionally strict: API failure and program failure both leave this pipeline; the async processor decides the API failure boundary.

- [ ] **Step 5: Run focused test and verify pass**

Run:

```bash
bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts
```

Expected: pass.

---

### Task 4: Make quantityResolver sell position read no-retry

**Files:**

- Modify: `src/core/trader/orderExecutor/quantityResolver.ts`
- Test: focused order executor / sell processor test file that covers `calculateSellQuantity`

- [ ] **Step 1: Locate focused test file**

Run:

```bash
git grep -n "calculateSellQuantity\|quantityResolver\|stockPositions.quantityResolver" tests src
```

Expected: find either a direct quantity resolver test or sell processor test. Use the most focused existing test file.

- [ ] **Step 2: Add failing attempts test**

In the focused test file, add a test where `ctx.stockPositions([symbol])` increments `attempts` and throws `new Error('position unavailable')`. Invoke the sell quantity path and assert `attempts` is `1` after rejection.

Use this expected assertion:

```ts
await expect(calculateSellQuantity(ctx, 'BULL.HK', sellSignal)).rejects.toMatchObject({
  name: 'ExternalApiRequestError',
  operation: 'TradeContext.stockPositions.quantityResolver',
});
expect(attempts).toBe(1);
```

If the test reaches the resolver through `submitTargetOrder`, assert that function rejects with the same `ExternalApiRequestError` and the attempts count remains `1`.

- [ ] **Step 3: Run focused test and verify failure**

Run the focused test file selected in Step 1.

Expected before implementation: attempts is greater than `1` because default retry is used.

- [ ] **Step 4: Implement no-retry**

In `src/core/trader/orderExecutor/quantityResolver.ts`, add a local constant near the factory:

```ts
const HIGH_FRESHNESS_API_RETRY_CONFIG = {
  retries: 0,
  delayMs: 0,
} as const;
```

Update the wrapper call:

```ts
const resp = await wrapExternalApiRequest({
  operation: 'TradeContext.stockPositions.quantityResolver',
  request: () => ctx.stockPositions([symbol]),
  retryConfig: HIGH_FRESHNESS_API_RETRY_CONFIG,
});
```

- [ ] **Step 5: Run focused test and verify pass**

Run the same focused test file.

Expected: pass with attempts `1`.

---

### Task 5: Fix recovery seat search error classification

**Files:**

- Modify: `src/main/recovery/seatPreparation.ts`
- Test: focused recovery/seat preparation tests, likely under `tests/main/recovery/` or lifecycle snapshot tests

- [ ] **Step 1: Locate focused tests**

Run:

```bash
git grep -n "prepareSeatsForRuntime\|席位恢复\|searchFailCountToday" tests/main tests/app
```

Expected: find the most focused test file for `prepareSeatsForRuntime`.

- [ ] **Step 2: Add API failure does not freeze test**

In the focused test file, add a test where `findBestWarrant` or the underlying quote context request rejects with `createExternalApiRequestError({ operation: 'QuoteContext.warrantList', attempts: 1, cause: new Error('network') })`.

Assert:

```ts
await expect(prepareSeatsForRuntime(params)).rejects.toMatchObject({
  name: 'ExternalApiRequestError',
  operation: 'QuoteContext.warrantList',
});
expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').searchFailCountToday).toBe(0);
expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').frozenTradingDayKey).toBeNull();
expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('EMPTY');
```

- [ ] **Step 3: Add non-API fail-fast test**

Add a test where the same search dependency throws `new TypeError('warrant payload contract broken')`.

Assert:

```ts
await expect(prepareSeatsForRuntime(params)).rejects.toThrow(TypeError);
expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('EMPTY');
expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').searchFailCountToday).toBe(0);
```

- [ ] **Step 4: Run focused test and verify failure**

Run the focused test file selected in Step 1.

Expected before implementation: API failure is swallowed/converted into failure count, or non-API error is not propagated.

- [ ] **Step 5: Implement reset-without-failure helper**

In `src/main/recovery/seatPreparation.ts`, import:

```ts
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
```

Add a helper near `handleSearchException`:

```ts
function resetSearchingSeatAfterException(
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
  currentTime: Date,
): void {
  const stuckSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
  if (stuckSeat.status !== 'SEARCHING') {
    return;
  }

  symbolRegistry.updateSeatState(monitorSymbol, direction, {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: stuckSeat.lastSwitchAt ?? null,
    lastSearchAt: currentTime.getTime(),
    lastSeatActivatedAt: stuckSeat.lastSeatActivatedAt ?? null,
    callPrice: null,
    searchFailCountToday: stuckSeat.searchFailCountToday,
    frozenTradingDayKey: stuckSeat.frozenTradingDayKey,
  });
}
```

- [ ] **Step 6: Change catch block to propagate**

Replace the catch in `trySearchEmptySeats` with:

```ts
        } catch (err) {
          resetSearchingSeatAfterException(monitorConfig.monitorSymbol, direction, currentTime);
          if (isExternalApiRequestError(err)) {
            logger.warn(
              `[席位恢复] ${monitorConfig.monitorSymbol} ${direction} 寻标 API 请求失败，等待恢复链路重试: ${err.message}`,
            );
            throw err;
          }

          throw err;
        }
```

Do not call `handleSearchException` from this catch; `handleSearchException` remains only for explicit no-candidate style paths if still used.

- [ ] **Step 7: Run focused test and verify pass**

Run the focused recovery test file.

Expected: new tests pass.

---

### Task 6: Ensure recovery ACTIVATING seats schedule SEAT_REFRESH

**Files:**

- Modify: the owner that calls `prepareSeatsForRuntime`, likely `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts` or app runtime wiring
- Modify: `src/main/recovery/seatPreparation.ts` if returning activated seat metadata is the shortest path
- Test: focused seat activation dispatcher or lifecycle snapshot tests

- [ ] **Step 1: Locate activation dispatch wiring**

Run:

```bash
git grep -n "SeatActivationDispatcher\|createSeatActivationDispatcher\|scheduleSeatRefresh\|SEAT_REFRESH" src tests
```

Expected: identify the code path that schedules `SEAT_REFRESH` when a seat enters `ACTIVATING`.

- [ ] **Step 2: Add failing recovery scheduling test**

Add a test in the most focused lifecycle/recovery wiring test where `prepareSeatsForRuntime` restores or finds a symbol and leaves the seat in `ACTIVATING`.

Assert that the monitor task queue receives a task like:

```ts
expect(queueItems).toContainEqual(
  expect.objectContaining({
    type: 'SEAT_REFRESH',
    monitorSymbol: 'HSI.HK',
    data: expect.objectContaining({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      nextSymbol: 'BULL.HK',
    }),
  }),
);
```

- [ ] **Step 3: Run focused test and verify failure**

Run the focused test file.

Expected before implementation: no `SEAT_REFRESH` is scheduled for pre-existing/recovery `ACTIVATING` state.

- [ ] **Step 4: Implement explicit recovery activation dispatch**

Use the existing dispatcher API if available. The desired code shape near the owner that calls `prepareSeatsForRuntime` is:

```ts
await prepareSeatsForRuntime({
  tradingConfig,
  symbolRegistry,
  positions: lastState.cachedPositions,
  orders: allOrders,
  marketDataClient,
  now,
  logger,
  getTradingMinutesSinceOpen,
});

seatActivationDispatcher.dispatchActivatingSeats({
  reason: 'RUNTIME_RECOVERY',
});
```

If the dispatcher has no scan method, add a focused method to `src/main/seatActivationDispatcher/index.ts` that scans current seats and schedules refresh only for current `ACTIVATING` seats:

```ts
function dispatchCurrentActivatingSeats(): void {
  for (const monitorConfig of tradingConfig.monitors) {
    for (const direction of ['LONG', 'SHORT'] as const) {
      const seatState = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, direction);
      if (seatState.status !== 'ACTIVATING' || !seatState.symbol) {
        continue;
      }

      scheduleSeatRefresh({
        monitorSymbol: monitorConfig.monitorSymbol,
        direction,
        seatVersion: symbolRegistry.getSeatVersion(monitorConfig.monitorSymbol, direction),
        previousSymbol: null,
        nextSymbol: seatState.symbol,
        callPrice: seatState.callPrice,
        symbolName: null,
      });
    }
  }
}
```

Name the method according to existing dispatcher naming. Do not create a generic polling loop.

- [ ] **Step 5: Run focused test and verify pass**

Run the focused test file.

Expected: recovery `ACTIVATING` seats schedule exactly one `SEAT_REFRESH` task.

---

### Task 7: Make SEAT_REFRESH retry exhaustion end in EMPTY

**Files:**

- Modify: `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts` if reusing mark-empty behavior is better
- Test: `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`

- [ ] **Step 1: Update existing failing expectation**

Find the test around line 1527 that currently asserts two failed attempts leave the seat `ACTIVATING`. Change it to expect:

```ts
expect(statuses).toEqual(['failed', 'failed']);
expect(context.symbolRegistry.getSeatState('HSI.HK', 'LONG')).toMatchObject({
  symbol: null,
  status: 'EMPTY',
});
```

Also assert the seat version has bumped if the test can read it:

```ts
expect(context.symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBeGreaterThan(
  originalSeatVersion,
);
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
bun test tests/main/asyncProgram/monitorTaskProcessor/business.test.ts
```

Expected before implementation: updated test fails because the seat remains `ACTIVATING`.

- [ ] **Step 3: Add retry exhaustion finalizer**

In `src/main/asyncProgram/monitorTaskProcessor/index.ts`, add a helper that marks a matching `SEAT_REFRESH` seat empty when no more retry is scheduled:

```ts
function finalizeExhaustedSeatRefresh(task: MonitorTask<MonitorTaskDataMap>): void {
  if (task.type !== 'SEAT_REFRESH') {
    return;
  }

  const context = getMonitorContext(task.monitorSymbol);
  const currentSeat = context?.symbolRegistry.getSeatState(
    task.data.monitorSymbol,
    task.data.direction,
  );
  const currentSeatVersion = context?.symbolRegistry.getSeatVersion(
    task.data.monitorSymbol,
    task.data.direction,
  );
  if (
    context === null ||
    currentSeat === undefined ||
    currentSeatVersion !== task.data.seatVersion ||
    currentSeat.symbol !== task.data.nextSymbol ||
    currentSeat.status !== 'ACTIVATING'
  ) {
    return;
  }

  context.symbolRegistry.updateSeatStateWithVersionBump(
    task.data.monitorSymbol,
    task.data.direction,
    {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: Date.now(),
      lastSearchAt: currentSeat.lastSearchAt ?? Date.now(),
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: currentSeat.searchFailCountToday,
      frozenTradingDayKey: currentSeat.frozenTradingDayKey,
    },
  );
}
```

- [ ] **Step 4: Make retry helper return whether it scheduled**

Change `retrySeatRefreshOnce` to return `boolean`:

```ts
  function retrySeatRefreshOnce(task: MonitorTask<MonitorTaskDataMap>): boolean {
    if (task.type !== 'SEAT_REFRESH') {
      return false;
    }

    const apiRetryAttempt = task.data.apiRetryAttempt ?? 0;
    if (apiRetryAttempt >= 1) {
      return false;
    }
```

At each early return where an existing matching timer means retry is already scheduled, return `true`. After setting the timer, return `true`.

- [ ] **Step 5: Finalize exhausted refresh in catch**

Update the catch in `processQueue`:

```ts
const retryScheduled = retrySeatRefreshOnce(task);
if (!retryScheduled) {
  finalizeExhaustedSeatRefresh(task);
}
return 'failed' as const;
```

- [ ] **Step 6: Run focused test and verify pass**

Run:

```bash
bun test tests/main/asyncProgram/monitorTaskProcessor/business.test.ts
```

Expected: pass.

---

### Task 8: Stop ordinary API retry for doomsday submitOrder unknown outcome

**Files:**

- Modify: `src/main/timeWakeupEvaluationProgram/index.ts`
- Test: `tests/main/timeWakeupEvaluationProgram/business.test.ts`

- [ ] **Step 1: Add failing submitOrder test**

In `tests/main/timeWakeupEvaluationProgram/business.test.ts`, add or update a test where `doomsdayProtection.executeClearance` reaches `TradeContext.submitOrder` and throws:

```ts
createExternalApiRequestError({
  operation: 'TradeContext.submitOrder',
  attempts: 1,
  cause: new Error('submit outcome unknown'),
});
```

Assert the evaluation rejects instead of returning an `API_RETRY` plan:

```ts
await expect(evaluate()).rejects.toMatchObject({
  name: 'ExternalApiRequestError',
  operation: 'TradeContext.submitOrder',
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
bun test tests/main/timeWakeupEvaluationProgram/business.test.ts
```

Expected before implementation: evaluation returns a retry result instead of rejecting.

- [ ] **Step 3: Re-throw submitOrder after fact refresh attempt**

In `src/main/timeWakeupEvaluationProgram/index.ts`, update the catch block around doomsday protection:

```ts
if (error.operation === 'TradeContext.submitOrder') {
  try {
    await refreshDoomsdayApiFailureFacts({
      trader,
      lastState,
      quoteSubscriptionRuntime,
    });
  } catch (refreshError) {
    if (!isExternalApiRequestError(refreshError)) {
      throw refreshError;
    }

    logger.warn(
      '[TimeWakeupEvaluation] 末日清仓提交结果未知后的事实刷新失败，停止系统级重复提交',
      refreshError.message,
    );
  }

  throw error;
}
```

Leave the existing `pushApiRetryCandidate` path only for idempotent/non-submit API failures.

- [ ] **Step 4: Run focused test and verify pass**

Run:

```bash
bun test tests/main/timeWakeupEvaluationProgram/business.test.ts
```

Expected: pass.

---

### Task 9: Make orderCacheManager todayOrders item validation fail-fast

**Files:**

- Modify: `src/core/trader/orderCacheManager.ts`
- Test: focused order cache/trader test file

- [ ] **Step 1: Locate focused tests**

Run:

```bash
git grep -n "createOrderCacheManager\|getPendingOrders\|todayOrders" tests/core tests/integration
```

Expected: find an order cache manager or trader test file.

- [ ] **Step 2: Add failing bad item test**

Add a test where `ctx.todayOrders()` returns an array containing one invalid object:

```ts
const ctx = createTradeContextDouble({
  todayOrders: async () => [
    {
      orderId: 'order-1',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      status: OrderStatus.New,
      price: toDecimal(1.23),
      quantity: toDecimal(1000),
      executedQuantity: toDecimal(0),
      orderType: OrderType.ELO,
    },
    {
      orderId: 'broken-order',
      symbol: 'BULL.HK',
      status: OrderStatus.New,
    },
  ],
});

await expect(orderCacheManager.getPendingOrders()).rejects.toThrow(TypeError);
```

Use existing test helpers for `Decimal`, `OrderSide`, `OrderStatus`, and `OrderType`.

- [ ] **Step 3: Run focused test and verify failure**

Run the focused test file.

Expected before implementation: invalid item is filtered out and no error is thrown.

- [ ] **Step 4: Replace filter with assertion**

In `src/core/trader/orderCacheManager.ts`, replace:

```ts
allOrders = todayOrdersRaw.filter(isValidTodayOrder);
```

with:

```ts
for (const order of todayOrdersRaw) {
  if (!isValidTodayOrder(order)) {
    throw new TypeError('[订单缓存] todayOrders 订单数据结构无效，无法解析未成交订单');
  }
}

allOrders = todayOrdersRaw;
```

- [ ] **Step 5: Run focused test and verify pass**

Run the same focused test file.

Expected: pass.

---

### Task 10: Make post-trade unrealized-loss null fatal

**Files:**

- Modify: `src/app/runtime/createPostTradeConsistencyRuntime.ts`
- Test: `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`

- [ ] **Step 1: Add failing null fatal test**

Add a test where business deps include an active seat and `riskChecker.refreshUnrealizedLossData` returns `null`.

Assert:

```ts
runtime.recordSettlementRefreshNeed({
  refreshAccount: true,
  refreshPositions: true,
});
runtime.start();
await expect(runtime.drainFatalError()).rejects.toThrow(TypeError);
expect(runtime.getStatus().started).toBe(false);
```

Also assert the refresh function was called once if a counter is available.

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
bun test tests/app/runtime/createPostTradeConsistencyRuntime.test.ts
```

Expected before implementation: runtime retries rather than entering fatal.

- [ ] **Step 3: Throw TypeError on null**

In `src/app/runtime/createPostTradeConsistencyRuntime.ts`, replace the `refreshResult === null` block with:

```ts
if (refreshResult === null) {
  throw new TypeError(`[PostTradeConsistencyRuntime] 浮亏缓存刷新返回 null: ${symbol}`);
}
```

- [ ] **Step 4: Run focused test and verify pass**

Run:

```bash
bun test tests/app/runtime/createPostTradeConsistencyRuntime.test.ts
```

Expected: pass.

---

### Task 11: Expose delayedSignalVerifier onVerified errors

**Files:**

- Modify: `src/main/asyncProgram/delayedSignalVerifier/types.ts`
- Modify: `src/main/asyncProgram/delayedSignalVerifier/index.ts`
- Test: `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`

- [ ] **Step 1: Add failing callback error test**

Add a test that uses fake timers or the existing verifier test timing helper. Register a callback that throws:

```ts
const errors: unknown[] = [];
const verifier = createDelayedSignalVerifier({
  indicatorCache,
  onFatalError: (error) => {
    errors.push(error);
  },
});
verifier.onVerified(() => {
  throw new Error('queue push failed');
});
```

After the signal verifies successfully, assert:

```ts
expect(errors).toHaveLength(1);
expect(errors[0]).toBeInstanceOf(Error);
expect((errors[0] as Error).message).toContain('queue push failed');
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
bun test tests/main/asyncProgram/delayedSignalVerifier/business.test.ts
```

Expected before implementation: errors remains empty because the error is only logged.

- [ ] **Step 3: Add optional fatal dependency type**

In `src/main/asyncProgram/delayedSignalVerifier/types.ts`, update `DelayedSignalVerifierDeps`:

```ts
export type DelayedSignalVerifierDeps = Readonly<{
  indicatorCache: IndicatorCache;
  onFatalError?: (error: unknown) => void;
}>;
```

Preserve existing fields in that type.

- [ ] **Step 4: Call fatal handler on callback error**

In `src/main/asyncProgram/delayedSignalVerifier/index.ts`, destructure:

```ts
const { indicatorCache, onFatalError } = deps;
```

Replace the callback catch block with:

```ts
        } catch (err) {
          logger.error('[延迟验证] 执行 onVerified 回调时发生错误', err);
          if (onFatalError) {
            onFatalError(err);
            return;
          }

          throw err;
        }
```

This keeps existing callers working while making production wiring able to expose the error.

- [ ] **Step 5: Wire fatal handler if monitor context creation has access**

If the factory creating `DelayedSignalVerifier` already has a fatal handler in scope, pass it:

```ts
createDelayedSignalVerifier({
  indicatorCache,
  onFatalError,
});
```

If no fatal handler exists at that construction boundary, leave the optional dependency unset; the thrown error path still prevents silent swallowing in tests that do not provide the handler.

- [ ] **Step 6: Run focused test and verify pass**

Run:

```bash
bun test tests/main/asyncProgram/delayedSignalVerifier/business.test.ts
```

Expected: pass.

---

### Task 12: Expose route runtime errors

**Files:**

- Modify: `src/main/tradingRiskEventRuntime/types.ts`
- Modify: `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`
- Modify: `src/main/monitorQuoteEventRuntime/types.ts`
- Modify: `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
- Modify: `src/app/runtime/createPostGateRuntime.ts` or async runtime wiring if needed
- Test: focused tests for trading risk runtime and switch wakeup runtime

- [ ] **Step 1: Add failing trading risk route fatal test**

Locate tests:

```bash
git grep -n "createTradingRiskEventRuntime\|TradingRiskEventRuntime" tests src
```

Add a test where `unrealizedLossMonitor.monitorDirectionalUnrealizedLoss` throws `new TypeError('risk route broken')`, and deps include:

```ts
const fatalErrors: unknown[] = [];
const runtime = createTradingRiskEventRuntime({
  ...deps,
  onFatalError: (error) => fatalErrors.push(error),
});
```

After emitting the quote event and waiting for processing, assert:

```ts
expect(fatalErrors).toHaveLength(1);
expect(fatalErrors[0]).toBeInstanceOf(TypeError);
```

- [ ] **Step 2: Add failing switch wakeup route fatal test**

Locate tests:

```bash
git grep -n "createSwitchWakeupRuntime\|SwitchWakeupRuntime" tests src
```

Add a test where `autoSymbolManager.advancePendingSwitch` throws `new TypeError('switch route broken')`, and deps include `onFatalError` collecting errors. Assert one fatal error is captured.

- [ ] **Step 3: Run focused tests and verify failure**

Run the focused runtime tests found in Steps 1 and 2.

Expected before implementation: fatal arrays stay empty because route errors are only logged.

- [ ] **Step 4: Add optional fatal ports to types**

In `src/main/tradingRiskEventRuntime/types.ts`, add:

```ts
  readonly onFatalError?: (error: unknown) => void;
```

to `TradingRiskEventRuntimeDeps`.

In `src/main/monitorQuoteEventRuntime/types.ts`, add the same field to the `SwitchWakeupRuntime` dependency type. If that type is in another file, update the actual `CreateSwitchWakeupRuntimeDeps` declaration there.

- [ ] **Step 5: Use fatal port in tradingRiskEventRuntime**

In `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`, update `launchRouteProcessing` catch:

```ts
const processingPromise = processRouteQueue(routeKey).catch((error: unknown) => {
  logger.error('[TradingRiskEventRuntime] 风险事件处理失败', formatError(error));
  deps.onFatalError?.(error);
});
```

- [ ] **Step 6: Use fatal port in switchWakeupRuntime**

In `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`, update both catch blocks:

```ts
const processingPromise = processRouteQueue(routeKey).catch((error: unknown) => {
  logger.error(
    `[SwitchWakeupRuntime] pending switch 推进失败 source=${source}`,
    formatError(error),
  );
  deps.onFatalError?.(error);
});
```

and:

```ts
const processingPromise = processRouteQueue(routeKey).catch((error: unknown) => {
  logger.error('[SwitchWakeupRuntime] pending switch 重入推进失败', formatError(error));
  deps.onFatalError?.(error);
});
```

- [ ] **Step 7: Wire fatal handler from app runtime**

If the fatal handler is created in `createAsyncRuntime` after post-gate runtime construction, do not re-architect the app. Instead, expose the ports at construction sites where a handler already exists. If no handler exists in `createPostGateRuntime`, leave app wiring unchanged and rely on unit tests for the new optional port. Do not introduce global mutable fatal state.

- [ ] **Step 8: Run focused tests and verify pass**

Run the focused runtime tests.

Expected: route internal errors become observable via `onFatalError`; STOP_AND_DRAIN abort tests remain green.

---

### Task 13: Run formatting, linting, type checking, and targeted tests

**Files:**

- No source changes expected except fixes required by verification output.

- [ ] **Step 1: Run formatter**

Run:

```bash
bun format
```

Expected: completes successfully.

- [ ] **Step 2: Run lint**

Run:

```bash
bun lint
```

Expected: no lint errors.

- [ ] **Step 3: Run type check**

Run:

```bash
bun type-check
```

Expected: no TypeScript errors.

- [ ] **Step 4: Run targeted boundary tests**

Run:

```bash
bun test tests/utils/apiFailure.business.test.ts tests/core/signalProcessor/riskCheckPipeline.business.test.ts tests/main/asyncProgram/monitorTaskProcessor/business.test.ts tests/main/timeWakeupEvaluationProgram/business.test.ts tests/app/runtime/createPostTradeConsistencyRuntime.test.ts tests/main/asyncProgram/delayedSignalVerifier/business.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run additional focused tests discovered during implementation**

Run the exact test files selected in Tasks 4, 5, 6, 9, and 12. The command should include only real file paths discovered during those tasks, for example:

```bash
bun test tests/core/trader/orderMonitor.business.test.ts tests/main/recovery/seatPreparation.business.test.ts tests/main/seatActivationDispatcher/seatActivationDispatcher.business.test.ts tests/main/tradingRiskEventRuntime/business.test.ts tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts
```

Expected: all selected tests pass. If a listed example file does not exist, omit it and use the real focused file discovered by `git grep`.

- [ ] **Step 6: Run current related regression set**

Run:

```bash
bun test tests/utils/apiFailure.business.test.ts tests/core/signalProcessor/riskCheckPipeline.business.test.ts tests/core/riskController/index.business.test.ts tests/main/timeWakeupEvaluationProgram/business.test.ts tests/main/asyncProgram/monitorTaskProcessor/business.test.ts tests/app/runtime/createPostTradeConsistencyRuntime.test.ts tests/app/startup/startupSnapshot.test.ts tests/services/quoteClient/business.test.ts
```

Expected: all tests pass.

---

## Self-review

- Spec coverage: Tasks 1-12 cover all 11 in-scope requirements from `docs/superpowers/specs/2026-05-08-api-retry-boundary-repair-design.md`.
- Placeholder scan: no `TBD`, no `TODO`, no unspecified “add tests” without concrete expected behavior.
- Type consistency: `retryConfig` uses existing `ExternalApiRetryConfig`; no-retry constants use `{ retries: 0, delayMs: 0 } as const`; fatal ports use `(error: unknown) => void` consistently.
- Git safety: commit steps intentionally omitted because the current session instructions forbid committing unless the user explicitly asks.
