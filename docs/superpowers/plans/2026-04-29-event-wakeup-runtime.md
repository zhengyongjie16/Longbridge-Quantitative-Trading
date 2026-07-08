# Event Wakeup Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. When editing TypeScript, also use the repository-required `typescript-project-specifications` skill. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前每秒主时间循环重构为 one-shot 事件唤醒运行时，保持交易日门禁、开盘保护、生命周期、末日保护与周期换标业务语义不变。

**Architecture:** 新增统一 `TimeWakeupRuntime` 作为系统级时间事件 owner；`timeWakeupEvaluationProgram` 从每秒驱动程序演进为单次时间评估器，执行当前业务顺序后返回下一唤醒计划。周期换标到期由交易时段累计时长反推，但不进入 `timeWakeupPlanner`，而由独立 `PeriodicSwitchWakeupRuntime` 管理到期与事件重投递；等待空仓只由订单状态事件与 post-trade consistency freshness 事件重新投递，不引入扫描或兼容双路径。

**Tech Stack:** TypeScript strict mode、Bun test runner、现有工厂函数与依赖注入模式、Longbridge SDK 4.0.5。

---

## File Structure

- Create: `src/main/timeWakeupPlanner/types.ts`
  - 定义系统级时间计划、候选原因、生命周期 retry 输入、已解析开盘重建唤醒点、末日保护状态输入与输出类型。
- Create: `src/main/timeWakeupPlanner/index.ts`
  - 纯函数汇总全局交易边界、开盘保护边界、生命周期 retry、末日保护边界和恢复性 retry，返回最早 `nextWakeupAtMs`。
- Test: `tests/main/timeWakeupPlanner/business.test.ts`
  - 覆盖非交易日、正常日、半日市、开盘保护、末日保护、lifecycle retry；周期换标候选不属于该 planner 输入。
- Modify: `src/main/lifecycle/types.ts`
  - `DayLifecycleManager.tick(...)` 返回 `DayLifecycleTickResult`，暴露 `nextRetryAtMs` 与 `pendingOpenRebuild`；`timeWakeupEvaluationProgram` 将 pending 状态解析为下一可交易日首个连续交易开盘点后再传给 planner。
- Modify: `src/main/lifecycle/dayLifecycleManager.ts`
  - 保留现有状态机顺序，失败或等待 retry 时返回下一次 retry 时间。
- Test: `tests/main/lifecycle/dayLifecycleManager.test.ts`
  - 补充 midnight/open rebuild retry 返回值与 `pendingOpenRebuild=false` 收敛测试。
- Create: `src/main/periodicSwitchWakeupRuntime/types.ts`
  - 定义周期换标唤醒 runtime、到期计划依赖、事件订阅依赖和 waiting-empty 路线状态。
- Create: `src/main/periodicSwitchWakeupRuntime/index.ts`
  - 唯一负责周期换标到期 timer、seat truth 后的计划重算、gate-open 后对非 waiting-empty 路线重算，以及 order/freshness 事件到达后对等待空仓路线重新投递 `AUTO_SYMBOL_TICK`；作为普通业务任务投递 owner，跟随 lifecycle signalRuntimeDomain 启停，不在启动重建失败静止期运行。
- Test: `tests/main/periodicSwitchWakeupRuntime/business.test.ts`
  - 覆盖到期任务调度、seat event 只重算计划、gate-open 只重算非 waiting-empty 路线、order/freshness 事件才推进 waiting empty，以及席位重新进入 ACTIVE 后周期计时基线重置。
- Modify: `src/types/monitorContextPorts.ts`
  - 增加 `AutoSymbolManagerPort.getPeriodicSwitchPendingState(direction)` 只读查询，避免把 periodic pending 误交给 `switchWakeupRuntime`，也不改写 `SwitchDriveResult` 的真实 pending switch 语义。
- Modify: `src/main/asyncProgram/monitorTaskProcessor/types.ts`
  - 增加 `PeriodicSwitchWakeupRuntime` 任务结果回写依赖，并更新 `AUTO_SYMBOL_TICK` 注释来源。
- Modify: `src/main/asyncProgram/monitorTaskProcessor/index.ts`
  - 将 `PeriodicSwitchWakeupRuntime` 传入 `createAutoSymbolHandlers(...)`。
- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`
  - 在 `maybeSwitchOnInterval(...)` 后回写周期 tick 结果：waiting-empty、gate-closed、baseline stale 或需要重新计划。
- Modify: `src/app/runtime/createAsyncRuntime.ts`
  - 接收并向 `MonitorTaskProcessor` 注入 `PeriodicSwitchWakeupRuntime`。
- Modify: `src/main/lifecycle/cacheDomains/types.ts`
  - `SignalRuntimeDomainDeps` 注入 `PeriodicSwitchWakeupRuntime` 的 `start` 与 `stopAndDrain` 能力，使周期换标任务投递源跟随普通业务 runtime lifecycle。
- Modify: `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
  - 午夜清理时停止并清空 `PeriodicSwitchWakeupRuntime` 路线状态；开盘重建成功后随普通 runtime 启动，避免重建失败静止期投递 `AUTO_SYMBOL_TICK`。
- Modify: `src/utils/time/types.ts`
  - 增加交易时段累计到期反推工具的入参/结果类型。
- Modify: `src/utils/time/index.ts`
  - 增加 `calculateTradingDurationDueAtMs(...)`，与 `calculateTradingDurationMsBetween(...)` 使用同一 session range 规则。
- Test: `tests/utils/time.business.test.ts`
  - 覆盖午休不累计、跨日累计、半日市只累计上午、日历缺失返回 null。
- Modify: `src/core/doomsdayProtection/types.ts`
  - `DoomsdayClearanceResult` 增加 `nextRetryAtMs: number | null`。
- Modify: `src/core/doomsdayProtection/index.ts`
  - 清仓行情缺失时不再自行持有内部 retry timer，返回下一推进时间由 `TimeWakeupRuntime` 统一调度。
- Test: existing doomsday tests under `tests/core/doomsdayProtection/**`
  - 优先扩展现有 doomsday 测试文件；仅当不存在可复用 harness 时才新增 `tests/core/doomsdayProtection/business.test.ts`。覆盖清仓 quote 缺失返回 retryAt，窗口内下一次唤醒可继续执行。
- Modify: `src/types/state.ts`
  - 将 `LastState.cachedTradingDayInfo` 从无日期 `TradingDayInfo | null` 改为带 `dateKey` 的缓存结构，确保 one-shot 评估只能命中当前港股日缓存。
- Modify: `src/main/timeWakeupEvaluationProgram/types.ts`
  - `timeWakeupEvaluationProgram` 返回 `TimeWakeupEvaluationResult`，注入系统级 planner 依赖。
- Modify: `src/main/timeWakeupEvaluationProgram/index.ts`
  - 保留当前执行顺序；移除 `processMonitor` 每轮调用；按当前港股日校验交易日信息缓存；返回系统级下一次唤醒计划。
- Test: `tests/main/timeWakeupEvaluationProgram/business.test.ts`
  - 覆盖 gate event 顺序、12:00 延迟验证取消、开盘保护只更新保护状态、末日保护状态去重。
- Create: `src/main/timeWakeupRuntime/types.ts`
  - 定义 `TimeWakeupRuntime`、依赖、timer 类型、状态快照。
- Create: `src/main/timeWakeupRuntime/index.ts`
  - one-shot timer owner：start 立即评估、dirty 重入、stopAndDrain 清 timer 并等待在途评估、异常后安排恢复性 retry。
- Test: `tests/main/timeWakeupRuntime/business.test.ts`
  - 覆盖 start、单 timer、dirty、stopAndDrain、异常 retry。
- Modify: `src/app/types.ts`
  - `RunAppDeps` 移除 `sleep` 和直接 `timeWakeupEvaluationProgram` loop 依赖，增加 `createTimeWakeupRuntime`、`createPeriodicSwitchWakeupRuntime` 与 `waitForShutdownSignal` 依赖；`CleanupContext` 增加两个 runtime；`CleanupController` 删除 `registerExitHandlers`，只保留 `execute()`。
- Modify: `src/app/runApp.ts`
  - 装配 `PeriodicSwitchWakeupRuntime` 与 `TimeWakeupRuntime`；初始重建成功时先随普通业务 runtime 启动并订阅 `PeriodicSwitchWakeupRuntime`，再启动 `TimeWakeupRuntime`，避免首个 gate-open 丢失；初始重建失败或 pending 时只启动 `TimeWakeupRuntime`；删除 `for (;;)` 与 `TRADING.INTERVAL_MS` sleep。
- Modify: `src/app/shutdown/createCleanup.ts`
  - cleanup 中停止 `TimeWakeupRuntime` 与 `PeriodicSwitchWakeupRuntime`；移除信号注册和 `process.exit` owner 职责，避免与 `runApp` 的显式 shutdown 等待形成双 owner。
- Modify: `src/main/processMonitor/index.ts`
  - 删除或收缩为无调用方后移除固定循环入口。
- Modify: `src/main/processMonitor/autoSymbolTasks.ts`
  - 若 `PeriodicSwitchWakeupRuntime` 复用其调度逻辑，则改名为中性工具；否则删除无调用方。
- Modify tests for app wiring if present under `tests/app/**`
  - 覆盖 `runApp` 不再调用 `sleep` 或重复 `timeWakeupEvaluationProgram`。

---

## 0. Non-Goals

本计划不做以下事项：

1. 不引入统一 EventBus。
2. 不重写普通 K 线信号链路。
3. 不把自动寻标改回时间扫描。
4. 不改变距离换标、风险监控、订单追踪、成交刷新现有事件源。
5. 不保留新旧双路径兼容逻辑。
6. 不增加会改变交易语义的兜底轮询或降级路径。
7. 不让开盘保护关闭 `canTrade` 或阻断自动寻标、距离换标、周期换标、风险任务。

---

## 1. Current Chain to Preserve

当前主循环链路：

```text
runApp
  -> for (;;)
  -> timeDriverProgram()
  -> marketDataClient.isTradingDay(...)
  -> lastState.canTrade / openProtectionActive
  -> dayLifecycleManager.tick(...)
  -> tradingGateEventRuntime.emitGateStateChanged(...)
  -> doomsdayProtection.cancelPendingBuyOrders(...)
  -> doomsdayProtection.executeClearance(...)
  -> processMonitor(...)
  -> scheduleAutoSymbolTasks(...)
  -> monitorTaskQueue.scheduleLatest(AUTO_SYMBOL_TICK)
  -> MonitorTaskProcessor
  -> autoSymbolManager.maybeSwitchOnInterval(...)
```

重构后链路：

```text
runApp
  -> createPeriodicSwitchWakeupRuntime(...)
  -> createTimeWakeupRuntime(...)
  -> initial/open rebuild starts PeriodicSwitchWakeupRuntime with ordinary runtimes before TimeWakeupRuntime.start()
  -> TimeWakeupRuntime.start()
  -> TimeWakeupRuntime.evaluateOnce()
  -> timeWakeupEvaluationProgram()
  -> dayLifecycleManager.tick(...)
  -> tradingGateEventRuntime.emitGateStateChanged(...)
  -> doomsdayProtection
  -> timeWakeupPlanner(...)

PeriodicSwitchWakeupRuntime
  -> calculate periodic switch due time
  -> monitorTaskQueue.scheduleLatest(AUTO_SYMBOL_TICK)
  -> MonitorTaskProcessor handles task and reports periodic outcome
  -> gate-open events replan non-waiting routes
  -> order/freshness events re-dispatch waiting-empty route
  -> one-shot timer for nextWakeupAtMs
```

需要保持的顺序约束：

1. 连续交易门禁先更新 `lastState.canTrade`，但 gate event 必须等 lifecycle 单次评估后发布。
2. `pendingOpenRebuild=false` 时 lifecycle 仍要收敛到 `ACTIVE` 与 `isTradingEnabled=true`。
3. 买入截止撤单按港股日 one-shot，清仓接管不是 one-shot。
4. 周期换标等待空仓不靠 seat truth 推进，只由订单状态事件与 freshness 重新投递同一 dedupeKey。
5. 周期换标计时基线是席位进入 `ACTIVE` 时写入的 `lastSeatActivatedAt`；距离换标或周期换标导致席位重新进入 `ACTIVE` 后，旧周期 timer 与 waiting-empty 路线必须失效，并按新的 `lastSeatActivatedAt` 重新计时。

当前代码中真实存在的前置差异：

- `DayLifecycleManager.tick(...)` 仍返回 `Promise<void>`，尚未向时间评估器暴露 retry 与 pending open rebuild 状态。
- `DoomsdayProtection.executeClearance(...)` 仍自持 quote retry timer，尚未把下一次 retry 时间返回给时间唤醒 owner。
- `LastState.cachedTradingDayInfo` 仍是裸 `TradingDayInfo`，尚不能证明缓存属于当前港股日。
- `AutoSymbolManagerPort` 尚未暴露 periodic pending 状态，`MonitorTaskProcessor` 也尚未把 `AUTO_SYMBOL_TICK` 结果回写给周期换标 owner。
- `createCleanup` 仍注册退出信号并调用 `process.exit`，`runApp` 尚不是唯一 shutdown owner。

这些差异是真实接口缺口，必须作为前置改造显式完成；不能通过兼容别名、双路径或额外兜底 timer 绕过。

---

## 2. Task: Add Time Wakeup Planner Types and Pure Planner

**Files:**

- Create: `src/main/timeWakeupPlanner/types.ts`
- Create: `src/main/timeWakeupPlanner/index.ts`
- Test: `tests/main/timeWakeupPlanner/business.test.ts`

- [ ] **Step 1: Write failing planner tests**

Create `tests/main/timeWakeupPlanner/business.test.ts` with these tests:

```ts
import { describe, expect, test } from 'bun:test';
import { TIME } from '../../../src/constants/index.js';
import { planNextTimeWakeup } from '../../../src/main/timeWakeupPlanner/index.js';

function utcMs(hkDay: string, hour: number, minute: number): number {
  return (
    Date.parse(`${hkDay}T00:00:00.000+08:00`) + (hour * 60 + minute) * TIME.MILLISECONDS_PER_MINUTE
  );
}

describe('planNextTimeWakeup', () => {
  test('交易日前 09:29 的下一唤醒为 09:30', () => {
    const nowMs = utcMs('2026-04-29', 9, 29);
    const result = planNextTimeWakeup({
      nowMs,
      dayKey: '2026-04-29',
      isTradingDay: true,
      isHalfDay: false,
      openProtection: {
        morning: { enabled: false, minutes: null },
        afternoon: { enabled: false, minutes: null },
      },
      lifecycle: { nextRetryAtMs: null, pendingOpenRebuildAtMs: null },
      doomsday: { enabled: false, clearanceRetryAtMs: null },
      recoveryRetryAtMs: null,
    });

    expect(result.nextWakeupAtMs).toBe(utcMs('2026-04-29', 9, 30));
    expect(result.candidates.map((candidate) => candidate.reason)).toContain('SESSION_BOUNDARY');
  });

  test('正常交易日 12:00 后下一全局边界为 13:00', () => {
    const nowMs = utcMs('2026-04-29', 12, 0);
    const result = planNextTimeWakeup({
      nowMs,
      dayKey: '2026-04-29',
      isTradingDay: true,
      isHalfDay: false,
      openProtection: {
        morning: { enabled: false, minutes: null },
        afternoon: { enabled: false, minutes: null },
      },
      lifecycle: { nextRetryAtMs: null, pendingOpenRebuildAtMs: null },
      doomsday: { enabled: false, clearanceRetryAtMs: null },
      recoveryRetryAtMs: null,
    });

    expect(result.nextWakeupAtMs).toBe(utcMs('2026-04-29', 13, 0));
  });

  test('半日市 11:59 后下一边界为 12:00 且无 13:00', () => {
    const nowMs = utcMs('2026-04-29', 11, 59);
    const result = planNextTimeWakeup({
      nowMs,
      dayKey: '2026-04-29',
      isTradingDay: true,
      isHalfDay: true,
      openProtection: {
        morning: { enabled: false, minutes: null },
        afternoon: { enabled: true, minutes: 5 },
      },
      lifecycle: { nextRetryAtMs: null, pendingOpenRebuildAtMs: null },
      doomsday: { enabled: false, clearanceRetryAtMs: null },
      recoveryRetryAtMs: null,
    });

    expect(result.nextWakeupAtMs).toBe(utcMs('2026-04-29', 12, 0));
    expect(
      result.candidates.some((candidate) => candidate.atMs === utcMs('2026-04-29', 13, 0)),
    ).toBe(false);
  });

  test('开盘保护结束时间成为最近候选', () => {
    const nowMs = utcMs('2026-04-29', 9, 31);
    const result = planNextTimeWakeup({
      nowMs,
      dayKey: '2026-04-29',
      isTradingDay: true,
      isHalfDay: false,
      openProtection: {
        morning: { enabled: true, minutes: 5 },
        afternoon: { enabled: true, minutes: 3 },
      },
      lifecycle: { nextRetryAtMs: null, pendingOpenRebuildAtMs: null },
      doomsday: { enabled: false, clearanceRetryAtMs: null },
      recoveryRetryAtMs: null,
    });

    expect(result.nextWakeupAtMs).toBe(utcMs('2026-04-29', 9, 35));
    expect(result.candidates.map((candidate) => candidate.reason)).toContain('OPEN_PROTECTION_END');
  });

  test('正常日末日保护候选为 15:45、15:55、16:00', () => {
    const nowMs = utcMs('2026-04-29', 15, 40);
    const result = planNextTimeWakeup({
      nowMs,
      dayKey: '2026-04-29',
      isTradingDay: true,
      isHalfDay: false,
      openProtection: {
        morning: { enabled: false, minutes: null },
        afternoon: { enabled: false, minutes: null },
      },
      lifecycle: { nextRetryAtMs: null, pendingOpenRebuildAtMs: null },
      doomsday: { enabled: true, clearanceRetryAtMs: null },
      recoveryRetryAtMs: null,
    });

    const doomsdayCandidates = result.candidates.filter(
      (candidate) => candidate.reason === 'DOOMSDAY_BOUNDARY',
    );
    expect(doomsdayCandidates.map((candidate) => candidate.atMs)).toEqual([
      utcMs('2026-04-29', 15, 45),
      utcMs('2026-04-29', 15, 55),
      utcMs('2026-04-29', 16, 0),
    ]);
    expect(result.nextWakeupAtMs).toBe(utcMs('2026-04-29', 15, 45));
  });

  test('lifecycle retry 与 recovery retry 参与最小值比较', () => {
    const nowMs = utcMs('2026-04-29', 10, 0);
    const result = planNextTimeWakeup({
      nowMs,
      dayKey: '2026-04-29',
      isTradingDay: true,
      isHalfDay: false,
      openProtection: {
        morning: { enabled: false, minutes: null },
        afternoon: { enabled: false, minutes: null },
      },
      lifecycle: {
        nextRetryAtMs: nowMs + 60_000,
        pendingOpenRebuildAtMs: utcMs('2026-04-30', 9, 30),
      },
      doomsday: { enabled: false, clearanceRetryAtMs: null },
      recoveryRetryAtMs: nowMs + 30_000,
    });

    expect(result.nextWakeupAtMs).toBe(nowMs + 30_000);
    expect(result.candidates.map((candidate) => candidate.reason)).toContain('RECOVERY_RETRY');
    expect(result.candidates.map((candidate) => candidate.reason)).toContain('LIFECYCLE_RETRY');
  });

  test('系统级 planner 只汇总系统级时间候选', () => {
    const nowMs = utcMs('2026-04-29', 10, 0);
    const result = planNextTimeWakeup({
      nowMs,
      dayKey: '2026-04-29',
      isTradingDay: true,
      isHalfDay: false,
      openProtection: {
        morning: { enabled: false, minutes: null },
        afternoon: { enabled: false, minutes: null },
      },
      lifecycle: { nextRetryAtMs: null, pendingOpenRebuildAtMs: null },
      doomsday: { enabled: false, clearanceRetryAtMs: null },
      recoveryRetryAtMs: null,
    });

    expect(result.candidates.every((candidate) => candidate.reason !== 'RECOVERY_RETRY')).toBe(
      true,
    );
    expect(result.nextWakeupAtMs).toBe(utcMs('2026-04-29', 12, 0));
  });
});
```

- [ ] **Step 2: Run planner tests to verify failure**

Run:

```bash
bun test tests/main/timeWakeupPlanner/business.test.ts
```

Expected: FAIL because `src/main/timeWakeupPlanner/index.ts` and `types.ts` do not exist.

- [ ] **Step 3: Add planner types**

Create `src/main/timeWakeupPlanner/types.ts`:

```ts
import type { MultiMonitorTradingConfig } from '../../types/config.js';

/** 标记下一次 one-shot timer 的来源。 */
export type TimeWakeupCandidateReason =
  | 'HK_DAY_BOUNDARY'
  | 'SESSION_BOUNDARY'
  | 'OPEN_PROTECTION_END'
  | 'LIFECYCLE_RETRY'
  | 'PENDING_OPEN_REBUILD'
  | 'DOOMSDAY_BOUNDARY'
  | 'DOOMSDAY_CLEARANCE_RETRY'
  | 'RECOVERY_RETRY';

/** 某个业务边界希望 runtime 在指定时间重新评估。 */
export type TimeWakeupCandidate = Readonly<{
  atMs: number;
  reason: TimeWakeupCandidateReason;
  detail: string;
}>;

/** 生命周期对时间 planner 暴露的已解析唤醒时间。 */
export type TimeWakeupLifecyclePlan = Readonly<{
  nextRetryAtMs: number | null;
  pendingOpenRebuildAtMs: number | null;
}>;

/** 末日保护对时间 planner 暴露的边界与继续推进时间。 */
export type TimeWakeupDoomsdayPlan = Readonly<{
  enabled: boolean;
  clearanceRetryAtMs: number | null;
}>;

/** 单次时间评估结束后所有可计划的时间边界。 */
export type TimeWakeupPlannerInput = Readonly<{
  nowMs: number;
  dayKey: string | null;
  isTradingDay: boolean | null;
  isHalfDay: boolean;
  openProtection: MultiMonitorTradingConfig['global']['openProtection'];
  lifecycle: TimeWakeupLifecyclePlan;
  doomsday: TimeWakeupDoomsdayPlan;
  recoveryRetryAtMs: number | null;
}>;

/** runtime 本轮评估后的 one-shot timer 计划。 */
export type TimeWakeupPlan =
  | Readonly<{
      hasWork: true;
      nextWakeupAtMs: number;
      candidates: ReadonlyArray<TimeWakeupCandidate>;
    }>
  | Readonly<{
      hasWork: false;
      nextWakeupAtMs: null;
      candidates: readonly [];
    }>;
```

- [ ] **Step 4: Add planner implementation**

Create `src/main/timeWakeupPlanner/index.ts`:

```ts
/**
 * timeWakeupPlanner 模块
 *
 * 职责：
 * - 纯函数汇总交易时段、开盘保护、生命周期、末日保护与恢复性 retry 候选
 * - 返回大于当前时间的最早 one-shot 唤醒时间
 * - 不读取或修改任何交易状态
 */
import { TIME } from '../../constants/index.js';
import { resolveHKDayStartUtcMs } from '../../utils/time/index.js';
import type {
  TimeWakeupCandidate,
  TimeWakeupCandidateReason,
  TimeWakeupPlan,
  TimeWakeupPlannerInput,
} from './types.js';

function addCandidate(
  candidates: TimeWakeupCandidate[],
  nowMs: number,
  atMs: number | null,
  reason: TimeWakeupCandidateReason,
  detail: string,
): void {
  if (atMs === null || !Number.isFinite(atMs) || atMs <= nowMs) {
    return;
  }

  candidates.push({ atMs, reason, detail });
}

function addSessionBoundaryCandidates(params: {
  readonly candidates: TimeWakeupCandidate[];
  readonly nowMs: number;
  readonly dayKey: string | null;
  readonly isTradingDay: boolean | null;
  readonly isHalfDay: boolean;
}): void {
  const { candidates, nowMs, dayKey, isTradingDay, isHalfDay } = params;
  if (dayKey === null) {
    return;
  }

  const dayStartMs = resolveHKDayStartUtcMs(dayKey);
  if (dayStartMs === null) {
    return;
  }

  addCandidate(
    candidates,
    nowMs,
    dayStartMs + TIME.MILLISECONDS_PER_DAY,
    'HK_DAY_BOUNDARY',
    dayKey,
  );

  if (isTradingDay !== true) {
    return;
  }

  const boundaryMinutes = isHalfDay
    ? [9 * 60 + 30, 12 * 60]
    : [9 * 60 + 30, 12 * 60, 13 * 60, 16 * 60];

  for (const minute of boundaryMinutes) {
    addCandidate(
      candidates,
      nowMs,
      dayStartMs + minute * TIME.MILLISECONDS_PER_MINUTE,
      'SESSION_BOUNDARY',
      dayKey,
    );
  }
}

function addOpenProtectionCandidates(params: {
  readonly candidates: TimeWakeupCandidate[];
  readonly nowMs: number;
  readonly dayKey: string | null;
  readonly isTradingDay: boolean | null;
  readonly isHalfDay: boolean;
  readonly openProtection: TimeWakeupPlannerInput['openProtection'];
}): void {
  const { candidates, nowMs, dayKey, isTradingDay, isHalfDay, openProtection } = params;
  if (dayKey === null || isTradingDay !== true) {
    return;
  }

  const dayStartMs = resolveHKDayStartUtcMs(dayKey);
  if (dayStartMs === null) {
    return;
  }

  const { morning, afternoon } = openProtection;
  if (morning.enabled && morning.minutes !== null) {
    addCandidate(
      candidates,
      nowMs,
      dayStartMs + (9 * 60 + 30 + morning.minutes) * TIME.MILLISECONDS_PER_MINUTE,
      'OPEN_PROTECTION_END',
      'morning',
    );
  }

  if (!isHalfDay && afternoon.enabled && afternoon.minutes !== null) {
    addCandidate(
      candidates,
      nowMs,
      dayStartMs + (13 * 60 + afternoon.minutes) * TIME.MILLISECONDS_PER_MINUTE,
      'OPEN_PROTECTION_END',
      'afternoon',
    );
  }
}

function addLifecycleCandidates(params: {
  readonly candidates: TimeWakeupCandidate[];
  readonly nowMs: number;
  readonly lifecycle: TimeWakeupPlannerInput['lifecycle'];
}): void {
  const { candidates, nowMs, lifecycle } = params;
  addCandidate(candidates, nowMs, lifecycle.nextRetryAtMs, 'LIFECYCLE_RETRY', 'retry');
  addCandidate(
    candidates,
    nowMs,
    lifecycle.pendingOpenRebuildAtMs,
    'PENDING_OPEN_REBUILD',
    'next-continuous-session-open',
  );
}

function addDoomsdayCandidates(params: {
  readonly candidates: TimeWakeupCandidate[];
  readonly nowMs: number;
  readonly dayKey: string | null;
  readonly isTradingDay: boolean | null;
  readonly isHalfDay: boolean;
  readonly doomsday: TimeWakeupPlannerInput['doomsday'];
}): void {
  const { candidates, nowMs, dayKey, isTradingDay, isHalfDay, doomsday } = params;
  if (!doomsday.enabled) {
    return;
  }

  addCandidate(
    candidates,
    nowMs,
    doomsday.clearanceRetryAtMs,
    'DOOMSDAY_CLEARANCE_RETRY',
    'clearance',
  );

  if (dayKey === null || isTradingDay !== true) {
    return;
  }

  const dayStartMs = resolveHKDayStartUtcMs(dayKey);
  if (dayStartMs === null) {
    return;
  }

  const boundaryMinutes = isHalfDay
    ? [11 * 60 + 45, 11 * 60 + 55, 12 * 60]
    : [15 * 60 + 45, 15 * 60 + 55, 16 * 60];

  for (const minute of boundaryMinutes) {
    addCandidate(
      candidates,
      nowMs,
      dayStartMs + minute * TIME.MILLISECONDS_PER_MINUTE,
      'DOOMSDAY_BOUNDARY',
      dayKey,
    );
  }
}

function selectNextWakeupAtMs(candidates: ReadonlyArray<TimeWakeupCandidate>): number | null {
  if (candidates.length === 0) {
    return null;
  }

  return Math.min(...candidates.map((candidate) => candidate.atMs));
}

/**
 * 汇总下一次时间唤醒候选并返回最早时间。
 *
 * @param input 当前评估收集到的时间计划输入
 * @returns 下一次唤醒计划
 */
export function planNextTimeWakeup(input: TimeWakeupPlannerInput): TimeWakeupPlan {
  const candidates: TimeWakeupCandidate[] = [];

  addSessionBoundaryCandidates({
    candidates,
    nowMs: input.nowMs,
    dayKey: input.dayKey,
    isTradingDay: input.isTradingDay,
    isHalfDay: input.isHalfDay,
  });
  addOpenProtectionCandidates({
    candidates,
    nowMs: input.nowMs,
    dayKey: input.dayKey,
    isTradingDay: input.isTradingDay,
    isHalfDay: input.isHalfDay,
    openProtection: input.openProtection,
  });
  addLifecycleCandidates({
    candidates,
    nowMs: input.nowMs,
    lifecycle: input.lifecycle,
  });
  addDoomsdayCandidates({
    candidates,
    nowMs: input.nowMs,
    dayKey: input.dayKey,
    isTradingDay: input.isTradingDay,
    isHalfDay: input.isHalfDay,
    doomsday: input.doomsday,
  });

  addCandidate(candidates, input.nowMs, input.recoveryRetryAtMs, 'RECOVERY_RETRY', 'time-driver');

  const nextWakeupAtMs = selectNextWakeupAtMs(candidates);
  if (nextWakeupAtMs === null) {
    return {
      hasWork: false,
      nextWakeupAtMs: null,
      candidates: [],
    };
  }

  return {
    hasWork: true,
    nextWakeupAtMs,
    candidates,
  };
}
```

- [ ] **Step 5: Run planner tests**

Run:

```bash
bun test tests/main/timeWakeupPlanner/business.test.ts
```

Expected: PASS.

---

## 3. Task: Return Lifecycle Retry Plan from DayLifecycleManager

**Files:**

- Modify: `src/main/lifecycle/types.ts`
- Modify: `src/main/lifecycle/dayLifecycleManager.ts`
- Test: `tests/main/lifecycle/dayLifecycleManager.test.ts`

- [ ] **Step 1: Add lifecycle result tests**

Append focused tests to `tests/main/lifecycle/dayLifecycleManager.test.ts`:

```ts
test('midnight clear failure returns next retry time without enabling trading', async () => {
  const mutableState = {
    currentDayKey: '2026-04-28',
    lifecycleState: 'ACTIVE' as const,
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
  };
  const manager = createDayLifecycleManager({
    mutableState,
    rebuildRetryDelayMs: 1_000,
    cacheDomains: [
      {
        midnightClear: () => {
          throw new Error('clear failed');
        },
        openRebuild: () => {},
      },
    ],
    logger: createSilentLifecycleLogger(),
  });

  const now = new Date('2026-04-29T00:00:00.000+08:00');
  const result = await manager.tick(now, {
    dayKey: '2026-04-29',
    canTradeNow: false,
    isTradingDay: true,
  });

  expect(result.nextRetryAtMs).toBe(now.getTime() + 1_000);
  expect(result.pendingOpenRebuild).toBe(false);
  expect(mutableState.isTradingEnabled).toBe(false);
});

test('open rebuild failure returns next retry time', async () => {
  const mutableState = {
    currentDayKey: '2026-04-29',
    lifecycleState: 'MIDNIGHT_CLEANED' as const,
    pendingOpenRebuild: true,
    targetTradingDayKey: '2026-04-29',
    isTradingEnabled: false,
  };
  const manager = createDayLifecycleManager({
    mutableState,
    rebuildRetryDelayMs: 2_000,
    cacheDomains: [
      {
        midnightClear: () => {},
        openRebuild: () => {
          throw new Error('rebuild failed');
        },
      },
    ],
    logger: createSilentLifecycleLogger(),
  });

  const now = new Date('2026-04-29T09:30:00.000+08:00');
  const result = await manager.tick(now, {
    dayKey: '2026-04-29',
    canTradeNow: true,
    isTradingDay: true,
  });

  expect(result.nextRetryAtMs).toBe(now.getTime() + 2_000);
  expect(result.pendingOpenRebuild).toBe(true);
  expect(mutableState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
  expect(mutableState.isTradingEnabled).toBe(false);
});

test('pendingOpenRebuild false converges lifecycle to ACTIVE and trading enabled', async () => {
  const mutableState = {
    currentDayKey: '2026-04-29',
    lifecycleState: 'OPEN_REBUILD_FAILED' as const,
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: false,
  };
  const manager = createDayLifecycleManager({
    mutableState,
    rebuildRetryDelayMs: 1_000,
    cacheDomains: [],
    logger: createSilentLifecycleLogger(),
  });

  const result = await manager.tick(new Date('2026-04-29T10:00:00.000+08:00'), {
    dayKey: '2026-04-29',
    canTradeNow: true,
    isTradingDay: true,
  });

  expect(result.nextRetryAtMs).toBeNull();
  expect(result.pendingOpenRebuild).toBe(false);
  expect(mutableState.lifecycleState).toBe('ACTIVE');
  expect(mutableState.isTradingEnabled).toBe(true);
});
```

If `createSilentLifecycleLogger()` does not exist, add it once near existing test helpers:

```ts
function createSilentLifecycleLogger(): Pick<Logger, 'info' | 'warn' | 'error'> {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
```

- [ ] **Step 2: Run lifecycle tests to verify failure**

Run:

```bash
bun test tests/main/lifecycle/dayLifecycleManager.test.ts
```

Expected: FAIL because `tick(...)` currently returns `void`.

- [ ] **Step 3: Update lifecycle types**

Modify `src/main/lifecycle/types.ts`:

```ts
/** 单次生命周期 tick 后暴露给时间评估器的重试与等待状态。 */
export type DayLifecycleTickResult = Readonly<{
  nextRetryAtMs: number | null;
  pendingOpenRebuild: boolean;
}>;

export interface DayLifecycleManager {
  readonly tick: (now: Date, runtime: LifecycleRuntimeFlags) => Promise<DayLifecycleTickResult>;
}
```

- [ ] **Step 4: Update dayLifecycleManager returns**

In `src/main/lifecycle/dayLifecycleManager.ts`, add helper inside `createDayLifecycleManager`:

```ts
function buildTickResult(): DayLifecycleTickResult {
  return {
    nextRetryAtMs: nextMidnightRetryAtMs ?? nextRetryAtMs,
    pendingOpenRebuild: mutableState.pendingOpenRebuild,
  };
}
```

Change every `return;` inside `tick(...)` to `return buildTickResult();`, and change the signature:

```ts
async function tick(
  now: Date,
  runtime: LifecycleRuntimeFlags,
): Promise<DayLifecycleTickResult> {
```

The `pendingOpenRebuild=false` branch must remain:

```ts
if (!mutableState.pendingOpenRebuild) {
  mutableState.lifecycleState = 'ACTIVE';
  mutableState.isTradingEnabled = true;
  return buildTickResult();
}
```

- [ ] **Step 5: Run lifecycle tests**

Run:

```bash
bun test tests/main/lifecycle/dayLifecycleManager.test.ts
```

Expected: PASS.

---

## 4. Task: Add Trading-Duration Due-Time Utility

**Files:**

- Modify: `src/utils/time/types.ts`
- Modify: `src/utils/time/index.ts`
- Test: `tests/utils/time.business.test.ts`

- [ ] **Step 1: Add due-time tests**

Append to `tests/utils/time.business.test.ts`:

```ts
import { calculateTradingDurationDueAtMs } from '../../src/utils/time/index.js';

function hkMs(day: string, hour: number, minute: number): number {
  return Date.parse(`${day}T00:00:00.000+08:00`) + (hour * 60 + minute) * 60_000;
}

test('calculateTradingDurationDueAtMs skips lunch break', () => {
  const snapshot = new Map([
    ['2026-04-29', { isTradingDay: true, isHalfDay: false }],
  ]);

  const dueAtMs = calculateTradingDurationDueAtMs({
    startMs: hkMs('2026-04-29', 11, 50),
    targetDurationMs: 20 * 60_000,
    calendarSnapshot: snapshot,
  });

  expect(dueAtMs).toBe(hkMs('2026-04-29', 13, 10));
});

test('calculateTradingDurationDueAtMs accumulates across trading days', () => {
  const snapshot = new Map([
    ['2026-04-29', { isTradingDay: true, isHalfDay: false }],
    ['2026-04-30', { isTradingDay: true, isHalfDay: false }],
  ]);

  const dueAtMs = calculateTradingDurationDueAtMs({
    startMs: hkMs('2026-04-29', 15, 50),
    targetDurationMs: 20 * 60_000,
    calendarSnapshot: snapshot,
  });

  expect(dueAtMs).toBe(hkMs('2026-04-30', 9, 40));
});

test('calculateTradingDurationDueAtMs respects half day sessions', () => {
  const snapshot = new Map([
    ['2026-04-29', { isTradingDay: true, isHalfDay: true }],
    ['2026-04-30', { isTradingDay: true, isHalfDay: false }],
  ]);

  const dueAtMs = calculateTradingDurationDueAtMs({
    startMs: hkMs('2026-04-29', 11, 50),
    targetDurationMs: 20 * 60_000,
    calendarSnapshot: snapshot,
  });

  expect(dueAtMs).toBe(hkMs('2026-04-30', 9, 40));
});

test('calculateTradingDurationDueAtMs returns null when calendar cannot cover target', () => {
  const snapshot = new Map([
    ['2026-04-29', { isTradingDay: true, isHalfDay: false }],
  ]);

  const dueAtMs = calculateTradingDurationDueAtMs({
    startMs: hkMs('2026-04-29', 15, 50),
    targetDurationMs: 20 * 60_000,
    calendarSnapshot: snapshot,
  });

  expect(dueAtMs).toBeNull();
});

Add boundary cases in the same test file:

- start before morning open counts only from 09:30, not from natural start time;
- start during lunch resumes at 13:00 on a normal day;
- start after normal close advances only through explicit next-day calendar facts;
- start on a non-trading day advances only through explicit later trading-day facts;
- exact session boundary behavior uses half-open intervals and does not double-count boundary minutes.
```

- [ ] **Step 2: Run time utility tests to verify failure**

Run:

```bash
bun test tests/utils/time.business.test.ts
```

Expected: FAIL because `calculateTradingDurationDueAtMs` does not exist.

- [ ] **Step 3: Add types**

Modify `src/utils/time/types.ts` to include:

```ts
import type { TradingCalendarSnapshot } from '../../types/tradingCalendar.js';

/** 从起点与目标累计交易时长反推到期 UTC 毫秒时间戳。 */
export type TradingDurationDueAtParams = Readonly<{
  startMs: number;
  targetDurationMs: number;
  calendarSnapshot: TradingCalendarSnapshot;
}>;
```

- [ ] **Step 4: Implement due-time utility**

Modify `src/utils/time/index.ts`:

```ts
import type { HKTime, SessionRange, TradingDurationDueAtParams } from './types.js';
```

Add after `calculateTradingDurationMsBetween(...)`:

```ts
/**
 * 从起点按交易时段累计时长反推到期时间。
 *
 * @param params 起点、目标累计交易时长与交易日历快照
 * @returns 到期 UTC 毫秒时间戳；快照不足以覆盖目标时返回 null
 */
export function calculateTradingDurationDueAtMs(params: TradingDurationDueAtParams): number | null {
  const { startMs, targetDurationMs, calendarSnapshot } = params;
  if (!Number.isFinite(startMs) || !Number.isFinite(targetDurationMs) || targetDurationMs <= 0) {
    return null;
  }

  let remainingMs = targetDurationMs;
  let cursorMs = startMs;
  const orderedDayKeys = [...calendarSnapshot.keys()].sort();

  for (const dayKey of orderedDayKeys) {
    const dayStartUtcMs = resolveHKDayStartUtcMs(dayKey);
    const dayInfo = calendarSnapshot.get(dayKey);
    if (dayStartUtcMs === null || dayInfo?.isTradingDay !== true) {
      continue;
    }

    const dayEndUtcMs = dayStartUtcMs + TIME.MILLISECONDS_PER_DAY;
    if (dayEndUtcMs <= cursorMs) {
      continue;
    }

    const sessionRanges = resolveSessionRangesByDay(dayStartUtcMs, dayInfo);
    for (const session of sessionRanges) {
      const segmentStartMs = Math.max(cursorMs, session.startMs);
      if (segmentStartMs >= session.endMs) {
        continue;
      }

      const sessionAvailableMs = session.endMs - segmentStartMs;
      if (remainingMs <= sessionAvailableMs) {
        return segmentStartMs + remainingMs;
      }

      remainingMs -= sessionAvailableMs;
      cursorMs = session.endMs;
    }
  }

  return null;
}
```

- [ ] **Step 5: Run time utility tests**

Run:

```bash
bun test tests/utils/time.business.test.ts
```

Expected: PASS.

---

## 5. Task: Add PeriodicSwitchWakeupRuntime

**Files:**

- Create: `src/main/periodicSwitchWakeupRuntime/types.ts`
- Create: `src/main/periodicSwitchWakeupRuntime/index.ts`
- Test: `tests/main/periodicSwitchWakeupRuntime/business.test.ts`

- [ ] **Step 1: Write periodic switch runtime tests**

Create `tests/main/periodicSwitchWakeupRuntime/business.test.ts` with tests that verify the business contract rather than a broad fake implementation:

- `start()` seeds both `LONG` and `SHORT` routes for enabled monitors and dispatches due routes through `monitorTaskQueue.scheduleLatest` as `AUTO_SYMBOL_TICK` with the existing dedupe key shape: `monitorSymbol:AUTO_SYMBOL_TICK:direction`.
- Repeated `start()` calls are idempotent: they do not duplicate subscriptions, duplicate route timers, or dispatch duplicate due tasks; after `stopAndDrain()`, a later `start()` may subscribe and seed routes again.
- If calculated `dueAtMs <= nowMs`, runtime dispatches exactly once inline and does not register a `0ms` timer.
- If calculated `dueAtMs > nowMs`, runtime registers one timer for that route and dispatches only when the timer fires with the same complete baseline still current.
- If `calculateDueAtMs(...) === null`, runtime does not dispatch `AUTO_SYMBOL_TICK`, does not register a timer, and does not create a retry/fallback timer; the next recalculation must come from seat truth, gate-open, or lifecycle/open-rebuild wiring after calendar facts are refreshed.
- `stopAndDrain()` prevents later timer callbacks, order events, or freshness events from dispatching new `AUTO_SYMBOL_TICK` tasks.
- A queued task whose `lastSeatActivatedAt` no longer matches current seat truth is treated as stale and cannot mark waiting-empty or replan from the old baseline.
- `onSeatTruthChanged` recalculates or clears the route plan after seat activation, clear, or version changes, but does not act as a waiting-empty progress source.
- 如果 seat truth 显示该路线的 `symbol`、`seatVersion` 或 `lastSeatActivatedAt` 已变化，必须先清除旧 timer 与 waiting-empty 标记，再重新计算；新进入 ACTIVE 的席位使用新的 `lastSeatActivatedAt` 作为下一轮周期基线。
- `OrderStateChangedEvent` and `PostTradeConsistencyFreshReachedEvent` re-dispatch only routes currently marked waiting-empty, using the same `AUTO_SYMBOL_TICK` dedupe key.
- `stopAndDrain()` unsubscribes listeners, clears route timers, and clears waiting-empty routes.

Test fakes must use existing public types:

```ts
import type { SymbolRegistry } from '../../../src/types/seat.js';
import type {
  OrderStateChangedEvent,
  PostTradeConsistencyFreshReachedEvent,
} from '../../../src/types/services.js';

type SeatTruthListener = Parameters<SymbolRegistry['onSeatTruthChanged']>[0];

const seatTruthListeners: SeatTruthListener[] = [];
const orderListeners: Array<(event: OrderStateChangedEvent) => void> = [];
const freshListeners: Array<(event: PostTradeConsistencyFreshReachedEvent) => void> = [];
```

Do not import unexported seat truth payload types, do not invent new order event type names, and do not cast partial event objects to production event types. Build the minimal valid `OrderStateChangedEvent` / `PostTradeConsistencyFreshReachedEvent` objects in the test helper.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test tests/main/periodicSwitchWakeupRuntime/business.test.ts
```

Expected: FAIL because runtime does not exist.

- [ ] **Step 3: Add runtime types**

Create `src/main/periodicSwitchWakeupRuntime/types.ts` with these contracts:

- Keep route state structured as `{ monitorSymbol, direction }`; do not encode route state into a string and later parse it back with type assertions.
- Store the current seat baseline for each planned route: `symbol`, `seatVersion`, and `lastSeatActivatedAt`. If any of these changes, the previous periodic timer and waiting-empty mark no longer belong to the current seat truth.
- Depend on `symbolRegistry.getSeatState`, `symbolRegistry.getSeatVersion`, and `symbolRegistry.onSeatTruthChanged`.
- Depend on `trader.onOrderStateChanged` using the existing `OrderStateChangedEvent` type from `src/types/services.ts`.
- Depend on `postTradeConsistencyRuntime.onFreshReached` using `PostTradeConsistencyFreshReachedEvent`.
- Expose only `start`, `stopAndDrain`, `markWaitingEmpty`, `clearWaitingEmpty`, and `replanRouteAfterTask`.
- `markWaitingEmpty`, `clearWaitingEmpty`, and `replanRouteAfterTask` all receive the task route baseline (`monitorSymbol`, `direction`, `symbol`, `seatVersion`, `lastSeatActivatedAt`) so stale `AUTO_SYMBOL_TICK` outcomes cannot mutate a newly activated seat route.
- `replanRouteAfterTask` is the only task-outcome handoff from `MonitorTaskProcessor` back to the periodic owner. It must clear stale baselines, preserve waiting-empty routes, and recompute due timers for non-waiting routes after a processed/skipped/failed `AUTO_SYMBOL_TICK`.
- Do not expose periodic switch due candidates to the system-level planner; periodic switch due time is owned by this runtime.

The dependency shape should be narrow and explicit:

```ts
export type PeriodicSwitchRoute = Readonly<{
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
}>;

export type PeriodicSwitchRouteBaseline = PeriodicSwitchRoute &
  Readonly<{
    symbol: string;
    seatVersion: number;
    lastSeatActivatedAt: number;
  }>;

export interface PeriodicSwitchWakeupRuntime {
  start(): void;
  stopAndDrain(): Promise<void>;
  markWaitingEmpty(baseline: PeriodicSwitchRouteBaseline): void;
  clearWaitingEmpty(baseline: PeriodicSwitchRouteBaseline): void;
  replanRouteAfterTask(
    params: PeriodicSwitchRouteBaseline &
      Readonly<{
        taskTimeMs: number;
        status: 'processed' | 'skipped' | 'failed';
      }>,
  ): void;
}

export type PeriodicSwitchWakeupRuntimeDeps = Readonly<{
  tradingConfig: Pick<MultiMonitorTradingConfig, 'monitors'>;
  monitorContexts: ReadonlyMap<string, Pick<MonitorContext, 'config'>>;
  symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion' | 'onSeatTruthChanged'>;
  monitorTaskQueue: Pick<MonitorTaskQueue<MonitorTaskDataMap>, 'scheduleLatest'>;
  trader: Pick<Trader, 'onOrderStateChanged'>;
  postTradeConsistencyRuntime: Readonly<{
    onFreshReached: (
      listener: (event: PostTradeConsistencyFreshReachedEvent) => void,
    ) => Unsubscribe;
  }>;
  tradingGateEventRuntime: Pick<TradingGateEventRuntime, 'onGateStateChanged'>;
  calculateDueAtMs: (params: {
    readonly startMs: number;
    readonly switchIntervalMinutes: number;
  }) => number | null;
  now: () => Date;
  scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}>;
```

- [ ] **Step 4: Implement runtime**

Create `src/main/periodicSwitchWakeupRuntime/index.ts` with these required behaviors:

1. `start()` is idempotent while running: a second call returns without adding subscriptions, timers, or duplicate due dispatches.
2. After `stopAndDrain()`, a later `start()` may subscribe and seed routes again from current seat truth.
3. Route seeding iterates configured monitors and both directions.
4. Disabled auto-search or `switchIntervalMinutes <= 0` clears any existing route timer and waiting-empty mark for that route.
5. Non-`ACTIVE` seat or missing `lastSeatActivatedAt` clears any existing route timer; it does not dispatch a task.
6. A planned route is valid only for the seat baseline used to calculate it. If current `symbol`, `seatVersion`, or `lastSeatActivatedAt` differs from the stored baseline, clear the old route timer and waiting-empty mark before recalculating.
7. `lastSeatActivatedAt` 是周期换标计时起点。距离换标完成与周期换标完成都会先把新席位绑定为 `ACTIVATING`；只有 seat refresh 将路线推进到 `ACTIVE` 并写入新的 `lastSeatActivatedAt` 后，周期计时才按新基线重置。
8. `calculateDueAtMs(...) === null` does not dispatch and does not invent a fallback timer. The next recalculation comes from seat truth change, gate-open, or lifecycle/open-rebuild wiring that refreshes the calendar snapshot.
9. `dueAtMs <= nowMs` dispatches one `AUTO_SYMBOL_TICK` inline with the current complete route baseline (`symbol`, `seatVersion`, `lastSeatActivatedAt`) and does not register a timer. After dispatch, do not immediately reschedule the same route in the same call stack; the next plan change must come from seat truth, gate-open, task outcome, order event, or freshness event.
10. `dueAtMs > nowMs` registers a one-shot timer bound to the same complete route baseline. When the timer fires, delete the timer handle, re-read current seat truth, and dispatch one `AUTO_SYMBOL_TICK` only if `symbol`, `seatVersion`, and `lastSeatActivatedAt` still match the stored baseline; do not recursively call the scheduler from the timer callback.
11. `onSeatTruthChanged` only recalculates the route plan for the event route. It must not call `markWaitingEmpty` or dispatch waiting-empty progress by itself.
12. `onGateStateChanged` only handles `previousCanTrade=false -> nextCanTrade=true` and only replans routes that are not marked waiting-empty. This replaces the old per-second loop's “下一交易时段再检查”语义，不得在 gate-close、午休内或 waiting-empty 状态下主动重投递。
13. `onOrderStateChanged` and `onFreshReached` re-dispatch the currently marked waiting-empty routes. The runtime may optionally filter order events by route symbol if it can do so from current seat truth, but it must not rely on polling.
14. `markWaitingEmpty`、`clearWaitingEmpty`、`replanRouteAfterTask` are idempotent and must validate the current seat baseline before mutating route state.
15. `stopAndDrain()` unsubscribes listeners, clears every timer, and clears waiting-empty routes.

The core timer branch should follow this shape:

```ts
const nowMs = deps.now().getTime();
clearRouteTimer(route);

if (dueAtMs <= nowMs) {
  dispatchAutoSymbolTick(baseline);
  return;
}

const timer = deps.scheduleTimer(() => {
  routeTimers.delete(toRouteKey(route));
  if (!currentBaselineMatches(baseline)) {
    return;
  }
  dispatchAutoSymbolTick(baseline);
}, dueAtMs - nowMs);
routeTimers.set(toRouteKey(route), timer);
```

`dispatchAutoSymbolTick(...)` must write `lastSeatActivatedAt` into the queued task data together with `monitorSymbol`, `direction`, `symbol`, `seatVersion`, and `currentTimeMs`.

This runtime is the only owner of periodic switch due timers. It must not register `0ms` timers, must not reschedule recursively after a due dispatch, and must not add periodic switch candidates to `timeWakeupPlanner`.

- [ ] **Step 5: Add explicit periodic task outcome and waiting-empty handoff contracts**

Do not infer periodic waiting-empty from `SwitchDriveResult.kind === 'WAIT'`. In the current codebase, `WAIT` belongs to an actual pending switch that `switchWakeupRuntime` can hand off, while periodic waiting-empty is recorded by the periodic path and currently returns `NOOP`.

Use one direct waiting-empty contract: extend `AutoSymbolManagerPort` with a read-only `getPeriodicSwitchPendingState(direction)` method returning the existing `PeriodicSwitchPendingState`. After `maybeSwitchOnInterval`, `MonitorTaskProcessor` queries it and calls `markWaitingEmpty(taskBaseline)` when `pending === true`, otherwise `clearWaitingEmpty(taskBaseline)`. The task baseline must be the `monitorSymbol`、`direction`、`symbol`、`seatVersion` and `lastSeatActivatedAt` captured in the queued `AUTO_SYMBOL_TICK`; routes without a non-null `symbol` and `lastSeatActivatedAt` are not valid periodic task baselines and must not be dispatched. Do not change `maybeSwitchOnInterval` to return a second periodic result union, and do not change `SwitchDriveResult.kind === 'WAIT'` semantics.

Add a separate task-outcome handoff from `MonitorTaskProcessor` to `PeriodicSwitchWakeupRuntime`:

```ts
replanRouteAfterTask({
  monitorSymbol: data.monitorSymbol,
  direction: data.direction,
  seatVersion: data.seatVersion,
  symbol: data.symbol,
  taskTimeMs: data.currentTimeMs,
  status,
});
```

Required outcome rules:

1. If the task seat snapshot is stale, clear any route state for the old baseline and do not schedule from the stale task.
2. If periodic pending is true after `maybeSwitchOnInterval`, mark waiting-empty and do not register a tight timer.
3. If periodic pending is false and the current seat baseline still matches the task baseline, clear waiting-empty and recompute the next due timer from current seat truth.
4. If `getCanTradeNow()` was false when the task ran, do not rely on order/freshness events; keep the route non-waiting and let the next `previousCanTrade=false -> nextCanTrade=true` gate event replan it.
5. If task processing failed, validate the current baseline and replan the route from current seat truth; do not introduce an extra retry timer or fallback scan.

The handler must keep the existing `switchWakeupRuntime.handoffPendingSwitch(...)` path only for `result.kind === 'WAIT'`. It must not pass periodic waiting-empty routes to `switchWakeupRuntime`.

Update these files in the same task:

- `src/types/monitorContextPorts.ts`: add `getPeriodicSwitchPendingState(direction)` to `AutoSymbolManagerPort` and keep `SwitchDriveResult` unchanged.
- `src/main/asyncProgram/monitorTaskProcessor/types.ts`: inject `PeriodicSwitchWakeupRuntime` and update `AUTO_SYMBOL_TICK` comments to say it is dispatched by `PeriodicSwitchWakeupRuntime` or explicit auto-symbol events, not by the removed fixed main loop.
- `src/main/asyncProgram/monitorTaskProcessor/index.ts`: pass the periodic runtime into `createAutoSymbolHandlers(...)`.
- `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`: include `lastSeatActivatedAt` in `AUTO_SYMBOL_TICK` task data, then call the waiting-empty and task-outcome handoff after `maybeSwitchOnInterval(...)` and after skip/failure paths where the task has a full route snapshot.
- `src/app/runtime/createAsyncRuntime.ts`: accept the periodic runtime from app wiring and pass it into `createMonitorTaskProcessor(...)`.
- `src/main/lifecycle/cacheDomains/types.ts`: add a narrow `periodicSwitchWakeupRuntime: Pick<PeriodicSwitchWakeupRuntime, 'start' | 'stopAndDrain'>` dependency to `SignalRuntimeDomainDeps`.
- `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`: call `await periodicSwitchWakeupRuntime.stopAndDrain()` during `midnightClear` before `monitorTaskProcessor.stopAndDrain()`, and call `periodicSwitchWakeupRuntime.start()` during `openRebuild` only with the ordinary runtime start sequence. Do not start it from lifecycle paths that have not completed rebuild.

Add tests for this handoff before wiring app startup:

- `AUTO_SYMBOL_TICK` processed with periodic pending true calls `markWaitingEmpty` and does not pass the route to `switchWakeupRuntime`.
- `AUTO_SYMBOL_TICK` processed with periodic pending false calls `clearWaitingEmpty` and `replanRouteAfterTask` when the full task baseline still matches.
- stale task snapshots, including stale `lastSeatActivatedAt`, clear only the stale route state and never schedule from the stale symbol/version/activation baseline.
- `getCanTradeNow() === false` leaves the route non-waiting and relies on the next gate-open event to replan.

- [ ] **Step 6: Run periodic switch tests**

Run:

```bash
bun test tests/main/periodicSwitchWakeupRuntime/business.test.ts
bun test tests/main/asyncProgram/monitorTaskProcessor
```

Expected: PASS.

---

## 6. Task: Move Doomsday Clearance Retry into Wakeup Plan

**Files:**

- Modify: `src/core/doomsdayProtection/types.ts`
- Modify: `src/core/doomsdayProtection/index.ts`
- Test: `tests/core/doomsdayProtection/business.test.ts` or existing doomsday protection test file

- [ ] **Step 1: Add doomsday retry result test**

Add focused tests for retry-only, partial-submit retry, and retry cleanup cases:

```ts
expect(result.executed).toBe(false);
expect(result.signalCount).toBe(0);
expect(result.nextRetryAtMs).toBe(currentTime.getTime() + quoteRetryIntervalMs);
```

Also cover the case where one clearance signal was submitted and another symbol is missing quote in the same clearance window:

```ts
expect(result.executed).toBe(true);
expect(result.signalCount).toBe(1);
expect(result.nextRetryAtMs).toBe(currentTime.getTime() + quoteRetryIntervalMs);
```

Also assert that a successful clearance, a no-position/no-clearance path, and a closed-window evaluation return `nextRetryAtMs: null` and do not preserve retry accounting from a previous quote-missing attempt.

Use the existing doomsday protection test harness if present. If there is no existing harness, create `tests/core/doomsdayProtection/business.test.ts` with minimal fakes for `marketDataClient`, `trader`, `lastState`, `monitorConfigs`, and `monitorContexts`.

- [ ] **Step 2: Run doomsday tests to verify failure**

Run the focused existing doomsday protection test file you extended. If the new harness was necessary, run:

```bash
bun test tests/core/doomsdayProtection/business.test.ts
```

Expected: FAIL because `DoomsdayClearanceResult` has no `nextRetryAtMs`.

- [ ] **Step 3: Update result type**

Modify `src/core/doomsdayProtection/types.ts`:

```ts
export type DoomsdayClearanceResult = {
  readonly executed: boolean;
  readonly signalCount: number;
  readonly nextRetryAtMs: number | null;
};
```

- [ ] **Step 4: Replace hidden retry timer with explicit retry result**

In `src/core/doomsdayProtection/index.ts`:

1. Remove only the hidden timer owner state and callback path:

```ts
let clearanceRetryHandle: ReturnType<typeof setTimeout> | null = null;
```

2. Remove `scheduleRetry(...)` and timer-handle cleanup logic if they become unused.
3. Preserve retry accounting state such as `clearanceRetryAttempts`, `clearanceRetrySymbols`, and `clearanceRetryExhaustedSymbols`; these are part of the current clearance retry semantics, not timer ownership.
4. When quote is missing and the retry budget is not exhausted, update the same retry accounting state that the current implementation updates, then return the current execution result plus the explicit retry time:

```ts
return {
  executed: submittedCount > 0,
  signalCount: submittedCount,
  nextRetryAtMs: currentTime.getTime() + quoteRetryIntervalMs,
};
```

5. When retry budget is exhausted, record exhausted symbols exactly as the current logic does and return `nextRetryAtMs: null` while still preserving `executed: submittedCount > 0` and `signalCount: submittedCount`.
6. For gate-closed, outside-window, no-position, or successful no-retry paths, clear retry state exactly where the current implementation clears it and return `nextRetryAtMs: null`.
7. Keep all existing dedupe, partial-submit, `executed`, and `signalCount` semantics; do not make clearance a per-day one-shot.

- [ ] **Step 5: Run doomsday tests**

Run the same focused doomsday protection test target used in Step 2.

Expected: PASS.

---

## 7. Task: Rename and Convert TimeWakeupEvaluationProgram to Single Evaluation

**Files:**

- Modify: `src/main/timeWakeupEvaluationProgram/types.ts`
- Modify: `src/main/timeWakeupEvaluationProgram/index.ts`
- Modify or delete: `src/main/processMonitor/index.ts`
- Modify or delete: `src/main/processMonitor/autoSymbolTasks.ts`
- Test: `tests/main/timeWakeupEvaluationProgram/business.test.ts`

- [ ] **Step 1: Write timeWakeupEvaluationProgram tests**

Create or extend `tests/main/timeWakeupEvaluationProgram/business.test.ts` with these cases:

```ts
test('publishes gate event after lifecycle tick', async () => {
  const calls: string[] = [];
  const context = createTimeWakeupEvaluationHarness({
    now: new Date('2026-04-29T09:30:00.000+08:00'),
    initialCanTrade: false,
    lifecycleTick: async () => {
      calls.push('lifecycle');
      return { nextRetryAtMs: null, pendingOpenRebuild: false };
    },
    emitGateStateChanged: () => {
      calls.push('gate');
    },
  });

  await runTimeWakeupEvaluation(context);

  expect(calls).toEqual(['lifecycle', 'gate']);
});

test('open protection keeps canTrade true and only marks openProtectionActive', async () => {
  const context = createTimeWakeupEvaluationHarness({
    now: new Date('2026-04-29T09:31:00.000+08:00'),
    morningProtectionMinutes: 5,
  });

  await runTimeWakeupEvaluation(context);

  expect(context.lastState.canTrade).toBe(true);
  expect(context.lastState.openProtectionActive).toBe(true);
});

test('12:00 closes gate and cancels ordinary delayed validations', async () => {
  const verifier = createDelayedVerifierFake({ pendingCount: 2 });
  const context = createTimeWakeupEvaluationHarness({
    now: new Date('2026-04-29T12:00:00.000+08:00'),
    initialCanTrade: true,
    verifier,
  });

  await runTimeWakeupEvaluation(context);

  expect(context.lastState.canTrade).toBe(false);
  expect(verifier.cancelAllCalls).toEqual(['700.HK']);
});

test('returns planner output with lifecycle and doomsday retry candidates', async () => {
  const now = new Date('2026-04-29T10:00:00.000+08:00');
  const context = createTimeWakeupEvaluationHarness({
    now,
    lifecycleTick: async () => ({
      nextRetryAtMs: now.getTime() + 30_000,
      pendingOpenRebuild: true,
    }),
    resolveNextOpenRebuildAtMs: () => Date.parse('2026-04-30T09:30:00.000+08:00'),
    doomsdayClearanceResult: {
      executed: false,
      signalCount: 0,
      nextRetryAtMs: now.getTime() + 45_000,
    },
  });

  const result = await runTimeWakeupEvaluation(context);

  expect(result.plan.candidates.map((candidate) => candidate.reason)).toContain('LIFECYCLE_RETRY');
  expect(result.plan.candidates.map((candidate) => candidate.reason)).toContain(
    'PENDING_OPEN_REBUILD',
  );
  expect(result.plan.candidates.map((candidate) => candidate.reason)).toContain(
    'DOOMSDAY_CLEARANCE_RETRY',
  );
});
```

Implement `createTimeWakeupEvaluationHarness(...)` in the test file using current `TimeWakeupEvaluationContext` shape. Keep the harness narrow; fake only dependencies needed by these tests.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test tests/main/timeWakeupEvaluationProgram/business.test.ts
```

Expected: FAIL because `timeWakeupEvaluationProgram` returns `void` and still calls `processMonitor`.

- [ ] **Step 3: Update trading-day cache state type**

Modify all `cachedTradingDayInfo` read/write points so the cache carries the HK date key that produced the value:

- `src/types/state.ts`: change `LastState.cachedTradingDayInfo` shape.
- runtime state initialization: initialize the field as `null` or `{ dateKey, info }`, never as bare `TradingDayInfo`.
- lifecycle midnight clear domains: clear or rewrite the field with an explicit date key.
- `src/main/timeWakeupEvaluationProgram/index.ts`: read the cache only when `dateKey === currentDayKey`; write the queried result with `currentDayKey`.
- `src/main/lifecycle/tradingCalendarPrewarmer.ts`: copy into `tradingCalendarSnapshot` only when the cached date key matches the requested prewarm day.
- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`: when seeding current-day info, write `{ dateKey, info }` and keep snapshot/prewarm date sources explicit.

`src/types/state.ts` shape:

```ts
export type CachedLastStateTradingDayInfo = Readonly<{
  dateKey: string;
  info: TradingDayInfo;
}>;
```

Use this type for `LastState.cachedTradingDayInfo`. Update existing initialization and midnight clear code to write either `{ dateKey, info }` or `null`. Do not keep a compatibility alias that accepts bare `TradingDayInfo`; one-shot evaluation must be able to prove the cache belongs to the current HK day.

Add tests for stale-cache isolation: seed `cachedTradingDayInfo` with yesterday's `dateKey`, run one-shot evaluation for today, and assert the evaluator queries `marketDataClient.isTradingDay(now)` instead of reusing the stale value. Add a prewarmer test that refuses to copy a cache entry whose `dateKey` does not match the requested day.

- [ ] **Step 4: Update timeWakeupEvaluationProgram types**

Modify `src/main/timeWakeupEvaluationProgram/types.ts`:

```ts
import type { TimeWakeupPlan } from '../timeWakeupPlanner/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../periodicSwitchWakeupRuntime/types.js';

/** 单次权威时间评估后返回给 TimeWakeupRuntime 的计划。 */
export type TimeWakeupEvaluationResult = Readonly<{
  plan: TimeWakeupPlan;
}>;
```

Change the function type wherever it appears from `Promise<void>` to `Promise<TimeWakeupEvaluationResult>`.

- [ ] **Step 5: Update timeWakeupEvaluationProgram implementation**

In `src/main/timeWakeupEvaluationProgram/index.ts`:

1. Remove `processMonitor` import and the final monitor loop.
2. Resolve trading-day info by current HK day key only:

```ts
const cachedTradingDayInfo =
  lastState.cachedTradingDayInfo?.dateKey === currentDayKey
    ? lastState.cachedTradingDayInfo.info
    : null;
let isTradingDayToday: boolean | null = cachedTradingDayInfo?.isTradingDay ?? true;
let isHalfDayToday = cachedTradingDayInfo?.isHalfDay ?? false;
```

When querying `marketDataClient.isTradingDay(currentTime)` succeeds, store:

```ts
lastState.cachedTradingDayInfo = {
  dateKey: currentDayKey,
  info: tradingDayInfo,
};
```

Do not read `lastState.cachedTradingDayInfo.info` unless the date key matches `currentDayKey`. 3. Add `resolveNextContinuousSessionOpenMs(...)` before using it in the evaluator. It must be a pure async boundary helper owned by the time wakeup evaluation layer, not by `timeWakeupPlanner`, because it may need calendar facts that are outside the pure planner input. Required behavior:

- return the first continuous-session open strictly after `fromMs` when current-day 09:30 is already passed;
- skip non-trading days and holidays;
- skip the afternoon for half-day trading days;
- after a normal close or half-day close, return the next trading day's 09:30;
- return `null` when the available calendar facts are insufficient instead of guessing;
- never default to the current `dayKey` 09:30.

Add focused tests for current-day 09:30 already passed, normal close, half-day close, non-trading day, and insufficient calendar facts.

4. Track recovery retry when trading day query fails:

```ts
let recoveryRetryAtMs: number | null = null;
```

When `marketDataClient.isTradingDay(...)` throws, preserve the current protective-pause semantics and schedule recovery:

```ts
isTradingDayToday = null;
isHalfDayToday = false;
recoveryRetryAtMs = currentTime.getTime() + TRADING.INTERVAL_MS;
```

Use the existing retry interval constant if the project has a more specific lifecycle/time retry constant; do not add a new config knob. Do not leave `isTradingDayToday` at the optimistic default after a failed query; unknown trading-day state must keep `canTradeNow=false`.

Before calling `dayLifecycleManager.tick(...)`, collapse unknown trading-day state to `false` for the lifecycle runtime flags:

```ts
const lifecycleIsTradingDay = isTradingDayToday === true;
```

Do not widen `LifecycleRuntimeFlags.isTradingDay` to `boolean | null`; lifecycle must continue receiving a conservative boolean, while the planner receives the tri-state `isTradingDayToday` so it can schedule recovery without inventing trading boundaries.

5. Capture lifecycle result and resolve the pending-open rebuild candidate before calling the planner. The planner must receive an absolute `pendingOpenRebuildAtMs`, not a boolean, because only the evaluator has the calendar/service boundary needed to find the next tradable continuous-session open:

```ts
const lifecycleResult = await dayLifecycleManager.tick(currentTime, {
  dayKey: currentDayKey,
  canTradeNow,
  isTradingDay: lifecycleIsTradingDay,
});
const pendingOpenRebuildAtMs = lifecycleResult.pendingOpenRebuild
  ? await resolveNextContinuousSessionOpenMs({
      fromMs: currentTime.getTime(),
      tradingCalendarSnapshot: lastState.tradingCalendarSnapshot,
      marketDataClient,
    })
  : null;
const lifecyclePlan = {
  nextRetryAtMs: lifecycleResult.nextRetryAtMs,
  pendingOpenRebuildAtMs,
};
```

6. Keep gate event after lifecycle result.
7. Track doomsday clearance retry:

```ts
let doomsdayClearanceRetryAtMs: number | null = null;
```

After `executeClearance(...)`:

```ts
doomsdayClearanceRetryAtMs = clearanceResult.nextRetryAtMs;
```

8. Return planner result at every early return point instead of `return;`:

```ts
function buildResult(): TimeWakeupEvaluationResult {
  return {
    plan: planNextTimeWakeup({
      nowMs: currentTime.getTime(),
      dayKey: currentDayKey,
      isTradingDay: isTradingDayToday,
      isHalfDay: isHalfDayToday,
      openProtection: tradingConfig.global.openProtection,
      lifecycle: lifecyclePlan,
      doomsday: {
        enabled: tradingConfig.global.doomsdayProtection,
        clearanceRetryAtMs: doomsdayClearanceRetryAtMs,
      },
      recoveryRetryAtMs,
    }),
  };
}
```

Do not pass periodic switch due times into `planNextTimeWakeup`. Periodic switch due timers are owned exclusively by `PeriodicSwitchWakeupRuntime`.

9. Preserve `takeoverStateByLastState` behavior for clearing ordinary delayed validations when entering clearance takeover.
10. Keep quote/switch class ordinary execution gate closed inside doomsday clearance window by preserving existing doomsday checks and returning after executed clearance.

- [ ] **Step 6: Run timeWakeupEvaluationProgram tests**

Run:

```bash
bun test tests/main/timeWakeupEvaluationProgram/business.test.ts
```

Expected: PASS.

- [ ] **Step 7: Remove fixed processMonitor loop entry**

Use the repository content-search tool to find `processMonitor` and `scheduleAutoSymbolTasks` references under `src` and `tests`.

If only unused definitions remain, delete `src/main/processMonitor/index.ts` and `src/main/processMonitor/autoSymbolTasks.ts`, then remove stale imports and tests. If a shared AUTO_SYMBOL_TICK helper is still used by periodic runtime, move that helper into `src/main/periodicSwitchWakeupRuntime/index.ts` or a same-folder `utils.ts` without re-exporting.

---

## 8. Task: Add TimeWakeupRuntime

**Files:**

- Create: `src/main/timeWakeupRuntime/types.ts`
- Create: `src/main/timeWakeupRuntime/index.ts`
- Test: `tests/main/timeWakeupRuntime/business.test.ts`

- [ ] **Step 1: Write runtime tests**

Create `tests/main/timeWakeupRuntime/business.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createTimeWakeupRuntime } from '../../../src/main/timeWakeupRuntime/index.js';

function createRuntimeHarness(options: { readonly nextWakeupAtMs?: number | null } = {}) {
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const evaluations: number[] = [];
  let nowMs = 1_000;
  let rejectNext = false;

  const runtime = createTimeWakeupRuntime({
    evaluate: async () => {
      evaluations.push(nowMs);
      if (rejectNext) {
        rejectNext = false;
        throw new Error('evaluation failed');
      }

      const nextWakeupAtMs = options.nextWakeupAtMs ?? nowMs + 1_000;
      return {
        plan:
          nextWakeupAtMs === null
            ? { hasWork: false, nextWakeupAtMs: null, candidates: [] }
            : {
                hasWork: true,
                nextWakeupAtMs,
                candidates: [{ atMs: nextWakeupAtMs, reason: 'SESSION_BOUNDARY', detail: 'test' }],
              },
      };
    },
    now: () => new Date(nowMs),
    scheduleTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      handle.cleared = true;
    },
    recoveryRetryDelayMs: 500,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });

  return {
    runtime,
    timers,
    evaluations,
    setNowMs: (value: number) => {
      nowMs = value;
    },
    rejectNextEvaluation: () => {
      rejectNext = true;
    },
  };
}

describe('TimeWakeupRuntime', () => {
  test('start immediately evaluates once and schedules one timer', async () => {
    const harness = createRuntimeHarness();
    harness.runtime.start();
    await Bun.sleep(0);

    expect(harness.evaluations).toEqual([1_000]);
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(1_000);
  });

  test('requestEvaluate during in-flight marks dirty and runs second evaluation after current completes', async () => {
    const harness = createRuntimeHarness();
    harness.runtime.start();
    harness.runtime.requestEvaluate();
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(harness.evaluations.length).toBe(2);
  });

  test('stopAndDrain clears timer and waits in-flight evaluation', async () => {
    const harness = createRuntimeHarness();
    harness.runtime.start();
    await Bun.sleep(0);

    await harness.runtime.stopAndDrain();

    expect(harness.timers[0]?.cleared).toBe(true);
  });

  test('stopAndDrain prevents late evaluation result from scheduling more work', async () => {
    const harness = createRuntimeHarnessWithControlledEvaluation();
    harness.runtime.start();

    const stopPromise = harness.runtime.stopAndDrain();
    harness.resolveEvaluation({ nextWakeupAtMs: 2_000 });
    await stopPromise;

    expect(harness.scheduledAfterStop).toBe(false);
  });

  test('evaluation error schedules recovery retry', async () => {
    const harness = createRuntimeHarness();
    harness.rejectNextEvaluation();
    harness.runtime.start();
    await Bun.sleep(0);

    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(500);
  });

  test('nextWakeupAtMs at or before now schedules recovery retry without inline loop', async () => {
    const harness = createRuntimeHarness({ nextWakeupAtMs: 1_000 });
    harness.runtime.start();
    await Bun.sleep(0);

    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(500);
    expect(harness.evaluations).toEqual([1_000]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test tests/main/timeWakeupRuntime/business.test.ts
```

Expected: FAIL because runtime does not exist.

- [ ] **Step 3: Add runtime types**

Create `src/main/timeWakeupRuntime/types.ts`:

```ts
import type { TimeWakeupEvaluationResult } from '../timeWakeupEvaluationProgram/types.js';
import type { Logger } from '../../utils/logger/types.js';

/** 创建系统级时间事件 owner 所需的单次评估器、timer、时间源与日志。 */
export type TimeWakeupRuntimeDeps<TTimerHandle = ReturnType<typeof setTimeout>> = Readonly<{
  evaluate: () => Promise<TimeWakeupEvaluationResult>;
  now: () => Date;
  scheduleTimer: (callback: () => void, delayMs: number) => TTimerHandle;
  clearTimer: (handle: TTimerHandle) => void;
  recoveryRetryDelayMs: number;
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
}>;

/** 以 one-shot timer 驱动单次权威时间评估的系统级 runtime。 */
export interface TimeWakeupRuntime {
  readonly start: () => void;
  readonly requestEvaluate: () => void;
  readonly stopAndDrain: () => Promise<void>;
}
```

- [ ] **Step 4: Implement runtime**

Create `src/main/timeWakeupRuntime/index.ts`:

```ts
/**
 * TimeWakeupRuntime
 *
 * 职责：
 * - 持有系统级 one-shot 时间 timer
 * - start 后立即执行一次单次时间评估
 * - 评估中收到请求只标记 dirty，完成后立即再评估
 * - 停止时清理 timer 并等待在途评估完成
 */
import { formatError } from '../../utils/error/index.js';
import type { TimeWakeupRuntime, TimeWakeupRuntimeDeps } from './types.js';

/**
 * 创建系统级时间唤醒 runtime。
 *
 * @param deps runtime 依赖
 * @returns TimeWakeupRuntime 实例
 */
export function createTimeWakeupRuntime<TTimerHandle>(
  deps: TimeWakeupRuntimeDeps<TTimerHandle>,
): TimeWakeupRuntime {
  let running = false;
  let inFlight = false;
  let dirty = false;
  let timer: TTimerHandle | null = null;
  const activePromises = new Set<Promise<void>>();

  function clearCurrentTimer(): void {
    if (timer === null) {
      return;
    }

    deps.clearTimer(timer);
    timer = null;
  }

  function scheduleAt(atMs: number | null): void {
    clearCurrentTimer();
    if (!running || atMs === null) {
      return;
    }

    const nowMs = deps.now().getTime();
    if (atMs <= nowMs) {
      deps.logger.error(
        `[TimeWakeupRuntime] 收到非法唤醒时间 atMs=${atMs} nowMs=${nowMs}，将按恢复性 retry 重新唤醒`,
      );
      timer = deps.scheduleTimer(() => {
        timer = null;
        requestEvaluate();
      }, deps.recoveryRetryDelayMs);
      return;
    }

    timer = deps.scheduleTimer(() => {
      timer = null;
      requestEvaluate();
    }, atMs - nowMs);
  }

  function scheduleRecoveryRetry(): void {
    scheduleAt(deps.now().getTime() + deps.recoveryRetryDelayMs);
  }

  async function runEvaluationLoop(): Promise<void> {
    if (inFlight) {
      dirty = true;
      return;
    }

    inFlight = true;
    try {
      do {
        dirty = false;
        try {
          const result = await deps.evaluate();
          scheduleAt(result.plan.hasWork ? result.plan.nextWakeupAtMs : null);
        } catch (error) {
          deps.logger.error(
            '[TimeWakeupRuntime] 时间评估失败，将按恢复性 retry 重新唤醒',
            formatError(error),
          );
          scheduleRecoveryRetry();
        }
      } while (running && dirty);
    } finally {
      inFlight = false;
    }
  }

  function requestEvaluate(): void {
    if (!running) {
      return;
    }

    const promise = runEvaluationLoop();
    activePromises.add(promise);
    void promise.finally(() => {
      activePromises.delete(promise);
    });
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    requestEvaluate();
  }

  async function stopAndDrain(): Promise<void> {
    running = false;
    dirty = false;
    clearCurrentTimer();
    if (activePromises.size > 0) {
      await Promise.allSettled(activePromises);
    }
  }

  return {
    start,
    requestEvaluate,
    stopAndDrain,
  };
}
```

- [ ] **Step 5: Run runtime tests**

Run:

```bash
bun test tests/main/timeWakeupRuntime/business.test.ts
```

Expected: PASS.

---

## 9. Task: Wire Runtime into App and Remove Main Loop

**Files:**

- Modify: `src/app/types.ts`
- Modify: `src/app/runApp.ts`
- Modify: `src/app/runtime/createAsyncRuntime.ts`
- Modify: `src/app/shutdown/createCleanup.ts`
- Test: extend `tests/app/runApp.test.ts` app wiring coverage

- [ ] **Step 1: Write app wiring test**

Append narrow dependency-injection tests to the existing `tests/app/runApp.test.ts` harness:

```ts
import { describe, expect, test } from 'bun:test';
import { createRunApp } from '../../src/app/runApp.js';

describe('runApp event wakeup wiring', () => {
  test('starts TimeWakeupRuntime and ordinary periodic runtime after successful initial rebuild', async () => {
    const started: string[] = [];
    let resolveShutdown!: () => void;
    const shutdownSignal = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const deps = createRunAppDepsHarness({
      initialRebuildSucceeded: true,
      createTimeWakeupRuntime: () => ({
        start: () => {
          started.push('time');
        },
        requestEvaluate: () => {},
        stopAndDrain: async () => {},
      }),
      createPeriodicSwitchWakeupRuntime: () => ({
        start: () => {
          started.push('periodic-switch');
        },
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
        stopAndDrain: async () => {},
      }),
      waitForShutdownSignal: () => shutdownSignal,
    });

    const runApp = createRunApp(deps);
    const appPromise = runApp({ env: {} });
    await Promise.resolve();

    expect(started).toEqual(['periodic-switch', 'time']);

    resolveShutdown();
    await appPromise;
  });

  test('starts only TimeWakeupRuntime when startup rebuild is pending or initial rebuild fails', async () => {
    const started: string[] = [];
    const deps = createRunAppDepsHarness({
      startupSnapshot: { startupRebuildPending: true },
      createTimeWakeupRuntime: () => ({
        start: () => {
          started.push('time');
        },
        requestEvaluate: () => {},
        stopAndDrain: async () => {},
      }),
      createPeriodicSwitchWakeupRuntime: () => ({
        start: () => {
          started.push('periodic-switch');
        },
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
        stopAndDrain: async () => {},
      }),
      startPostGateBusinessRuntimes: () => {
        throw new Error('ordinary business runtimes must not start before rebuild succeeds');
      },
      waitForShutdownSignal: async () => {},
    });

    const runApp = createRunApp(deps);
    await runApp({ env: {} });

    expect(started).toEqual(['time']);
  });
});
```

Build `createRunAppDepsHarness(...)` from existing app test helpers if present. If there is no helper, create the minimal fake dependencies needed to reach both successful startup and startup-rebuild-pending paths. The test must not depend on real Longbridge network calls.

Add shutdown-owner assertions in this app test file: resolving `waitForShutdownSignal()` must invoke `cleanup.execute()` exactly once; the signal waiter fake must not call cleanup itself; and no test path should depend on `createCleanup.registerExitHandlers`.

- [ ] **Step 2: Run app wiring test to verify failure**

Run:

```bash
bun test tests/app/runApp.test.ts
```

Expected: FAIL because `RunAppDeps` has no runtime factories and `runApp` still enters the infinite loop.

- [ ] **Step 3: Lock shutdown ownership migration contract**

Before changing app wiring, lock the shutdown ownership invariant that Steps 4-6 must implement together:

- `runApp` is the only shutdown owner after the fixed loop is removed.
- `waitForShutdownSignal` only resolves the shutdown promise; it never runs cleanup and never calls `process.exit`.
- `CleanupController` exposes only `execute()` in the final type shape.
- `createCleanup` no longer registers `SIGINT` / `SIGTERM` and never calls `process.exit` in the final implementation.
- The app wiring tests must prove cleanup is invoked exactly once by `runApp`, not by signal handlers inside `createCleanup`.

Do not land an intermediate runtime state that removes `createCleanup` signal handling while the old fixed loop is still the process lifetime owner. The ownership transfer becomes executable only when Step 5 deletes the loop and Step 6 removes the old cleanup signal owner.

- [ ] **Step 4: Update app types**

Modify `src/app/types.ts` imports:

```ts
import type { TimeWakeupRuntime, TimeWakeupRuntimeDeps } from '../main/timeWakeupRuntime/types.js';
import type {
  PeriodicSwitchWakeupRuntime,
  PeriodicSwitchWakeupRuntimeDeps,
} from '../main/periodicSwitchWakeupRuntime/types.js';
```

Update `CleanupContext`:

```ts
timeWakeupRuntime: TimeWakeupRuntime;
periodicSwitchWakeupRuntime: PeriodicSwitchWakeupRuntime;
```

Update `CleanupController`:

```ts
export type CleanupController = Readonly<{
  execute: () => Promise<void>;
}>;
```

Update `RunAppDeps`:

```ts
createTimeWakeupRuntime: (deps: TimeWakeupRuntimeDeps) => TimeWakeupRuntime;
createPeriodicSwitchWakeupRuntime: (deps: PeriodicSwitchWakeupRuntimeDeps) =>
  PeriodicSwitchWakeupRuntime;
waitForShutdownSignal: () => Promise<void>;
```

Add the production `waitForShutdownSignal` implementation in the app runtime/shutdown layer, not inside `createCleanup`. It registers one-shot `SIGINT` / `SIGTERM` listeners, resolves once with no cleanup side effects, removes the other listener after resolution, and never calls `process.exit`.

Remove `sleep` from `RunAppDeps` after the loop is gone. Add the explicit `waitForShutdownSignal` dependency so `runApp` has a clear post-start lifetime contract in tests and production. `waitForShutdownSignal` must only resolve the shutdown promise; it must not run cleanup or call `process.exit`. Keep `timeWakeupEvaluationProgram` as the injected `evaluate` function dependency unless the app test harness becomes simpler with direct `createTimeWakeupRuntime` injection.

- [ ] **Step 5: Update runApp**

Modify `src/app/runApp.ts`:

1. Remove imports:

```ts
import { sleep } from '../main/utils.js';
import { TRADING } from '../constants/index.js';
```

2. Add imports:

```ts
import { createTimeWakeupRuntime } from '../main/timeWakeupRuntime/index.js';
import { createPeriodicSwitchWakeupRuntime } from '../main/periodicSwitchWakeupRuntime/index.js';
import { calculateTradingDurationDueAtMs } from '../utils/time/index.js';
```

3. Add defaults:

```ts
createTimeWakeupRuntime,
createPeriodicSwitchWakeupRuntime,
```

4. After monitor contexts are built and post-trade consistency business deps are bound, create `periodicSwitchWakeupRuntime` before `createAsyncRuntime(...)`:

```ts
const periodicSwitchWakeupRuntime = createPeriodicSwitchWakeupRuntime({
  tradingConfig: preGateRuntime.tradingConfig,
  monitorContexts: postGateRuntime.monitorContexts,
  symbolRegistry: preGateRuntime.symbolRegistry,
  monitorTaskQueue: postGateRuntime.monitorTaskQueue,
  trader: postGateRuntime.trader,
  postTradeConsistencyRuntime: postGateRuntime.postTradeConsistencyRuntime,
  tradingGateEventRuntime: postGateRuntime.tradingGateEventRuntime,
  calculateDueAtMs: ({ startMs, switchIntervalMinutes }) =>
    calculateTradingDurationDueAtMs({
      startMs,
      targetDurationMs: switchIntervalMinutes * 60_000,
      calendarSnapshot: postGateRuntime.lastState.tradingCalendarSnapshot,
    }),
  now: () => new Date(),
  scheduleTimer: setTimeout,
  clearTimer: clearTimeout,
});
```

5. Create `timeWakeupRuntime`:

```ts
const timeWakeupRuntime = createTimeWakeupRuntime({
  evaluate: () =>
    runTimeWakeupEvaluation({
      marketDataClient: preGateRuntime.marketDataClient,
      trader: postGateRuntime.trader,
      lastState: postGateRuntime.lastState,
      doomsdayProtection: postGateRuntime.doomsdayProtection,
      tradingConfig: preGateRuntime.tradingConfig,
      monitorContexts: postGateRuntime.monitorContexts,
      monitorTaskQueue: postGateRuntime.monitorTaskQueue,
      tradingGateEventRuntime: postGateRuntime.tradingGateEventRuntime,
      quoteSubscriptionRuntime: postGateRuntime.quoteSubscriptionRuntime,
      dayLifecycleManager,
      periodicSwitchWakeupRuntime,
    }),
  now: () => new Date(),
  scheduleTimer: setTimeout,
  clearTimer: clearTimeout,
  recoveryRetryDelayMs: 1_000,
  logger: appLogger,
});
```

6. Pass both runtimes to cleanup.
7. Create `asyncRuntime` after `periodicSwitchWakeupRuntime` exists, and pass the periodic runtime into `createAsyncRuntime(...)` so `MonitorTaskProcessor` can report `AUTO_SYMBOL_TICK` outcomes back to the periodic owner.

8. Start runtimes in this order:

```ts
if (initialRebuildSucceeded) {
  periodicSwitchWakeupRuntime.start();
}
timeWakeupRuntime.start();
```

`TimeWakeupRuntime` must always start because it is now the only owner that can re-enter `timeWakeupEvaluationProgram` and let `dayLifecycleManager` retry open rebuild. `PeriodicSwitchWakeupRuntime` is not a system-level recovery owner; it is a monitor task producer and must start only with ordinary post-gate business runtimes after initial rebuild succeeds, or later through `signalRuntimeDomain.openRebuild()` after lifecycle rebuild succeeds. On the successful startup path, periodic start must happen before `timeWakeupRuntime.start()` so the periodic owner has subscribed to gate events before the first time evaluation can publish a gate-open transition.

9. Delete the entire `for (;;)` block. After successful startup and runtime start, `runApp(...)` must await `waitForShutdownSignal()`, execute cleanup once through the existing cleanup controller, and then return. Do not rely on implicit timer/subscription liveness as the public lifecycle contract. Do not leave any signal handler in `createCleanup` that directly runs cleanup or calls `process.exit`; `runApp` is the single shutdown owner.

- [ ] **Step 6: Update cleanup**

Modify `src/app/shutdown/createCleanup.ts` so `createCleanup` no longer registers process signal handlers and no longer calls `process.exit`. The cleanup controller should expose cleanup execution only; remove the returned `registerExitHandlers` property to match the updated `CleanupController` type. `runApp` owns when that cleanup is invoked after `waitForShutdownSignal()` resolves.

Modify destructuring to include:

```ts
timeWakeupRuntime,
periodicSwitchWakeupRuntime,
```

Add cleanup steps before stopping downstream processors:

```ts
await runStep('停止 TimeWakeupRuntime', async () => {
  await timeWakeupRuntime.stopAndDrain();
});

await runStep('停止 PeriodicSwitchWakeupRuntime', async () => {
  await periodicSwitchWakeupRuntime.stopAndDrain();
});
```

Place `TimeWakeupRuntime` before `BusinessEventProgram` so no new time actions are scheduled during shutdown. Place `PeriodicSwitchWakeupRuntime` before `MonitorTaskProcessor` so it cannot enqueue new monitor tasks while the processor drains.

- [ ] **Step 7: Run app wiring tests**

Run:

```bash
bun test tests/app/runApp.test.ts
```

Expected: PASS.

---

## 10. Task: Complete Business Chain Tests

**Files:**

- Modify: planner/runtime/lifecycle/timeWakeupEvaluation tests from previous tasks
- Add focused tests where gaps remain

- [ ] **Step 1: Run all new focused tests**

Run:

```bash
bun test tests/main/timeWakeupPlanner/business.test.ts tests/main/timeWakeupRuntime/business.test.ts tests/main/periodicSwitchWakeupRuntime/business.test.ts tests/main/timeWakeupEvaluationProgram/business.test.ts tests/main/lifecycle/dayLifecycleManager.test.ts tests/utils/time.business.test.ts
```

Expected: PASS.

- [ ] **Step 2: Add missing tests from spec checklist**

If not already covered, add these exact focused tests:

1. `tests/main/timeWakeupEvaluationProgram/business.test.ts`
   - `09:30 gate 打开并发布 gate event`
   - `正常日 13:00 gate 重新打开`
   - `pendingOpenRebuild 使用下一可交易日首个连续交易开盘点，不使用当前日过期 09:30`
   - `错日 cachedTradingDayInfo 不会被复用为当前港股日交易日信息`
   - `15:45 买入截止撤单按港股日只提交一次`
   - `15:55 进入清仓接管窗口取消普通延迟验证`
2. `tests/main/timeWakeupPlanner/business.test.ts`
   - `非交易日启动不产生 doomsday/session 动作，并安排下一港股日 00:00`
   - `半日市末日保护边界为 11:45、11:55、12:00`
3. `tests/main/periodicSwitchWakeupRuntime/business.test.ts`
   - `seat 激活、清理、版本变化只重算计划，不标记 waiting empty`
   - `baseline stale 的 task outcome 只清理旧路线，不按旧 symbol/version 重新计划`
   - `gate-open 只重算非 waiting-empty 路线，不能推进 waiting-empty`
   - `同一路线重复 order/freshness 事件通过 scheduleLatest dedupeKey 覆盖`
4. Existing doomsday protection test file, or `tests/core/doomsdayProtection/business.test.ts` only if no reusable harness exists
   - `清仓接管窗口内再次评估不会被当日 one-shot 状态阻断`
   - `清仓接管缺行情连续两轮由返回的 nextRetryAtMs 推进，不依赖内部 setTimeout`

- [ ] **Step 3: Run full test suite**

Run:

```bash
bun test
```

Expected: PASS.

---

## 11. Task: Final TypeScript Validation

**Files:**

- All modified TypeScript and tests

- [ ] **Step 1: Run format**

Run:

```bash
bun format
```

Expected: completes successfully. If it changes files, review changed files before continuing.

- [ ] **Step 2: Run lint**

Run:

```bash
bun lint
```

Expected: PASS. Fix all issues directly; do not suppress with `eslint-disable` unless the codebase already has an exact local precedent and the reason is unavoidable.

- [ ] **Step 3: Run type-check**

Run:

```bash
bun type-check
```

Expected: PASS. Fix all strict type errors without using `any` or broad assertions.

- [ ] **Step 4: Run full tests again**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 5: Optional commit only when requested**

If the user explicitly asks for a commit after implementation and verification, create one new commit that includes the completed implementation and tests. Do not commit automatically as part of this plan.

---

## 12. Self-Review Checklist

Spec coverage:

- [x] 完全移除每秒主循环：Task 9 删除 `for (;;)` 与 `sleep`。
- [x] 单次权威重评估：Task 7 改造 `timeWakeupEvaluationProgram` 返回 plan，Task 8 实现 runtime。
- [x] 开盘保护最小门禁：Task 7 测试 `canTrade=true` 且 `openProtectionActive=true`。
- [x] gate event 顺序：Task 7 测试 lifecycle 后发布。
- [x] 生命周期 retry：Task 3 返回 retry 计划，Task 2 planner 纳入候选。
- [x] 末日保护 retry：Task 6 暴露清仓 retry，Task 7 纳入 planner。
- [x] 周期换标交易时段累计：Task 4 反推到期，Task 5 runtime 使用。
- [x] 周期等待空仓事件闭环：Task 5 order/freshness 重新投递同一 dedupeKey。
- [x] 周期 runtime lifecycle 边界：Task 5/9 将 `PeriodicSwitchWakeupRuntime` 纳入 `signalRuntimeDomain`，只随普通业务 runtime 启停。
- [x] 交易日缓存错日隔离：Task 7 将 `cachedTradingDayInfo` 改为带 `dateKey` 的缓存结构。
- [x] shutdown 单 owner：Task 9 删除 `CleanupController.registerExitHandlers`，由 `runApp` 等待 shutdown signal 后统一 cleanup。
- [x] 不新增统一 EventBus：全计划沿用现有轻量事件口和队列。
- [x] 无新旧双路径兼容：Task 7 删除 `processMonitor` 固定调度入口，Task 9 删除主循环。

Placeholder scan:

- [x] 无 `TBD`、`TODO`、`implement later`。
- [x] 每个代码修改步骤都有明确目标文件、代码形态或精确检查条件。
- [x] 每个测试步骤都有命令与期望结果。

Type consistency:

- [x] `TimeWakeupPlan`、`TimeWakeupEvaluationResult`、`DayLifecycleTickResult` 的命名在后续任务中一致。
- [x] Runtime 接口均使用 `start()` / `stopAndDrain()`，符合现有 runtime 模式。
- [x] 周期换标 route identity 始终为 `monitorSymbol + direction`，任务 dedupeKey 始终为 `monitorSymbol:AUTO_SYMBOL_TICK:direction`。

---

## 13. Execution Notes

1. 实施时每个任务都必须先调用 `typescript-project-specifications` skill，因为会修改 TypeScript 代码。
2. 若测试 harness 中的事件类型字段与真实类型不同，以真实类型为准修正测试，不要放宽生产类型。
3. 交易日历快照字段使用当前真实字段 `lastState.tradingCalendarSnapshot`。
4. 如果现有 doomsday protection 测试路径不同，优先扩展已有测试，不重复创建平行 harness。
5. 不要在实施中新增低频兜底 timer 或保留每秒 loop。
