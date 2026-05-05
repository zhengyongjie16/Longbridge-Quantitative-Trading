/**
 * runApp 业务测试
 *
 * 覆盖：
 * - 启动快照进入 pending open rebuild 时仍启动系统级时间唤醒，但不启动稳态实时链路
 * - 启动初始重建失败时仍启动系统级时间唤醒，并保持稳态实时链路静止
 */
import { beforeEach, describe, expect, it } from 'bun:test';

import { createRunApp } from '../../src/app/runApp.js';
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

type RunAppScenario = 'startupRebuildPending' | 'initialRebuildFails' | 'initialRebuildSucceeds';

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

function createStartRecorder(name: string): { readonly start: () => void } {
  return {
    start: () => {
      recordSteadyRuntimeStart(name);
    },
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

function createMockPostGateRuntime(lastState: LastState): MutableMonitorContextsPostGateRuntime {
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
      start: () => {
        recordSteadyRuntimeStart('postTradeConsistencyRuntime.start');
      },
      completeRebuildBaseline: () => {
        recordSteadyRuntimeStart('postTradeConsistencyRuntime.completeRebuildBaseline');
      },
      stopAndDrain: async () => {},
    },
    lastState,
    trader,
    loadTradingDayRuntimeSnapshot: async () => ({ allOrders: [], quotesMap: new Map() }),
    doomsdayProtection: createDoomsdayProtectionDouble(),
    signalProcessor,
    indicatorCache: {
      clear: () => {},
    },
    buyTaskQueue: {
      enqueue: async () => {},
      dequeue: async () => null,
      size: () => 0,
      clear: () => {},
    },
    sellTaskQueue: {
      enqueue: async () => {},
      dequeue: async () => null,
      size: () => 0,
      clear: () => {},
    },
    monitorTaskQueue: {
      enqueue: async () => {},
      dequeue: async () => null,
      size: () => 0,
      clear: () => {},
    },
  } as unknown as MutableMonitorContextsPostGateRuntime;
}

function createMockAsyncRuntime(): AsyncRuntime {
  return {
    monitorTaskProcessor: createStartRecorder('monitorTaskProcessor.start'),
    buyProcessor: createStartRecorder('buyProcessor.start'),
    sellProcessor: createStartRecorder('sellProcessor.start'),
  } as unknown as AsyncRuntime;
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

function createRunAppHarness(): {
  readonly runApp: RunAppFunction;
  readonly triggerShutdown: () => void;
} {
  const lastState = createMinimalLastState();
  const shutdownController = createShutdownController();
  const deps = {
    createPreGateRuntime: async () => createMockPreGateRuntime(),
    createPostGateRuntime: async () => createMockPostGateRuntime(lastState),
    loadStartupSnapshot: async () => ({
      allOrders: [],
      quotesMap: new Map(),
      startupRebuildPending: currentScenario === 'startupRebuildPending',
      now: new Date('2026-04-29T09:30:00.000+08:00'),
    }),
    collectRuntimeValidationSymbols: () => ({
      requiredSymbols: new Set<string>(),
      runtimeValidationInputs: [],
    }),
    createMonitorContexts: () => {},
    createRebuildTradingDayState: () => async () => {
      rebuildCallCount += 1;
      if (currentScenario === 'initialRebuildFails') {
        throw new Error('initial rebuild failed');
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
      },
    }),
    createTimeWakeupRuntime: () => ({
      start: async () => {
        timeWakeupStartCount += 1;
        runtimeStartSteps.push('timeWakeupRuntime.start.begin');
        await Promise.resolve();
        runtimeStartSteps.push('timeWakeupRuntime.start.end');
      },
      requestEvaluate: () => {},
      stopAndDrain: async () => {},
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
  };
}

async function flushMicrotasks(times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
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

  it('starts only time wakeup runtime when initial rebuild fails after snapshot success', async () => {
    currentScenario = 'initialRebuildFails';
    const harness = createRunAppHarness();

    await runAppAndTriggerShutdown(harness.runApp, harness.triggerShutdown);

    expect(rebuildCallCount).toBe(1);
    expect(startupFailureApplyCount).toBe(1);
    expect(timeWakeupStartCount).toBe(1);
    expect(cleanupExecuteCount).toBe(1);
    expect(steadyRuntimeStarts).toEqual([]);
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
