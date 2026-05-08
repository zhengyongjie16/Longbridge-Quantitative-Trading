# API Failure Retry Boundary Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue the interrupted refactor so external API failures become explicit retry/fact-unknown signals while non-API contract and invariant errors remain fail-fast.

**Architecture:** The authoritative design is `docs/issues/2026-05/2026-05-06-api-failure-retry-boundary-full-chain-analysis.md`,方案 A. `ExternalApiRequestError` must only represent a real external request failure after bounded attempts; business no-result remains an explicit business result; contract/invariant errors are thrown. Time wakeup produces `API_RETRY` candidates for external API failures, while local owners either schedule existing explicit retry paths or surface fatal errors without inventing empty facts.

**Tech Stack:** Bun, TypeScript strict mode, Longbridge OpenAPI SDK, bun:test, existing factory-function architecture.

---

## File map

- Modify `src/core/trader/orderMonitor/orderOps.ts`: do not convert `ExternalApiRequestError` from cancel/replace into unknown business outcomes.
- Modify `src/core/trader/orderMonitor/orderStatusQuery.ts`: do not convert `orderDetail` `ExternalApiRequestError` into `QUERY_FAILED`; keep `603001` as business not-found.
- Modify `src/types/trader.ts`: remove `API_ERROR` from `OrderStateCheckResult` if no longer produced, or keep only if a non-external query failure remains explicit.
- Modify `src/core/trader/accountService.ts`: treat empty `accountBalance()` result as contract failure; keep empty positions as authoritative empty holdings only after the API succeeds.
- Modify `tests/core/trader/orderMonitor/orderOps.business.test.ts`: assert cancel/replace external API failures propagate.
- Modify `tests/core/trader/orderMonitor/orderStatusQuery.business.test.ts`: assert `orderDetail` external API failures propagate, and `603001` still maps to `QUERY_FAILED/NOT_FOUND`.
- Modify `tests/services/quoteClient/business.test.ts` or `tests/core/trader/accountService` equivalent if present; otherwise extend relevant trader tests to cover empty account contract failure.
- Run verification commands: `bun format`, `bun lint`, `bun type-check`, targeted tests, then `bun test`.

---

## Task 1: Preserve ExternalApiRequestError through order status query

**Files:**

- Modify: `src/core/trader/orderMonitor/orderStatusQuery.ts`
- Modify: `src/types/trader.ts`
- Test: `tests/core/trader/orderMonitor/orderStatusQuery.business.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that construct `createExternalApiRequestError({ operation: 'TradeContext.orderDetail', attempts: 1, cause: new Error('network') })` and make `ctx.orderDetail` reject with it. Assert `checkOrderState(orderId)` rejects with `ExternalApiRequestError`.

Also keep a `603001` business not-found test asserting:

```ts
expect(result).toEqual({
  kind: 'QUERY_FAILED',
  reason: 'NOT_FOUND',
  errorCode: '603001',
  message: expect.any(String),
});
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
bun test tests/core/trader/orderMonitor/orderStatusQuery.business.test.ts
```

Expected before implementation: the external API failure test fails because current code returns `QUERY_FAILED/API_ERROR`.

- [ ] **Step 3: Implement minimal propagation**

In `orderStatusQuery.ts`, import `isExternalApiRequestError` and change the catch block to:

```ts
if (isExternalApiRequestError(error)) {
  throw error;
}

const errorCode = extractErrorCode(error);
return {
  kind: 'QUERY_FAILED',
  reason: 'NOT_FOUND',
  errorCode,
  message: extractErrorMessage(error),
};
```

If `API_ERROR` is no longer produced, update `OrderStateCheckResult` in `src/types/trader.ts` so `reason` is only `'NOT_FOUND'`.

- [ ] **Step 4: Run focused test again**

Run:

```bash
bun test tests/core/trader/orderMonitor/orderStatusQuery.business.test.ts
```

Expected: pass.

---

## Task 2: Preserve ExternalApiRequestError through cancel and replace operations

**Files:**

- Modify: `src/core/trader/orderMonitor/orderOps.ts`
- Test: `tests/core/trader/orderMonitor/orderOps.business.test.ts`

- [ ] **Step 1: Write failing cancel/replace tests**

Add tests where `ctx.cancelOrder` and `ctx.replaceOrder` reject with an `ExternalApiRequestError`. Assert:

```ts
await expect(orderOps.cancelOrder(orderId)).rejects.toMatchObject({
  name: 'ExternalApiRequestError',
  operation: 'TradeContext.cancelOrder',
});

await expect(orderOps.replaceOrderPrice(orderId, 1.23, 1000)).rejects.toMatchObject({
  name: 'ExternalApiRequestError',
  operation: 'TradeContext.replaceOrder',
});
```

- [ ] **Step 2: Run focused failing test**

Run:

```bash
bun test tests/core/trader/orderMonitor/orderOps.business.test.ts
```

Expected before implementation: current code converts the errors into `UNKNOWN_FAILURE` / `FAILED` instead of rejecting.

- [ ] **Step 3: Implement minimal propagation**

In `orderOps.ts`, import `isExternalApiRequestError` and add the first catch-branch in both `cancelOrder` and `replaceOrderPrice`:

```ts
if (isExternalApiRequestError(error)) {
  throw error;
}
```

Keep business errors (`isOrderClosedBusinessError`, `isReplaceTempBlockedError`, `isReplaceUnsupportedByTypeError`) in their existing semantic paths.

- [ ] **Step 4: Run focused test again**

Run:

```bash
bun test tests/core/trader/orderMonitor/orderOps.business.test.ts
```

Expected: pass.

---

## Task 3: Make empty account a contract failure, not an unavailable snapshot

**Files:**

- Modify: `src/core/trader/accountService.ts`
- Test: locate the existing account service/trader business test with `grep "accountBalance" tests -n`; modify the most focused test file.

- [ ] **Step 1: Write failing test**

Create or update a test where `ctx.accountBalance()` resolves to `[]`. Assert:

```ts
await expect(accountService.getAccountSnapshot()).rejects.toThrow(TypeError);
```

Also keep or add a test where `ctx.stockPositions()` resolves with `channels: []` and assert `getStockPositions()` returns `[]`, because an API-successful empty holding list is a valid authoritative empty fact.

- [ ] **Step 2: Run focused failing test**

Run the exact test file found in Step 1, for example:

```bash
bun test tests/core/trader/accountService.business.test.ts
```

Expected before implementation: empty account currently returns `null`.

- [ ] **Step 3: Implement minimal contract failure**

In `accountService.ts`, replace the empty-primary branch with:

```ts
if (!primary) {
  throw new TypeError('TradeContext.accountBalance returned no primary account');
}
```

Do not wrap this error in `ExternalApiRequestError`; parsing/contract validation must stay outside the API wrapper.

- [ ] **Step 4: Run focused test again**

Run the same focused test. Expected: pass.

---

## Task 4: Verify submitOrder non-idempotent failure semantics

**Files:**

- Read-only unless tests prove a mismatch: `src/core/trader/orderExecutor/submitFlow.ts`
- Test: existing submit/order executor tests or integration tests covering buy/sell failure paths.

- [ ] **Step 1: Add or confirm test coverage**

Verify there is a test where `ctx.submitOrder` fails with `ExternalApiRequestError` and `submitTargetOrder` rejects rather than returning `null` or retrying.

The expected assertion is:

```ts
await expect(
  submitTargetOrder(ctx, signal, targetSymbol, false, monitorConfig),
).rejects.toMatchObject({
  name: 'ExternalApiRequestError',
  operation: 'TradeContext.submitOrder',
});
```

- [ ] **Step 2: Run focused submit tests**

Run the most focused existing test file. If no focused file exists, run:

```bash
bun test tests/integration/buy-flow.integration.test.ts
```

Expected: pass after any missing assertion is added.

- [ ] **Step 3: Keep implementation if already correct**

Current `submitFlow.ts` already uses `retryConfig: { retries: 0, delayMs: 0 }` and rethrows `ExternalApiRequestError`. Do not change it unless the test reveals a mismatch.

---

## Task 5: Close full-chain boundary test gaps

**Files:**

- Modify as needed: `tests/main/lifecycle/dayLifecycleManager.test.ts`
- Modify as needed: `tests/integration/doomsday.integration.test.ts`
- Modify as needed: `tests/main/autoSearchWakeupRuntime/autoSearchWakeupRuntime.business.test.ts`
- Modify as needed: `tests/app/runtime/createAsyncRuntime.wiring.test.ts`
- Modify as needed: `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`
- Run existing tests:
  - `tests/main/timeWakeupEvaluationProgram/business.test.ts`
  - `tests/app/startup/startupSnapshot.test.ts`

- [ ] **Step 1: Add lifecycle non-API fail-fast assertion**

In `tests/main/lifecycle/dayLifecycleManager.test.ts`, ensure a non-`ExternalApiRequestError` thrown by open rebuild domains is asserted to reject directly, not enter `OPEN_REBUILD_FAILED` retry state.

Expected assertion shape:

```ts
await expect(manager.tick(openTime)).rejects.toThrow(TypeError);
```

- [ ] **Step 2: Add doomsday API failure assertions**

In `tests/integration/doomsday.integration.test.ts`, cover these external API failure boundaries:

```ts
await expect(evaluateOrExecuteDoomsdayAction()).resolves.toMatchObject({
  nextRetryAtMs: expect.any(Number),
});
```

The assertions must prove API failures from pending-order query, quote query, or clearance signal execution do not produce empty facts and do not mark the buy-cutoff check as completed.

- [ ] **Step 3: Add auto-search no-count/no-freeze assertion**

In `tests/main/autoSearchWakeupRuntime/autoSearchWakeupRuntime.business.test.ts`, make the warrant search path throw `ExternalApiRequestError` and assert the route schedules API retry while `searchFailCountToday` and frozen state remain unchanged.

- [ ] **Step 4: Add async runtime API failure routing assertion**

In `tests/app/runtime/createAsyncRuntime.wiring.test.ts` or `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`, make a processor task throw `ExternalApiRequestError` and assert it follows the explicit task retry/failure path without triggering `asyncRuntime.drainFatalError()`.

- [ ] **Step 5: Run targeted boundary suite**

Run:

```bash
bun test tests/main/timeWakeupEvaluationProgram/business.test.ts tests/app/startup/startupSnapshot.test.ts tests/main/lifecycle/dayLifecycleManager.test.ts tests/integration/doomsday.integration.test.ts tests/main/autoSearchWakeupRuntime/autoSearchWakeupRuntime.business.test.ts tests/app/runtime/createAsyncRuntime.wiring.test.ts tests/main/asyncProgram/monitorTaskProcessor/business.test.ts
```

Expected: pass. If a test fails because API failure is still fatal, becomes empty fact, increments business failure count, freezes a seat, or completes a doomsday check without authority, fix the failing owner according to方案 A.

---

## Task 6: Required project verification

**Files:**

- All changed TypeScript files.

- [ ] **Step 1: Format**

Run:

```bash
bun format
```

Expected: exit code 0.

- [ ] **Step 2: Lint**

Run:

```bash
bun lint
```

Expected: exit code 0.

- [ ] **Step 3: Type-check**

Run:

```bash
bun type-check
```

Expected: exit code 0.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
bun test tests/core/trader/orderMonitor/orderStatusQuery.business.test.ts tests/core/trader/orderMonitor/orderOps.business.test.ts tests/main/timeWakeupEvaluationProgram/business.test.ts tests/app/startup/startupSnapshot.test.ts tests/main/lifecycle/dayLifecycleManager.test.ts tests/integration/doomsday.integration.test.ts tests/main/autoSearchWakeupRuntime/autoSearchWakeupRuntime.business.test.ts tests/app/runtime/createAsyncRuntime.wiring.test.ts tests/main/asyncProgram/monitorTaskProcessor/business.test.ts
```

Expected: exit code 0.

- [ ] **Step 5: Run full suite**

Run:

```bash
bun test
```

Expected: exit code 0.

---

## Self-review

- Spec coverage: covers plan-auditor risks plus the existing方案 A boundary tests for time wakeup, lifecycle, doomsday, auto search, async fatal, startup snapshot, and submitOrder.
- Placeholder scan: no TBD/TODO/fill-later steps remain.
- Type consistency: `ExternalApiRequestError`, `OrderStateCheckResult`, `CancelOrderOutcome`, and `ReplaceOrderOutcome` names match current source files.
- Conflict resolution: old time-wakeup复盘中的“API retry 耗尽后 fatal” is not used as authority for this continuation; current issue document and user-approved方案 A are authoritative.
