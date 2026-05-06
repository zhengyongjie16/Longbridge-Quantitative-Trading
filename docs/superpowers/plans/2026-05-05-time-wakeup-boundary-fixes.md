# Time Wakeup Boundary Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove fixed system-level recovery loops, make invalid time plans fail visibly, bound long one-shot timers, and preserve event-driven trading semantics.

**Architecture:** System-level time wakeup remains a one-shot owner driven only by explicit business candidates. API failures retry only inside the API client boundary; after retries are exhausted, the error propagates to the app fatal path. Long future timers use platform-safe one-shot segmentation without business polling.

**Tech Stack:** Bun, TypeScript, existing bun:test suite, existing factory-function architecture.

---

## File map

- Modify `src/main/timeWakeupRuntime/types.ts`: remove `recoveryRetryDelayMs`; add fatal-error visibility through `drainFatalError()`.
- Modify `src/main/timeWakeupRuntime/index.ts`: remove generic retry; surface evaluation and invalid-plan errors through fatal state.
- Modify `src/app/runApp.ts`: race shutdown signal with `timeWakeupRuntime.drainFatalError()`, cleanup on fatal, then rethrow.
- Modify `src/main/timeWakeupEvaluationProgram/index.ts`: remove trading-day query catch and `RECOVERY_RETRY` candidate.
- Modify `src/main/timeWakeupPlanner/types.ts`: remove `RECOVERY_RETRY` source.
- Create `src/utils/timer/index.ts` and `src/utils/timer/types.ts`: bounded one-shot scheduling helper.
- Modify `src/core/trader/orderMonitor/routeRuntime.ts`: use bounded one-shot helper for route timers.
- Modify `src/main/periodicSwitchWakeupRuntime/index.ts`: use bounded one-shot helper for due timers.
- Modify `src/main/autoSearchWakeupRuntime/index.ts`: use bounded one-shot helper and neutral direction constant.
- Modify `src/services/autoSymbolManager/*` and monitor task comments/types: replace tick/interval comments and function names with due semantics where safe.
- Modify tests under `tests/main/timeWakeupRuntime`, `tests/main/timeWakeupEvaluationProgram`, `tests/core/trader/orderMonitor`, `tests/main/periodicSwitchWakeupRuntime`, and `tests/main/autoSearchWakeupRuntime`.

---

## Tasks

### Task 1: Remove system-level fixed recovery retry

- [ ] Update `TimeWakeupRuntimeDeps` by removing `recoveryRetryDelayMs` and adding `drainFatalError(): Promise<never>` to runtime interface.
- [ ] Change `createTimeWakeupRuntime` so `deps.evaluate()` errors are stored as fatal and no timer is scheduled.
- [ ] Change invalid non-finite `nextWakeupAtMs` to fatal instead of `running=false` silent stop.
- [ ] Update `runApp` to wait for either shutdown or fatal; on fatal, execute cleanup then rethrow.
- [ ] Update tests to assert evaluation errors and invalid `nextWakeupAtMs` become fatal and no retry timer is scheduled.

### Task 2: Move trading-day failure out of system-level retry

- [ ] Remove `RECOVERY_RETRY` from `TimeWakeupCandidateSource`.
- [ ] Remove try/catch around `marketDataClient.isTradingDay` in `timeWakeupEvaluationProgram`.
- [ ] Update tests: trading-day API failure should reject from evaluation after API client retries are exhausted.
- [ ] Keep API retry in `quoteClient.withRetry`; do not add new retry in time wakeup.

### Task 3: Add bounded one-shot timer helper

- [ ] Create `src/utils/timer/types.ts` with timer scheduling params and result types.
- [ ] Create `src/utils/timer/index.ts` with `scheduleBoundedOneShotAt()` that validates finite future `atMs`, schedules at most `TIME.MAX_TIMER_DELAY_MS`, rechecks current time on segment callback, and calls `onDue` only when due.
- [ ] Add focused tests for invalid time, due-now, segmented future time, and cancel behavior.

### Task 4: Apply bounded timer helper to local owners

- [ ] Use helper in `orderMonitor/routeRuntime.ts` and verify `TimeoutOverflowWarning` disappears.
- [ ] Use helper in `periodicSwitchWakeupRuntime/index.ts` while preserving baseline guard.
- [ ] Use helper in `autoSearchWakeupRuntime/index.ts`; replace repeated `['LONG', 'SHORT'] as const` with a typed direction constant.
- [ ] Add or update tests for long future timers in each owner.

### Task 5: Synchronize due semantics and comments

- [ ] Rename safe internal/public auto-symbol manager function path from `maybeSwitchOnInterval` to due semantics if test impact is controlled.
- [ ] Update comments mentioning periodic tick/interval to due-event wording.
- [ ] Update auto-search comments using “开盘保护” to “自动寻标开盘延迟”.
- [ ] Keep task type renaming only if it remains a single coherent change; otherwise update comments now and leave task enum for a later explicit rename.

### Task 6: Add high-value integration tests

- [ ] Add system-level one-shot timer + evaluation integration test: pre-open candidate schedules open timer; firing timer updates canTrade and emits gate event.
- [ ] Add doomsday action tests in `timeWakeupEvaluationProgram`: buy cutoff calls cancel; clearance window calls executeClearance and plans retry when returned.
- [ ] Add periodic switch real-wiring test using real `calculateTradingDurationDueAtMs` and calendar snapshot.

### Task 7: Verify and review

- [ ] Run `bun format`.
- [ ] Run `bun lint`.
- [ ] Run `bun type-check`.
- [ ] Run targeted tests for time wakeup, timer helper, order monitor route runtime, periodic switch, auto search.
- [ ] Run `bun test`.
- [ ] Use code review/simplification agents if code changed significantly.
