/**
 * runApp 业务测试
 *
 * 覆盖：
 * - 启动快照进入 pending open rebuild 时仍启动系统级时间唤醒，但不启动稳态实时链路
 * - 启动初始重建失败时仍启动系统级时间唤醒，并保持稳态实时链路静止
 */
import { beforeEach, describe, expect, it } from 'bun:test';

import { createRunApp } from '../../src/app/runApp.js';
import { createExternalApiRequestError } from '../../src/utils/apiFailure/index.js';
import type {
  AppEnvironmentParams,
  AsyncRuntime,
  CleanupController,
  MutableMonitorContextsPostGateRuntime,
  PreGateRuntime,
  RunAppDeps,
} from '../../src/app/types.js';
import type {
  ProcessSellSignalsParams,
  SignalProcessor,
} from '../../src/core/signalProcessor/types.js';
import type { TaskQueue } from '../../src/main/asyncProgram/tradeTaskQueue/types.js';
import type {
  WarrantListCache,
  WarrantListCacheEntry,
  WarrantListItem,
} from '../../src/services/autoSymbolFinder/types.js';
import type { Signal } from '../../src/types/signal.js';
import type { LastState } from '../../src/types/state.js';
import type { RiskCheckContext } from '../../src/types/services.js';
import {
  createAutoSearchWakeupRuntimeDouble,
  createDailyLossTrackerDouble,
  createDoomsdayProtectionDouble,
  createLiquidationCooldownTrackerDouble,
  createMarketDataClientDouble,
  createPeriodicSwitchWakeupRuntimeDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteSubscriptionRuntimeDouble,
  createSdkConfigDouble,
  createSeatActivationDispatcherDouble,
  createSeatRuntimeCleanupDispatcherDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createTradingGateEventRuntimeDouble,
} from '../helpers/testDoubles.js';

type RunAppScenario =
  | 'startupRebuildPending'
  | 'initialRebuildApiFails'
  | 'initialRebuildFails'
  | 'initialRebuildSucceeds';

let currentScenario: RunAppScenario = 'startupRebuildPending';
let startupFailureApplyCount = 0;
let rebuildCallCount = 0;
let timeWakeupStartCount = 0;
let cleanupExecuteCount = 0;
let steadyRuntimeStarts: string[] = [];
let runtimeStartSteps: string[] = [];

type RunAppFunction = (params: AppEnvironmentParams) => Promise<void>;

function createMinimalLastState(): LastState {
  return {
    canTrade: false,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-04-29',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: {
      update: () => {},
      get: () => null,
    },
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  };
}

function recordSteadyRuntimeStart(name: string): void {
  steadyRuntimeStarts.push(name);
  runtimeStartSteps.push(name);
}

function createProcessorRecorder(name: string): AsyncRuntime['buyProcessor'] {
  return {
    start: () => {
      recordSteadyRuntimeStart(name);
    },
    stop: () => {},
    stopAndDrain: async () => {},
    restart: () => {},
  };
}

function createMonitorTaskProcessorRecorder(name: string): AsyncRuntime['monitorTaskProcessor'] {
  return {
    start: () => {
      recordSteadyRuntimeStart(name);
    },
    stopAndDrain: async () => {},
    restart: () => {},
  };
}

function createStartStopRecorder(name: string): {
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
} {
  return {
    start: () => {
      recordSteadyRuntimeStart(name);
    },
    stopAndDrain: async () => {},
  };
}

function noop(): void {}

async function noopAsync(): Promise<void> {}

function createTradeTaskQueueDouble<TType extends string>(): TaskQueue<TType> {
  return {
    push: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => 0,
    onTaskAdded: () => noop,
  };
}

function createMonitorTaskQueueDouble(): MutableMonitorContextsPostGateRuntime['monitorTaskQueue'] {
  return {
    scheduleLatest: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => 0,
    onTaskAdded: () => noop,
  };
}

function createMockPreGateRuntime(): PreGateRuntime {
  const warrantListEntries = new Map<string, WarrantListCacheEntry>();
  const warrantListInFlight = new Map<string, Promise<ReadonlyArray<WarrantListItem>>>();
  const warrantListCache: WarrantListCache = {
    getEntry: (key) => warrantListEntries.get(key),
    setEntry: (key, entry) => {
      warrantListEntries.set(key, entry);
    },
    getInFlight: (key) => warrantListInFlight.get(key),
    setInFlight: (key, request) => {
      warrantListInFlight.set(key, request);
    },
    deleteInFlight: (key) => {
      warrantListInFlight.delete(key);
    },
    clear: () => {
      warrantListEntries.clear();
      warrantListInFlight.clear();
    },
  };

  return {
    config: createSdkConfigDouble(),
    tradingConfig: {
      monitors: [],
      global: {
        doomsdayProtection: true,
        debug: false,
        openProtection: {
          morning: { enabled: false, minutes: null },
          afternoon: { enabled: false, minutes: null },
        },
        orderMonitorPriceUpdateInterval: 1,
        allowBuyOrderTrackingAboveInitialPrice: false,
        tradingOrderType: 'ELO',
        liquidationOrderType: 'ELO',
        buyOrderTimeout: { enabled: false, timeoutSeconds: 0 },
        sellOrderTimeout: { enabled: false, timeoutSeconds: 0 },
      },
    },
    symbolRegistry: createSymbolRegistryDouble(),
    warrantListCache,
    warrantListCacheConfig: {
      cache: warrantListCache,
      ttlMs: 60_000,
      nowMs: () => 0,
    },
    marketDataClient: createMarketDataClientDouble(),
    startupTradingDayInfo: null,
  };
}

function createMockPostGateRuntime(
  lastState: LastState,
  autoSearchFatalPromise: Promise<never> = new Promise<never>(() => {}),
  postTradeFatalPromise: Promise<never> = new Promise<never>(() => {}),
): MutableMonitorContextsPostGateRuntime {
  const signalProcessor: SignalProcessor = {
    processSellSignals: ({ signals }: ProcessSellSignalsParams): Signal[] => signals,
    applyRiskChecks: async (signals: Signal[], _context: RiskCheckContext): Promise<Signal[]> =>
      signals,
    resetRiskCheckCooldown: () => {},
  };

  const quoteSubscriptionRuntime = createQuoteSubscriptionRuntimeDouble({
    reconcileFromCurrentTruth: async () => {
      recordSteadyRuntimeStart('quoteSubscriptionRuntime.reconcileFromCurrentTruth');
    },
    start: () => {
      recordSteadyRuntimeStart('quoteSubscriptionRuntime.start');
    },
  });
  const trader = createTraderDouble({
    startOrderMonitorRuntime: () => {
      recordSteadyRuntimeStart('trader.startOrderMonitorRuntime');
    },
  });

  return {
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    dailyLossTracker: createDailyLossTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    monitorContexts: new Map(),
    tradingGateEventRuntime: createTradingGateEventRuntimeDouble({
      onGateStateChanged: () => noop,
    }),
    quoteSubscriptionRuntime,
    seatActivationDispatcher: createSeatActivationDispatcherDouble({
      start: () => {
        recordSteadyRuntimeStart('seatActivationDispatcher.start');
      },
    }),
    seatRuntimeCleanupDispatcher: createSeatRuntimeCleanupDispatcherDouble({
      start: () => {
        recordSteadyRuntimeStart('seatRuntimeCleanupDispatcher.start');
      },
    }),
    autoSearchWakeupRuntime: createAutoSearchWakeupRuntimeDouble({
      start: () => {
        recordSteadyRuntimeStart('autoSearchWakeupRuntime.start');
      },
      drainFatalError: () => autoSearchFatalPromise,
    }),
    periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeDouble({
      start: () => {
        recordSteadyRuntimeStart('periodicSwitchWakeupRuntime.start');
      },
    }),
    tradingRiskEventRuntime: createStartStopRecorder('tradingRiskEventRuntime.start'),
    monitorQuoteEventRuntime: createStartStopRecorder('monitorQuoteEventRuntime.start'),
    monitorDisplayRuntime: {
      ...createStartStopRecorder('monitorDisplayRuntime.start'),
      requestRender: () => {},
    },
    tradingQuoteDisplayRuntime: createStartStopRecorder('tradingQuoteDisplayRuntime.start'),
    switchWakeupRuntime: {
      ...createStartStopRecorder('switchWakeupRuntime.start'),
      handoffPendingSwitch: () => {},
    },
    postTradeConsistencyRuntime: {
      bindBusinessDeps: noop,
      recordSettlementRefreshNeed: () => {},
      getStatus: () => ({ started: false, currentVersion: 0, staleVersion: 0 }),
      waitForFresh: async () => {},
      onFreshReached: () => noop,
      abortWaiting: () => {},
      resetAbort: () => {},
      start: () => {
        recordSteadyRuntimeStart('postTradeConsistencyRuntime.start');
      },
      completeRebuildBaseline: () => {
        recordSteadyRuntimeStart('postTradeConsistencyRuntime.completeRebuildBaseline');
      },
      drainFatalError: () => postTradeFatalPromise,
      stopAndDrain: async () => {},
      midnightClear: () => {},
    },
    lastState,
    trader,
    loadTradingDayRuntimeSnapshot: async () => ({ allOrders: [], quotesMap: new Map() }),
    doomsdayProtection: createDoomsdayProtectionDouble(),
    signalProcessor,
    indicatorCache: {
      push: () => {},
      getClosest: () => null,
      clearAll: () => {},
    },
    buyTaskQueue: createTradeTaskQueueDouble(),
    sellTaskQueue: createTradeTaskQueueDouble(),
    monitorTaskQueue: createMonitorTaskQueueDouble(),
    drainFatalError: () => new Promise<never>(() => {}),
  };
}

function createMockAsyncRuntime(): AsyncRuntime {
  return {
    monitorTaskProcessor: createMonitorTaskProcessorRecorder('monitorTaskProcessor.start'),
    buyProcessor: createProcessorRecorder('buyProcessor.start'),
    sellProcessor: createProcessorRecorder('sellProcessor.start'),
    drainFatalError: () => new Promise<never>(() => {}),
  };
}

function createShutdownController(): {
  readonly waitForShutdownSignal: () => Promise<void>;
  readonly triggerShutdown: () => void;
} {
  let resolveShutdown: (() => void) | null = null;
  const shutdownPromise = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  return {
    waitForShutdownSignal: () => shutdownPromise,
    triggerShutdown: () => {
      resolveShutdown?.();
    },
  };
}

function createRunAppHarness(
  options: {
    readonly rejectTimeWakeupDuringStart?: boolean;
    readonly cleanupError?: Error;
  } = {},
): {
  readonly runApp: RunAppFunction;
  readonly triggerShutdown: () => void;
  readonly triggerTimeWakeupFatal: (error: Error) => void;
  readonly triggerAutoSearchFatal: (error: Error) => void;
  readonly triggerPostTradeFatal: (error: Error) => void;
} {
  const lastState = createMinimalLastState();
  const shutdownController = createShutdownController();
  let rejectTimeWakeupFatal: ((error: Error) => void) | null = null;
  let rejectAutoSearchFatal: ((error: Error) => void) | null = null;
  let rejectPostTradeFatal: ((error: Error) => void) | null = null;
  const timeWakeupFatalPromise = new Promise<never>((_, reject) => {
    rejectTimeWakeupFatal = reject;
  });
  const autoSearchFatalPromise = new Promise<never>((_, reject) => {
    rejectAutoSearchFatal = reject;
  });
  const postTradeFatalPromise = new Promise<never>((_, reject) => {
    rejectPostTradeFatal = reject;
  });
  const deps = {
    createPreGateRuntime: async () => createMockPreGateRuntime(),
    createPostGateRuntime: async () =>
      createMockPostGateRuntime(lastState, autoSearchFatalPromise, postTradeFatalPromise),
    loadStartupSnapshot: async () => {
      const now = new Date('2026-04-29T09:30:00.000+08:00');
      if (currentScenario === 'startupRebuildPending') {
        return { kind: 'API_RETRY_PENDING', now };
      }

      return {
        kind: 'READY',
        allOrders: [],
        quotesMap: new Map(),
        now,
      };
    },
    collectRuntimeValidationSymbols: () => ({
      requiredSymbols: new Set<string>(),
      runtimeValidationInputs: [],
    }),
    createMonitorContexts: () => {},
    createRebuildTradingDayState: () => async () => {
      rebuildCallCount += 1;
      if (currentScenario === 'initialRebuildApiFails') {
        throw createExternalApiRequestError({
          operation: 'test.initialRebuild',
          attempts: 1,
          cause: new Error('initial rebuild api unavailable'),
        });
      }

      if (currentScenario === 'initialRebuildFails') {
        throw new TypeError('initial rebuild contract broken');
      }
    },
    displayAccountAndPositions: noopAsync,
    registerDelayedSignalHandlers: noop,
    createBusinessEventProgram: () => ({
      ...createStartStopRecorder('businessEventProgram.start'),
    }),
    createAsyncRuntime: () => createMockAsyncRuntime(),
    createLifecycleRuntime: () => ({
      tick: async () => ({ nextRetryAtMs: null, pendingOpenRebuild: false }),
    }),
    createCleanup: (): CleanupController => ({
      execute: async () => {
        cleanupExecuteCount += 1;
        if (options.cleanupError !== undefined) {
          throw options.cleanupError;
        }
      },
    }),
    createTimeWakeupRuntime: () => ({
      start: async () => {
        timeWakeupStartCount += 1;
        runtimeStartSteps.push('timeWakeupRuntime.start.begin');
        if (options.rejectTimeWakeupDuringStart === true) {
          rejectTimeWakeupFatal?.(new Error('time wakeup initial fatal'));
        }

        await Promise.resolve();
        runtimeStartSteps.push('timeWakeupRuntime.start.end');
      },
      requestEvaluate: () => {},
      stopAndDrain: async () => {},
      drainFatalError: () => timeWakeupFatalPromise,
      getStateSnapshot: () => ({
        running: false,
        inFlight: false,
        dirty: false,
        hasTimer: false,
      }),
    }),
    waitForShutdownSignal: shutdownController.waitForShutdownSignal,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    formatError: String,
    validateRuntimeSymbolsFromQuotesMap: () => ({
      valid: true,
      warnings: [],
      errors: [],
    }),
    applyStartupSnapshotFailureState: () => {
      startupFailureApplyCount += 1;
    },
  } satisfies RunAppDeps;

  return {
    runApp: createRunApp(deps),
    triggerShutdown: shutdownController.triggerShutdown,
    triggerTimeWakeupFatal: (error) => {
      rejectTimeWakeupFatal?.(error);
    },
    triggerAutoSearchFatal: (error) => {
      rejectAutoSearchFatal?.(error);
    },
    triggerPostTradeFatal: (error) => {
      rejectPostTradeFatal?.(error);
    },
  };
}

async function flushMicrotasks(times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

async function expectPromiseRejectsWithMessage(
  promise: Promise<unknown>,
  expectedMessagePattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw new Error(`[测试] 预期 Promise 以 Error 拒绝，实际为: ${String(error)}`, {
        cause: error,
      });
    }

    expect(error.message).toMatch(expectedMessagePattern);
    return;
  }

  throw new Error('[测试] 预期 Promise 拒绝，但实际成功');
}

async function runAppAndTriggerShutdown(
  runApp: RunAppFunction,
  triggerShutdown: () => void,
): Promise<void> {
  const runPromise = runApp({ env: {} });
  await flushMicrotasks(20);
  triggerShutdown();
  await runPromise;
}

describe('runApp business flow', () => {
  beforeEach(() => {
    currentScenario = 'startupRebuildPending';
    startupFailureApplyCount = 0;
    rebuildCallCount = 0;
    timeWakeupStartCount = 0;
    cleanupExecuteCount = 0;
    steadyRuntimeStarts = [];
    runtimeStartSteps = [];
  });

  it('starts only time wakeup runtime when startup snapshot stays pending open rebuild', async () => {
    currentScenario = 'startupRebuildPending';
    const harness = createRunAppHarness();

    await runAppAndTriggerShutdown(harness.runApp, harness.triggerShutdown);

    expect(rebuildCallCount).toBe(0);
    expect(startupFailureApplyCount).toBe(0);
    expect(timeWakeupStartCount).toBe(1);
    expect(cleanupExecuteCount).toBe(1);
    expect(steadyRuntimeStarts).toEqual([]);
  });

  it('starts only time wakeup runtime when initial rebuild API request fails after snapshot success', async () => {
    currentScenario = 'initialRebuildApiFails';
    const harness = createRunAppHarness();

    await runAppAndTriggerShutdown(harness.runApp, harness.triggerShutdown);

    expect(rebuildCallCount).toBe(1);
    expect(startupFailureApplyCount).toBe(1);
    expect(timeWakeupStartCount).toBe(1);
    expect(cleanupExecuteCount).toBe(1);
    expect(steadyRuntimeStarts).toEqual([]);
  });

  it('fails fast when initial rebuild throws a non API error after snapshot success', async () => {
    currentScenario = 'initialRebuildFails';
    const harness = createRunAppHarness();

    await expectPromiseRejectsWithMessage(
      harness.runApp({ env: {} }),
      /initial rebuild contract broken/,
    );

    expect(rebuildCallCount).toBe(1);
    expect(startupFailureApplyCount).toBe(0);
    expect(timeWakeupStartCount).toBe(0);
    expect(cleanupExecuteCount).toBe(1);
    expect(steadyRuntimeStarts).toEqual([]);
  });

  it('time wakeup fatal triggers cleanup and propagates the error', async () => {
    currentScenario = 'startupRebuildPending';
    const harness = createRunAppHarness();
    const runPromise = harness.runApp({ env: {} });

    await flushMicrotasks(20);
    harness.triggerTimeWakeupFatal(new Error('time wakeup fatal'));

    await expectPromiseRejectsWithMessage(runPromise, /time wakeup fatal/);
    expect(cleanupExecuteCount).toBe(1);
  });

  it('auto search fatal triggers cleanup and propagates the error', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness();
    const runPromise = harness.runApp({ env: {} });

    await flushMicrotasks(20);
    harness.triggerAutoSearchFatal(new Error('auto search fatal'));

    await expectPromiseRejectsWithMessage(runPromise, /auto search fatal/);
    expect(cleanupExecuteCount).toBe(1);
  });

  it('post-trade consistency fatal triggers cleanup and propagates the error', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness();
    const runPromise = harness.runApp({ env: {} });

    await flushMicrotasks(20);
    harness.triggerPostTradeFatal(new Error('post trade fatal'));
    await flushMicrotasks(5);
    harness.triggerShutdown();

    await expectPromiseRejectsWithMessage(runPromise, /post trade fatal/);
    expect(cleanupExecuteCount).toBe(1);
  });

  it('time wakeup fatal during initial evaluation prevents ordinary K line business events', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness({ rejectTimeWakeupDuringStart: true });

    await expectPromiseRejectsWithMessage(harness.runApp({ env: {} }), /time wakeup initial fatal/);

    expect(cleanupExecuteCount).toBe(1);
    expect(steadyRuntimeStarts).not.toContain('businessEventProgram.start');
  });

  it('time wakeup fatal remains the propagated error when cleanup also fails', async () => {
    currentScenario = 'startupRebuildPending';
    const harness = createRunAppHarness({ cleanupError: new Error('cleanup failed') });
    const runPromise = harness.runApp({ env: {} });

    await flushMicrotasks(20);
    harness.triggerTimeWakeupFatal(new Error('time wakeup fatal before cleanup'));

    await expectPromiseRejectsWithMessage(runPromise, /time wakeup fatal before cleanup/);
    expect(cleanupExecuteCount).toBe(1);
  });

  it('awaits initial time wakeup evaluation before starting ordinary K line business events', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness();

    await runAppAndTriggerShutdown(harness.runApp, harness.triggerShutdown);

    const timeWakeupEvaluatedIndex = runtimeStartSteps.indexOf('timeWakeupRuntime.start.end');
    const businessEventStartIndex = runtimeStartSteps.indexOf('businessEventProgram.start');
    expect(timeWakeupStartCount).toBe(1);
    expect(timeWakeupEvaluatedIndex).toBeGreaterThan(-1);
    expect(businessEventStartIndex).toBeGreaterThan(timeWakeupEvaluatedIndex);
    expect(runtimeStartSteps).toContain('trader.startOrderMonitorRuntime');
  });
});
