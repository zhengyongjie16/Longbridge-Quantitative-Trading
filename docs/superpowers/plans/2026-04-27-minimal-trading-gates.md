# Minimal Trading Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除启动交易日/交易时段/开盘保护整体阻断，将相关判断收敛为运行态最小门禁，并让开盘保护仅阻止普通信号生成。

**Architecture:** 启动阶段只初始化配置、客户端、可靠交易日状态快照、订阅和运行时，不再等待交易窗口；若启动时交易日接口失败，则保持交易日状态 unknown，让运行期 `timeDriverProgram` 继续解析，不把接口异常固化为非交易日。运行期 `timeDriverProgram` 继续维护 `canTrade`、`isHalfDay` 与 `openProtectionActive`。普通信号只在 `runSignalPipeline` 生成前受开盘保护阻断；入队、延迟验证和周期换标不再读取开盘保护作为准入条件；自动寻标、距离换标和风险事件路径经验证本就不读取 `openProtectionActive`，继续只受生命周期、连续交易、末日保护、席位版本和执行层二次门禁约束。

**Tech Stack:** Bun test runner、TypeScript strict mode、Longbridge SDK 4.0.5、现有工厂函数与依赖注入模式。

---

## File Structure

- Modify: `src/app/runtime/createPreGateRuntime.ts`
  - 移除 `createStartupGate` 装配与 `startupGate.wait()` 调用。
  - 启动时只尝试解析一次当前交易日信息；解析成功时返回可靠 `startupTradingDayInfo`，解析失败时返回 `null`，不把接口异常伪装成非交易日。
- Modify: `src/app/types.ts`
  - `GatePolicies` 只表达 `runtimeGate`。
  - `PreGateRuntime.startupTradingDayInfo` 改为 `TradingDayInfo | null`。
  - 更新 `TradingDayInfoResolver` 注释，不再称为 startup gate 专用。
- Modify: `src/app/runtime/createPostGateRuntime.ts`
  - 只有 `startupTradingDayInfo` 非空时才初始化 `cachedTradingDayInfo` 与当日 `tradingCalendarSnapshot`；为空时保持运行态交易日信息 unknown，让 `timeDriverProgram` 首轮继续解析。
- Modify: `src/app/startup/startupModes.ts`
  - 只解析 `RUNTIME_GATE_MODE`。
  - 删除 `STARTUP_GATE_MODE` 语义。
- Delete: `src/main/startup/gate.ts`
- Delete: `src/main/startup/types.ts`
- Delete: `tests/main/startup/gate.test.ts`
- Modify: `src/main/ordinarySignalGuard/index.ts`
  - 删除 `openProtectionActive` 判断与 `LastState` pick 中的字段。
  - 保留 `isTradingEnabled`、`canTrade` 与末日保护清仓接管窗口。
- Modify: `src/services/autoSymbolManager/types.ts`
  - 从 `SwitchOnIntervalParams` 移除 `openProtectionActive`。
- Modify: `src/services/autoSymbolManager/switchStateMachine.ts`
  - `maybeSwitchOnInterval` 不再接收或检查 `openProtectionActive`。
  - 周期换标只保留 `canTradeNow` 门禁。
- Modify: `src/types/monitorContextPorts.ts`
  - 从 `AutoSymbolManagerPort.maybeSwitchOnInterval` 入参移除 `openProtectionActive`。
- Modify: `src/main/asyncProgram/monitorTaskProcessor/types.ts`
  - 从 `AutoSymbolTickTaskData` 移除 `openProtectionActive`。
- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`
  - 调用 `maybeSwitchOnInterval` 时不再传 `openProtectionActive`。
- Modify: `src/main/processMonitor/autoSymbolTasks.ts`
  - `AUTO_SYMBOL_TICK` data 不再携带 `openProtectionActive`。
- Modify: `src/main/processMonitor/index.ts`
  - 不再把 `runtimeFlags.openProtectionActive` 传入 `scheduleAutoSymbolTasks`。
- Modify: `src/main/processMonitor/types.ts`
  - 更新自动换标任务调度参数类型，移除仅用于周期换标的 `openProtectionActive` 字段。
- Modify tests:
  - `tests/app/startup/startupModes.test.ts`
  - `tests/app/runtime/createPreGateRuntime.minimalGate.test.ts`
  - `tests/app/runApp.test.ts`
  - `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts`
  - `tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts`
  - `tests/app/context/createMonitorContexts.business.test.ts`
  - `tests/main/processMonitor/signalPipeline.business.test.ts`
  - `tests/main/ordinarySignalGuard/business.test.ts`
  - `tests/app/wiring/registerDelayedSignalHandlers.business.test.ts`
  - `tests/services/autoSymbolManager/periodicSwitch.business.test.ts`
  - `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`
  - `tests/main/processMonitor/autoSymbolTasks.business.test.ts`
  - 其他搜索发现的 `startupGate` 或 `maybeSwitchOnInterval` 调用点。

---

### Task 1: Remove startup gate policy semantics

**Files:**

- Modify: `src/app/startup/startupModes.ts`
- Modify: `src/app/types.ts`
- Modify: `tests/app/startup/startupModes.test.ts`

- [ ] **Step 1: Update the failing tests for runtime-only gate policy**

Replace `tests/app/startup/startupModes.test.ts` with:

```ts
/**
 * app/startupModes 单元测试
 *
 * 覆盖：
 * - runtime gate 仅由 RUNTIME_GATE_MODE 控制
 */
import { describe, expect, it } from 'bun:test';
import { resolveGatePolicies } from '../../../src/app/startup/startupModes.js';

describe('app startupModes', () => {
  it('defaults runtime gate to strict when env var is absent', () => {
    expect(resolveGatePolicies({})).toEqual({
      runtimeGate: 'strict',
    });
  });

  it('keeps strict runtime gate default in RUN_MODE=dev without explicit override', () => {
    expect(resolveGatePolicies({ RUN_MODE: 'dev' })).toEqual({
      runtimeGate: 'strict',
    });
  });

  it('uses explicit skip only for RUNTIME_GATE_MODE', () => {
    expect(resolveGatePolicies({ STARTUP_GATE_MODE: 'skip' })).toEqual({
      runtimeGate: 'strict',
    });

    expect(resolveGatePolicies({ RUNTIME_GATE_MODE: 'SKIP' })).toEqual({
      runtimeGate: 'skip',
    });
  });
});
```

- [ ] **Step 2: Run the startupModes test and verify it fails**

Run:

```bash
bun test tests/app/startup/startupModes.test.ts
```

Expected: FAIL because `resolveGatePolicies` still returns `startupGate`.

- [ ] **Step 3: Implement runtime-only gate policy**

Change `src/app/startup/startupModes.ts` to:

```ts
/**
 * app 启动模式解析模块
 *
 * 职责：
 * - 从运行时门禁配置解析 runtime gate 策略
 */
import type { GatePolicies } from '../types.js';
import type { GateMode } from '../../types/seat.js';

/**
 * 解析单个门禁模式。仅显式 `skip` 才会跳过门禁，其余值均使用 `strict`。
 *
 * @param rawMode 单个门禁环境变量原始值
 * @returns 门禁模式（strict | skip）
 */
function resolveGateMode(rawMode: string | undefined): GateMode {
  if (typeof rawMode !== 'string') {
    return 'strict';
  }

  const normalized = rawMode.trim().toLowerCase();
  if (normalized === 'skip') {
    return 'skip';
  }

  return 'strict';
}

/**
 * 从环境变量解析 runtime gate 策略。
 *
 * @param env 环境变量对象（如 process.env）
 * @returns 运行时门禁配置
 */
export function resolveGatePolicies(env: NodeJS.ProcessEnv): GatePolicies {
  return {
    runtimeGate: resolveGateMode(env['RUNTIME_GATE_MODE']),
  };
}
```

Update `src/app/types.ts` `GatePolicies` comment and type to:

```ts
/**
 * 运行时门禁策略。
 * 类型用途：表达 runtime gate 策略。
 * 数据来源：由 app 组装层根据 RUNTIME_GATE_MODE 解析生成。
 * 使用范围：app 启动装配链路与 timeDriverProgram 使用。
 */
export type GatePolicies = Readonly<{
  runtimeGate: GateMode;
}>;
```

- [ ] **Step 4: Run the startupModes test and verify it passes**

Run:

```bash
bun test tests/app/startup/startupModes.test.ts
```

Expected: PASS.

---

### Task 2: Make pre-gate runtime initialize without blocking on trading windows

**Files:**

- Modify: `src/app/runtime/createPreGateRuntime.ts`
- Modify: `src/app/lifecycle/rebuild.ts`
- Modify: `src/app/types.ts`
- Modify: `src/app/runtime/createPostGateRuntime.ts`
- Delete: `src/main/startup/gate.ts`
- Delete: `src/main/startup/types.ts`
- Delete: `tests/main/startup/gate.test.ts`
- Create: `tests/app/runtime/createPreGateRuntime.minimalGate.test.ts`
- Modify: `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts`

- [ ] **Step 1: Create an isolated mocked test for non-blocking startup trading day initialization**

Create `tests/app/runtime/createPreGateRuntime.minimalGate.test.ts` with top-level mocks and dynamic import:

```ts
/**
 * createPreGateRuntime 最小启动门禁测试
 *
 * 功能：验证启动阶段只初始化可靠交易日状态，不因非交易日或交易日接口异常阻断 pre-gate runtime 创建。
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import type { AppEnvironmentParams, PreGateRuntime } from '../../../src/app/types.js';

let createPreGateRuntimeImportIndex = 0;
let isTradingDayCalls = 0;
let shouldFailTradingDayResolve = false;

type CreatePreGateRuntimeFunction = (params: AppEnvironmentParams) => Promise<PreGateRuntime>;

type CreatePreGateRuntimeModuleShape = {
  readonly createPreGateRuntime: CreatePreGateRuntimeFunction;
};

void mock.module('../../../src/config/trading/index.js', () => ({
  createMultiMonitorTradingConfig: () => ({
    global: {
      openProtection: {
        morning: { enabled: true, minutes: 15 },
        afternoon: { enabled: true, minutes: 15 },
      },
    },
    monitors: [],
  }),
}));

void mock.module('../../../src/config/validator/index.js', () => ({
  validateAllConfig: async () => {},
}));

void mock.module('../../../src/config/auth/index.js', () => ({
  createSdkConfigFromAuth: async () => ({}),
}));

void mock.module('../../../src/main/utils.js', () => ({
  sleep: async () => {
    throw new Error('startup gate sleep should not be called');
  },
}));

void mock.module('../../../src/services/quoteClient/index.js', () => ({
  createMarketDataClient: async () => ({
    isTradingDay: async () => {
      isTradingDayCalls += 1;
      if (shouldFailTradingDayResolve) {
        throw new Error('trading day service unavailable');
      }

      return { isTradingDay: false, isHalfDay: false };
    },
  }),
}));

async function loadCreatePreGateRuntime(): Promise<CreatePreGateRuntimeFunction> {
  createPreGateRuntimeImportIndex += 1;
  const loadedModule = (await import(
    `../../../src/app/runtime/createPreGateRuntime.js?minimal-gate-test=${createPreGateRuntimeImportIndex}`
  )) as CreatePreGateRuntimeModuleShape;
  return loadedModule.createPreGateRuntime;
}

describe('app createPreGateRuntime minimal startup gate', () => {
  beforeEach(() => {
    isTradingDayCalls = 0;
    shouldFailTradingDayResolve = false;
  });

  it('returns pre-gate runtime even when current day is not a trading day', async () => {
    const createPreGateRuntime = await loadCreatePreGateRuntime();
    const runtime = await createPreGateRuntime({ env: {} });

    expect(runtime.startupTradingDayInfo).toEqual({
      isTradingDay: false,
      isHalfDay: false,
    });
    expect(runtime.gatePolicies).toEqual({
      runtimeGate: 'strict',
    });
    expect(isTradingDayCalls).toBe(1);
  });

  it('keeps startup trading day unknown when trading day resolution fails', async () => {
    shouldFailTradingDayResolve = true;
    const createPreGateRuntime = await loadCreatePreGateRuntime();
    const runtime = await createPreGateRuntime({ env: {} });

    expect(runtime.startupTradingDayInfo).toBeNull();
    expect(runtime.gatePolicies).toEqual({
      runtimeGate: 'strict',
    });
    expect(isTradingDayCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run the new isolated test and verify it fails**

Run:

```bash
bun test tests/app/runtime/createPreGateRuntime.minimalGate.test.ts
```

Expected: FAIL with `startup gate sleep should not be called`, proving the old startup gate still tries to wait instead of returning the pre-gate runtime.

- [ ] **Step 3: Make TradingDayInfoResolver preserve unknown on API failure**

In `src/app/lifecycle/rebuild.ts`, change the resolver catch block from returning a synthetic non-trading day to rethrowing the original failure:

```ts
    } catch (err) {
      onResolveError(err);
      throw err;
    }
```

Do not write `cachedTradingDayInfo` in the failure path. A failed boundary call means the state is unknown, not reliably non-trading.

- [ ] **Step 4: Allow nullable startup trading day state in app types**

In `src/app/types.ts`, update `TradingDayInfoResolver` comments to:

```ts
 * 类型用途：统一交易日信息解析函数类型。
 * 数据来源：由 createTradingDayInfoResolver 创建并返回。
 * 使用范围：app 启动状态初始化与生命周期交易日状态更新。
```

Update `PreGateRuntime.startupTradingDayInfo` to:

```ts
startupTradingDayInfo: TradingDayInfo | null;
```

- [ ] **Step 5: Change createPreGateRuntime to resolve once instead of wait**

In `src/app/runtime/createPreGateRuntime.ts`:

1. Change the constants import from:

```ts
import { AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS, TRADING } from '../../constants/index.js';
```

to:

```ts
import { AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS } from '../../constants/index.js';
```

2. Remove imports:

```ts
import { createStartupGate } from '../../main/startup/gate.js';
import { sleep } from '../../main/utils.js';
import {
  getHKDateKey,
  isInContinuousHKSession,
  isWithinAfternoonOpenProtection,
  isWithinMorningOpenProtection,
} from '../../utils/time/index.js';
```

3. Add this narrower import:

```ts
import { getHKDateKey } from '../../utils/time/index.js';
```

4. Set the `onResolveError` log message to:

```ts
logger.warn('启动交易日信息解析失败，运行期将继续解析', formatError(err));
```

5. Replace the `startupGate` creation and `startupGate.wait(...)` call with:

```ts
let startupTradingDayInfo: PreGateRuntime['startupTradingDayInfo'] = null;
try {
  startupTradingDayInfo = await resolveTradingDayInfo(new Date());
} catch {
  startupTradingDayInfo = null;
}
```

The function must still return `startupTradingDayInfo` in the `PreGateRuntime` object.

- [ ] **Step 6: Initialize post-gate trading calendar only from reliable startup info**

In `src/app/runtime/createPostGateRuntime.ts`, keep `cachedTradingDayInfo` assigned from `startupTradingDayInfo`, and change the initial calendar snapshot to:

```ts
    cachedTradingDayInfo: startupTradingDayInfo,
    tradingCalendarSnapshot:
      startupTradingDayInfo === null ? new Map() : new Map([[initialDayKey, startupTradingDayInfo]]),
```

This preserves the runtime `timeDriverProgram` retry path because `cachedTradingDayInfo === null` still enters strict-mode trading day resolution on the first runtime tick.

Update any `PreGateRuntime` test double that constructs `startupTradingDayInfo` to use either a real `TradingDayInfo` object or `null`; do not use a synthetic `{ isTradingDay: false, isHalfDay: false }` for API failure cases.

- [ ] **Step 7: Update comments that still describe pre-gate as a blocking startup gate**

In `src/app/runtime/createPreGateRuntime.ts`, update the file header responsibilities to:

```ts
 * - 执行配置校验、行情客户端创建与启动交易日状态初始化
```

Update the return comment to:

```ts
 * @returns 已完成启动前依赖创建与交易日状态初始化的 pre-gate runtime
```

In `src/app/lifecycle/rebuild.ts`, change the resolver JSDoc line to:

```ts
 * @returns 可直接用于启动状态初始化与运行期交易日状态更新的 resolveTradingDayInfo 函数
```

Update `CachedTradingDayInfo` comments in `src/app/types.ts` so its使用范围不再限定为 startup gate，例如：

```ts
 * 使用范围：app 启动状态初始化与运行期交易日状态更新。
```

- [ ] **Step 8: Delete obsolete startup gate module and test**

Delete these files:

```bash
rm "src/main/startup/gate.ts" "src/main/startup/types.ts" "tests/main/startup/gate.test.ts"
```

- [ ] **Step 9: Run targeted pre-gate, post-gate, and startup mode tests**

Run:

```bash
bun test tests/app/runtime/createPreGateRuntime.test.ts tests/app/runtime/createPreGateRuntime.minimalGate.test.ts tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts tests/app/startup/startupModes.test.ts
```

Expected: PASS.

---

### Task 3: Keep opening protection only at signal generation boundary

**Files:**

- Modify: `src/main/ordinarySignalGuard/index.ts`
- Modify: `src/main/businessEventProgram/signalPipeline.ts`
- Modify: `tests/main/processMonitor/signalPipeline.business.test.ts`
- Create: `tests/main/ordinarySignalGuard/business.test.ts`
- Modify: `tests/app/wiring/registerDelayedSignalHandlers.business.test.ts`

- [ ] **Step 1: Strengthen signalPipeline test to prove strategy is not called during opening protection**

In `tests/main/processMonitor/signalPipeline.business.test.ts`, change `createPipelineHarness` return type to include `getGenerateSignalsCallCount`:

```ts
}): {
  buyTaskQueue: ReturnType<typeof createBuyTaskQueue>;
  sellTaskQueue: ReturnType<typeof createSellTaskQueue>;
  delayedAdded: Signal[];
  getGenerateSignalsCallCount: () => number;
} {
```

Add a local counter before `monitorContext`:

```ts
let generateSignalsCallCount = 0;
```

Change the strategy double to:

```ts
    strategy: {
      generateSignals: () => {
        generateSignalsCallCount += 1;
        return {
          immediateSignals: params.immediateSignals,
          delayedSignals: params.delayedSignals,
        };
      },
    },
```

Return the getter:

```ts
    getGenerateSignalsCallCount: () => generateSignalsCallCount,
```

Update the opening protection test to assert:

```ts
expect(harness.getGenerateSignalsCallCount()).toBe(0);
```

- [ ] **Step 2: Add a direct ordinarySignalGuard regression test for the remaining shared gates**

Create `tests/main/ordinarySignalGuard/business.test.ts`:

```ts
/**
 * ordinarySignalGuard 业务测试
 *
 * 功能：验证普通信号入队门禁只复用生命周期、连续交易与末日保护接管语义。
 */
import { describe, expect, it } from 'bun:test';

import { ordinarySignalGuard } from '../../../src/main/ordinarySignalGuard/index.js';

describe('ordinarySignalGuard minimal gate', () => {
  it('allows ordinary signal admission when lifecycle and continuous trading gates are open', () => {
    const allowed = ordinarySignalGuard({
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
        isHalfDay: false,
      },
      now: new Date('2026-02-16T01:31:00.000Z'),
      doomsdayProtectionEnabled: false,
    });

    expect(allowed).toBe(true);
  });

  it('still rejects when lifecycle or continuous trading gate is closed', () => {
    expect(
      ordinarySignalGuard({
        lastState: {
          isTradingEnabled: false,
          canTrade: true,
          isHalfDay: false,
        },
        now: new Date('2026-02-16T01:31:00.000Z'),
        doomsdayProtectionEnabled: false,
      }),
    ).toBe(false);

    expect(
      ordinarySignalGuard({
        lastState: {
          isTradingEnabled: true,
          canTrade: false,
          isHalfDay: false,
        },
        now: new Date('2026-02-16T01:31:00.000Z'),
        doomsdayProtectionEnabled: false,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 3: Add delayed verification admission coverage without opening protection**

In `tests/app/wiring/registerDelayedSignalHandlers.business.test.ts`, import the existing full-state helper:

```ts
import { createLastState } from '../../main/asyncProgram/utils.js';
```

Add a test that registers a verified `BUYCALL` signal with the full runtime state still carrying opening protection:

```ts
      lastState: createLastState({
        isTradingEnabled: true,
        canTrade: true,
        openProtectionActive: true,
        isHalfDay: false,
      }),
```

Use the same callback capture and queue doubles as the existing HOLD test, invoke the verified callback with `createSignalDouble('BUYCALL', 'BULL.HK')`, and assert one buy task is enqueued. This test proves delayed verification admission no longer reads opening protection even though `LastState` still records it for signal generation display/state. The test should keep the real `LastState` boundary visible through `createLastState`.

- [ ] **Step 4: Run ordinary signal tests and verify the delayed admission test fails**

Run:

```bash
bun test tests/main/processMonitor/signalPipeline.business.test.ts tests/main/ordinarySignalGuard/business.test.ts tests/app/wiring/registerDelayedSignalHandlers.business.test.ts
```

Expected: FAIL because the delayed verification test sets the full runtime `lastState.openProtectionActive` to true, and the old `ordinarySignalGuard` still rejects that signal before it can enter the buy queue.

- [ ] **Step 5: Remove opening protection from ordinarySignalGuard**

Change `src/main/ordinarySignalGuard/index.ts` to:

```ts
/**
 * ordinarySignalGuard 模块
 *
 * 职责：
 * - 统一普通信号链路的共享准入判断
 * - 复用 lifecycle / 连续交易 / 清仓接管窗口三类门禁
 * - 保持纯函数，不持有任何 owner 私有运行态
 */
import { isWithinDoomsdayClearanceTakeoverWindow } from '../../core/doomsdayProtection/utils.js';
import type { LastState } from '../../types/state.js';

/**
 * 普通信号共享门禁判断参数。
 *
 * @param lastState 全局运行时状态
 * @param now 当前判定时刻
 * @param doomsdayProtectionEnabled 是否启用末日保护清仓接管门禁
 * @returns 门禁打开时返回 true
 */
export function ordinarySignalGuard(params: {
  readonly lastState: Pick<LastState, 'isTradingEnabled' | 'canTrade' | 'isHalfDay'>;
  readonly now: Date;
  readonly doomsdayProtectionEnabled: boolean;
}): boolean {
  const { lastState, now, doomsdayProtectionEnabled } = params;

  if (!lastState.isTradingEnabled || lastState.canTrade !== true) {
    return false;
  }

  if (!doomsdayProtectionEnabled) {
    return true;
  }

  return !isWithinDoomsdayClearanceTakeoverWindow(now, lastState.isHalfDay ?? false);
}
```

- [ ] **Step 6: Keep opening protection in signalPipeline before strategy generation**

Keep this behavior in `src/main/businessEventProgram/signalPipeline.ts`:

```ts
if (openProtectionActive) {
  return;
}
```

Search `src/main/businessEventProgram/signalPipeline.ts` for comments referencing `ordinarySignalGuard` and opening protection; keep comments aligned with the rule that opening protection is applied before `strategy.generateSignals`.

- [ ] **Step 7: Run ordinary signal tests**

Run:

```bash
bun test tests/main/processMonitor/signalPipeline.business.test.ts tests/main/ordinarySignalGuard/business.test.ts tests/app/wiring/registerDelayedSignalHandlers.business.test.ts
```

Expected: PASS.

---

### Task 4: Remove opening protection from periodic switch inputs and behavior

**Files:**

- Modify: `src/services/autoSymbolManager/types.ts`
- Modify: `src/services/autoSymbolManager/switchStateMachine.ts`
- Modify: `src/types/monitorContextPorts.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/types.ts`
- Modify: `src/main/processMonitor/types.ts`
- Modify: `src/main/processMonitor/autoSymbolTasks.ts`
- Modify: `src/main/processMonitor/index.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`
- Modify tests and test doubles that pass `openProtectionActive` to `maybeSwitchOnInterval` or expect it in `AUTO_SYMBOL_TICK` payloads

- [ ] **Step 1: Add periodic switch regression that exposes the old opening-protection block**

Append this failing regression inside `describe('periodic auto-switch regression', () => { ... })` in `tests/services/autoSymbolManager/periodicSwitch.business.test.ts`:

```ts
it('case2-3: periodic trigger ignores opening protection when trading session gate is open', async () => {
  const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
  const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
  const harness = createPeriodicHarness({
    switchIntervalMinutes: 1,
    nowMs,
    lastSeatActivatedAt: readyMs,
    findBestSymbol: 'NEW_BULL.HK',
  });

  await harness.machine.maybeSwitchOnInterval({
    direction: 'LONG',
    currentTime: new Date(nowMs),
    canTradeNow: true,
    openProtectionActive: true,
  });

  const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
  expect(seat.status).toBe('ACTIVATING');
  expect(seat.symbol).toBe('NEW_BULL.HK');
});
```

This first uses the current API to prove the existing behavior is wrong. Step 7 later updates this same regression to the final API boundary with no `openProtectionActive` property.

- [ ] **Step 2: Run the periodic switch regression and verify it fails**

Run:

```bash
bun test tests/services/autoSymbolManager/periodicSwitch.business.test.ts
```

Expected: FAIL because the old `maybeSwitchOnInterval` still returns `NOOP` when `openProtectionActive` is true.

- [ ] **Step 3: Remove openProtectionActive from SwitchOnIntervalParams**

In `src/services/autoSymbolManager/types.ts`, replace `SwitchOnIntervalParams` with:

```ts
/**
 * 周期换标触发检查入参。
 * 类型用途：包含方向、当前时间与交易时段状态，由 switchStateMachine.maybeSwitchOnInterval 消费。
 * 使用范围：autoSymbolManager 模块及其调用方使用。
 */
export type SwitchOnIntervalParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly currentTime: Date;
  readonly canTradeNow: boolean;
};
```

- [ ] **Step 4: Remove openProtectionActive from AutoSymbolManagerPort**

In `src/types/monitorContextPorts.ts`, change `AutoSymbolManagerPort.maybeSwitchOnInterval` from:

```ts
maybeSwitchOnInterval: (params: {
  readonly direction: 'LONG' | 'SHORT';
  readonly currentTime: Date;
  readonly canTradeNow: boolean;
  readonly openProtectionActive: boolean;
}) => Promise<SwitchDriveResult>;
```

to:

```ts
maybeSwitchOnInterval: (params: {
  readonly direction: 'LONG' | 'SHORT';
  readonly currentTime: Date;
  readonly canTradeNow: boolean;
}) => Promise<SwitchDriveResult>;
```

- [ ] **Step 5: Remove openProtectionActive checks from switchStateMachine**

In `src/services/autoSymbolManager/switchStateMachine.ts`, change the function destructuring from:

```ts
  async function maybeSwitchOnInterval({
    direction,
    currentTime,
    canTradeNow,
    openProtectionActive,
  }: SwitchOnIntervalParams): Promise<SwitchDriveResult> {
```

to:

```ts
  async function maybeSwitchOnInterval({
    direction,
    currentTime,
    canTradeNow,
  }: SwitchOnIntervalParams): Promise<SwitchDriveResult> {
```

Replace both gate checks:

```ts
if (!canTradeNow || openProtectionActive) {
  return createNoopDriveResult();
}
```

and

```ts
if (!canTradeNow || openProtectionActive) {
  return createNoopDriveResult();
}
```

with:

```ts
if (!canTradeNow) {
  return createNoopDriveResult();
}
```

and:

```ts
if (!canTradeNow) {
  return createNoopDriveResult();
}
```

- [ ] **Step 6: Remove openProtectionActive from monitor task data**

In `src/main/asyncProgram/monitorTaskProcessor/types.ts`, remove `readonly openProtectionActive: boolean;` from `AutoSymbolTickTaskData`.

In `src/main/processMonitor/types.ts`, remove `readonly openProtectionActive: boolean;` from `AutoSymbolTasksParams`. Do not remove `ProcessMonitorParams.runtimeFlags.openProtectionActive`; ordinary signal generation still reads it through `runSignalPipeline`.

In `src/main/processMonitor/autoSymbolTasks.ts`, remove `openProtectionActive` from destructuring and from both scheduled task `data` objects.

In `src/main/processMonitor/index.ts`, remove this argument from the `scheduleAutoSymbolTasks` call:

```ts
    openProtectionActive: runtimeFlags.openProtectionActive,
```

In `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`, change:

```ts
const intervalResult = await context.autoSymbolManager.maybeSwitchOnInterval({
  direction: data.direction,
  currentTime: new Date(data.currentTimeMs),
  canTradeNow: data.canTradeNow,
  openProtectionActive: data.openProtectionActive,
});
```

to:

```ts
const intervalResult = await context.autoSymbolManager.maybeSwitchOnInterval({
  direction: data.direction,
  currentTime: new Date(data.currentTimeMs),
  canTradeNow: data.canTradeNow,
});
```

- [ ] **Step 7: Update all tests that call maybeSwitchOnInterval to the final signature**

Search `src` and `tests` for `openProtectionActive:` in TypeScript files.

For calls to `maybeSwitchOnInterval`, remove the `openProtectionActive` property across unit tests, integration tests, and `tests/helpers/testDoubles.ts`. Do not remove `openProtectionActive` from `timeDriverProgram`, `runSignalPipeline`, `LastState`, or signal pipeline tests.

Examples in `tests/services/autoSymbolManager/periodicSwitch.business.test.ts` should become:

```ts
await harness.machine.maybeSwitchOnInterval({
  direction: 'LONG',
  currentTime: new Date(nowMs),
  canTradeNow: true,
});
```

After Steps 3-6 remove the field from production types and handlers, update the Step 1 regression to the final signature with no `openProtectionActive` property while keeping the same assertion that periodic switch proceeds.

- [ ] **Step 8: Update autoSymbolTasks test expectation**

In `tests/main/processMonitor/autoSymbolTasks.business.test.ts`, remove `openProtectionActive` from expected scheduled `AUTO_SYMBOL_TICK` payloads. Keep `canTradeNow`.

- [ ] **Step 9: Run periodic switch and monitor task tests**

Run:

```bash
bun test tests/services/autoSymbolManager/periodicSwitch.business.test.ts tests/services/autoSymbolManager/switchStateMachine.business.test.ts tests/main/asyncProgram/monitorTaskProcessor/business.test.ts tests/main/processMonitor/autoSymbolTasks.business.test.ts
```

Expected: PASS. These tests cover the direct periodic switch API boundary, monitor task payload, and task processor behavior affected by removing `openProtectionActive`.

---

### Task 5: Fix GatePolicies startupGate references after type change

**Files:**

- Modify: `tests/app/runApp.test.ts`
- Modify: `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts`
- Modify: `tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts`
- Modify: `tests/app/context/createMonitorContexts.business.test.ts`
- Modify other `GatePolicies` test doubles found by repository search

- [ ] **Step 1: Search stale startupGate policy references**

Search `src` and `tests` TypeScript files for `startupGate`.

Expected after Tasks 1-2 and before Task 5 implementation: remaining lowercase `startupGate` matches should be limited to test doubles such as `tests/app/runApp.test.ts`, `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts`, `tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts`, and `tests/app/context/createMonitorContexts.business.test.ts`. `STARTUP_GATE_MODE` may remain only in `tests/app/startup/startupModes.test.ts` as an ignored environment variable assertion.

- [ ] **Step 2: Remove startupGate from test doubles**

In `tests/app/runApp.test.ts`, change the pre-gate runtime double from:

```ts
        gatePolicies: {
          startupGate: 'strict',
          runtimeGate: harnessState.runtimeGateMode,
        },
```

to:

```ts
        gatePolicies: {
          runtimeGate: harnessState.runtimeGateMode,
        },
```

In `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts`, change:

```ts
      gatePolicies: {
        startupGate: 'strict',
        runtimeGate: 'strict',
      },
```

to:

```ts
      gatePolicies: {
        runtimeGate: 'strict',
      },
```

Apply the same removal to every other `gatePolicies` object found by Step 1. Do not keep `startupGate` as an ignored field.

- [ ] **Step 3: Run app assembly and runtime tests**

Run:

```bash
bun test tests/app/runApp.test.ts tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts tests/app/context/createMonitorContexts.business.test.ts tests/app/runtime/createPreGateRuntime.test.ts tests/app/runtime/createPreGateRuntime.minimalGate.test.ts tests/app/startup/startupModes.test.ts
```

Expected: PASS.

---

### Task 6: Verify obsolete startup gate files and imports are removed

**Files:**

- Delete: `src/main/startup/gate.ts`
- Delete: `src/main/startup/types.ts`
- Delete: `tests/main/startup/gate.test.ts`
- No additional files expected after prior tasks

- [ ] **Step 1: Confirm obsolete startup gate files were deleted**

Confirm these paths no longer exist in the working tree:

```text
src/main/startup/gate.ts
src/main/startup/types.ts
tests/main/startup/gate.test.ts
```

- [ ] **Step 2: Search for obsolete imports**

Search `src` and `tests` TypeScript files for `main/startup/gate|main/startup/types|createStartupGate|StartupGate`.

Expected: no matches after Task 2 and file deletion.

- [ ] **Step 3: Run type-check to verify no stale type references remain**

Run:

```bash
bun type-check
```

Expected: PASS. Remaining failures indicate the earlier cleanup missed a direct reference to deleted startup gate types or `GatePolicies.startupGate`; update only those direct references, then rerun this step.

---

### Task 7: Final validation

**Files:**

- Validation should not require code changes after Tasks 1-6; any failure must map directly to startup gate removal, runtime gate policy simplification, ordinary signal opening-protection boundary, periodic switch opening-protection removal, or verified paths that should not read opening protection.

- [ ] **Step 1: Run the targeted gate test suite**

Run:

```bash
bun test tests/app/startup/startupModes.test.ts tests/app/runtime/createPreGateRuntime.test.ts tests/app/runtime/createPreGateRuntime.minimalGate.test.ts tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts tests/main/processMonitor/signalPipeline.business.test.ts tests/main/ordinarySignalGuard/business.test.ts tests/app/wiring/registerDelayedSignalHandlers.business.test.ts tests/services/autoSymbolManager/periodicSwitch.business.test.ts tests/services/autoSymbolManager/switchStateMachine.business.test.ts tests/main/asyncProgram/monitorTaskProcessor/business.test.ts tests/main/processMonitor/autoSymbolTasks.business.test.ts tests/app/runApp.test.ts tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts tests/app/context/createMonitorContexts.business.test.ts
```

Expected: PASS. This suite covers the direct behavior touched by startup gate removal, runtime gate policy simplification, ordinary signal opening-protection boundary, delayed admission, periodic switch boundary, and app wiring type changes.

- [ ] **Step 2: Run static validation**

Run:

```bash
bun type-check
```

Expected: PASS. Remaining failures indicate a missed direct reference to deleted startup gate types, `GatePolicies.startupGate`, or removed `openProtectionActive` payload fields.

- [ ] **Step 3: Review diff for scope control**

Run:

```bash
git diff -- src tests docs/superpowers/plans/2026-04-27-minimal-trading-gates.md
```

Expected: diff only covers startup gate removal, runtime gate policy simplification, ordinary signal opening-protection boundary, periodic switch opening-protection removal, and directly related tests/comments.

- [ ] **Step 4: Optional release-gate regression**

Run this only when preparing the branch for merge or when the targeted suite exposes behavior that may affect broader orchestration:

```bash
bun lint
bun test tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts tests/integration/main-loop-latency.integration.test.ts tests/integration/full-business-simulation.integration.test.ts tests/integration/doomsday.integration.test.ts
bun test
```

Expected: PASS. This is a release-gate regression, not a required step for each task in the minimal gate implementation.

---

## 2026-04-28 Alignment Addendum: Startup Auto-Search Admission

本补充用于后续检查对齐：最小交易门禁重构移除了启动交易日、交易时段和普通开盘保护的整体阻断，但这不代表启动 / 开盘重建期间的空席位同步自动寻标可以无门禁执行。空席位同步自动寻标是主动选择交易标的的业务动作，必须继续遵守自动寻标自己的准入规则。

### Correct Rule

启动 / 开盘重建同步空席位自动寻标只有在以下条件同时满足时才能执行：

1. `lastState.cachedTradingDayInfo?.isTradingDay === true`，交易日状态必须可靠且明确为交易日。
2. `isInContinuousHKSession(currentTime, tradingDayInfo.isHalfDay)` 为 true，当前必须处于港股连续交易时段。
3. `!isWithinMorningOpenProtection(currentTime, autoSearchOpenDelayMinutes)` 为 true，早盘必须已经越过自动寻标自身的开盘延迟窗口。

因此默认 5 分钟延迟下：

- 09:29 HK：不寻标。
- 09:30-09:34 HK：不寻标。
- 09:35 HK 起：允许寻标。
- 13:00 HK：正常交易日下午连续交易时段允许寻标。
- 非交易日或交易日状态 unknown：系统仍可启动，但不执行同步自动寻标。

交易日状态 unknown 时不寻标不是 fallback，也不是把启动恢复为整体阻断；这是因为自动寻标的必要事实输入不成立。后续运行期仍由 `timeDriverProgram` 继续解析交易日状态，并通过现有事件驱动 wakeup 链路触发空席位自动寻标。

### Files Added to Scope

- Modify: `src/main/recovery/types.ts`
  - `PrepareSeatsForRuntimeDeps` 增加 `resolveCanAutoSearchNow`，用于表达启动 / 开盘重建同步空席位自动寻标准入。
- Modify: `src/main/recovery/seatPreparation.ts`
  - `prepareSeatsForRuntime` 不再直接使用 `isWithinMorningOpenProtection` 判断同步寻标。
  - 空席位恢复只消费 `resolveCanAutoSearchNow({ currentTime, openDelayMinutes })` 的结果。
- Modify: `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
  - 注入 `resolveCanAutoSearchNow`，组合 `cachedTradingDayInfo`、`isInContinuousHKSession` 与 `isWithinMorningOpenProtection`。
  - 不新增交易日 API 查询，不改变 `requireTradingDay` 语义。
- Modify: `tests/main/recovery/seatPreparation.business.test.ts`
  - 覆盖 resolver 拒绝时不请求权证列表、席位保持 EMPTY；resolver 允许时执行同步自动寻标并进入 ACTIVATING。
- Modify: `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`
  - 覆盖真实启动形态：`requireTradingDay: false` 且依赖已有 `lastState.cachedTradingDayInfo`。
  - 验证 09:31 不寻标、09:35 寻标，并确认启动路径不会额外调用 `isTradingDay`。
- Modify: `tests/integration/auto-search-policy-consistency.integration.test.ts`
  - 适配 `prepareSeatsForRuntime` 新的准入依赖，保持自动寻标策略一致性测试语义不变。

### Must Not Regress

后续检查不得把本修复误改为以下任一方案：

- 恢复 `src/main/startup/gate.ts` 或 `STARTUP_GATE_MODE`。
- 让启动重新整体阻断在交易日、交易时段或普通开盘保护之前。
- 把普通 `openProtectionActive` 传入自动寻标。
- 只传全局 `canTradeNow` 来决定同步自动寻标，因为它无法表达早盘自动寻标延迟。
- 在 `seatPreparation` 内部重新查询交易日。
- 修改运行期 `autoSearchWakeupRuntime` 的事件驱动和 `OPEN_DELAY_TIMER` 机制来掩盖启动同步寻标问题。
- 为 unknown 交易日状态增加 fallback、兼容 shim 或配置开关。

### Verification Added

本补充对应的验证命令：

```bash
bun test tests/main/recovery/seatPreparation.business.test.ts
bun test tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts
bun test tests/integration/auto-search-policy-consistency.integration.test.ts
bun format
bun lint
bun type-check
```

Expected: PASS.

---

## Self-Review

- Spec coverage: startup no longer blocks on trading day/session/opening protection; startup trading day API failure remains `unknown` instead of being cached as non-trading; runtime `canTrade` remains; opening protection remains before `strategy.generateSignals`; `ordinarySignalGuard` no longer expands opening protection to入队/延迟回调；周期换标 no longer receives or checks `openProtectionActive`; auto search、distance switch 与 risk event paths remain outside the opening-protection gate scope; lifecycle/order execution gates remain untouched.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation steps remain.
- Type consistency: `GatePolicies` has only `runtimeGate`; `PreGateRuntime.startupTradingDayInfo` is `TradingDayInfo | null`; `SwitchOnIntervalParams` and `AutoSymbolManagerPort.maybeSwitchOnInterval` have only `direction/currentTime/canTradeNow`; `AutoSymbolTickTaskData` no longer carries `openProtectionActive`; `ordinarySignalGuard` no longer accepts `openProtectionActive`.
- Scope control: plan deletes the obsolete startup gate directly and keeps only the new runtime gate policy, reliable startup trading day snapshot semantics, ordinary signal generation boundary, and periodic switch trading-session gate.
