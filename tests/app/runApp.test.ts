/**
 * app/runApp 组装测试
 *
 * 覆盖：
 * - 正常启动链路保持统一时间源，并保证 postTradeConsistencyRuntime 先 bind 再 start
 * - startupRebuildPending 分支保持应用常驻，由 lifecycle 后续恢复，但不提前启动运行态处理器
 * - startupRebuildPending 与运行时标的验证失败并存时，启动不会被中止
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { createWarrantListCache } from '../../src/services/autoSymbolFinder/utils.js';
import { createRunApp } from '../../src/app/runApp.js';
import type { AppEnvironmentParams, RunAppDeps } from '../../src/app/types.js';
import type { LastState } from '../../src/types/state.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import {
  createMarketDataClientDouble,
  createPositionCacheDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createSdkConfigDouble,
  createTradingGateEventRuntimeDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';
import type { AppTestTaskQueueDouble, MutableRunAppHarnessState } from './types.js';

const STOP_AFTER_FIRST_LOOP = new Error('STOP_AFTER_FIRST_LOOP');

function createLastState(): LastState {
  return {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    currentDayKey: '2026-03-09',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: {
      isTradingDay: true,
      isHalfDay: false,
    },
    tradingCalendarSnapshot: new Map(),
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  };
}

function createTaskQueueDouble(): AppTestTaskQueueDouble {
  return {
    push: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => 0,
    onTaskAdded: () => () => {},
  };
}

function createHarnessState(): MutableRunAppHarnessState {
  return {
    events: [],
    startupRebuildPending: false,
    runtimeGateMode: 'strict',
    preGateRuntimeEnv: null,
    postGateRuntimeEnv: null,
    createPostGateRuntimeNow: null,
    loadStartupSnapshotNow: null,
    rebuildCalls: [],
    rebuildShouldThrow: false,
    completeRebuildBaselineShouldThrow: false,
    registerDelayedCalls: 0,
    cleanupRegistered: 0,
    timeDriverProgramCalls: 0,
    timeDriverProgramRuntimeGateModes: [],
    createBusinessEventProgramHasIndicatorCache: null,
    timeDriverProgramHasIndicatorCache: null,
    sleepDurations: [],
    validationResult: {
      valid: true,
      warnings: [],
      errors: [],
    },
  };
}

function createRunAppDeps(harnessState: MutableRunAppHarnessState): RunAppDeps {
  const warrantListCache = createWarrantListCache();

  return {
    getShushCow: () => {},
    createPreGateRuntime: async (params: AppEnvironmentParams) => {
      harnessState.preGateRuntimeEnv = params.env;
      return {
        config: createSdkConfigDouble(),
        tradingConfig: createTradingConfig({
          monitors: [],
          global: {
            doomsdayProtection: true,
            debug: false,
            openProtection: {
              morning: { enabled: true, minutes: 3 },
              afternoon: { enabled: true, minutes: 3 },
            },
            orderMonitorPriceUpdateInterval: 1,
            allowBuyOrderTrackingAboveInitialPrice: true,
            tradingOrderType: 'ELO',
            liquidationOrderType: 'MO',
            buyOrderTimeout: {
              enabled: true,
              timeoutSeconds: 180,
            },
            sellOrderTimeout: {
              enabled: true,
              timeoutSeconds: 180,
            },
          },
        }),
        symbolRegistry: createSymbolRegistryDouble(),
        warrantListCache,
        warrantListCacheConfig: {
          cache: warrantListCache,
          ttlMs: 60_000,
          nowMs: () => 0,
        },
        marketDataClient: createMarketDataClientDouble({
          getQuoteContext: async () => {
            throw new Error('runApp test should not request quote context');
          },
        }),
        runMode: 'prod',
        gatePolicies: {
          startupGate: 'strict',
          runtimeGate: harnessState.runtimeGateMode,
        },
        startupTradingDayInfo: {
          isTradingDay: true,
          isHalfDay: false,
        },
        startupGate: {
          wait: async () => ({ isTradingDay: true, isHalfDay: false }),
        },
      };
    },
    createPostGateRuntime: async (params) => {
      harnessState.createPostGateRuntimeNow = params.now;
      harnessState.postGateRuntimeEnv = params.env;
      let businessDepsBound = false;
      return {
        liquidationCooldownTracker: {
          recordLiquidationTrigger: () => ({
            currentCount: 1,
            cooldownActivated: false,
          }),
          recordCooldown: () => {},
          restoreTriggerCount: () => {},
          getRemainingMs: () => 0,
          clearMidnightEligible: () => {},
          resetAllTriggerCounts: () => {},
        },
        dailyLossTracker: {
          resetAll: () => {},
          recalculateFromAllOrders: () => {},
          recordFilledOrder: () => {},
          getLossOffset: () => 0,
          startNewProtectionEpisode: () => {},
        },
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
        monitorContexts: new Map(),
        tradingGateEventRuntime: createTradingGateEventRuntimeDouble(),
        quoteSubscriptionRuntime: {
          reconcileFromCurrentTruth: async () => {
            harnessState.events.push('quoteSubscriptionRuntime.reconcileFromCurrentTruth');
          },
          reconcilePositionHoldFromCurrentTruth: async () => {},
          start: () => {
            harnessState.events.push('quoteSubscriptionRuntime.start');
          },
          stopAndDrain: async () => {
            harnessState.events.push('quoteSubscriptionRuntime.stopAndDrain');
          },
          retainSymbols: async () => () => {},
          releaseRetain: async () => {},
          waitForAdmission: async () => {},
        },
        seatActivationDispatcher: {
          start: () => {
            harnessState.events.push('seatActivationDispatcher.start');
          },
          stop: () => {
            harnessState.events.push('seatActivationDispatcher.stop');
          },
        },
        autoSearchWakeupRuntime: {
          start: () => {
            harnessState.events.push('autoSearchWakeupRuntime.start');
          },
          stopAndDrain: async () => {
            harnessState.events.push('autoSearchWakeupRuntime.stopAndDrain');
          },
        },
        tradingRiskEventRuntime: {
          start: () => {
            harnessState.events.push('tradingRiskEventRuntime.start');
          },
          stopAndDrain: async () => {
            harnessState.events.push('tradingRiskEventRuntime.stopAndDrain');
          },
        },
        switchWakeupRuntime: {
          start: () => {
            harnessState.events.push('switchWakeupRuntime.start');
          },
          stopAndDrain: async () => {
            harnessState.events.push('switchWakeupRuntime.stopAndDrain');
          },
          handoffPendingSwitch: () => {},
        },
        monitorQuoteEventRuntime: {
          start: () => {
            harnessState.events.push('monitorQuoteEventRuntime.start');
          },
          stopAndDrain: async () => {
            harnessState.events.push('monitorQuoteEventRuntime.stopAndDrain');
          },
        },
        postTradeConsistencyRuntime: {
          bindBusinessDeps: () => {
            businessDepsBound = true;
            harnessState.events.push('postTradeConsistencyRuntime.bindBusinessDeps');
          },
          recordSettlementRefreshNeed: () => {},
          getStatus: () => ({
            started: false,
            inFlight: false,
            hasPendingRefresh: false,
            currentVersion: 0,
            staleVersion: 0,
            abortReason: null,
          }),
          waitForFresh: async () => {},
          onFreshReached: () => () => {},
          abortWaiting: () => {},
          resetAbort: () => {},
          start: () => {
            if (!businessDepsBound) {
              throw new Error('postTradeConsistencyRuntime.start called before bindBusinessDeps');
            }

            harnessState.events.push('postTradeConsistencyRuntime.start');
          },
          stopAndDrain: async () => {
            harnessState.events.push('postTradeConsistencyRuntime.stopAndDrain');
          },
          midnightClear: () => {
            harnessState.events.push('postTradeConsistencyRuntime.midnightClear');
          },
          completeRebuildBaseline: () => {
            harnessState.events.push('postTradeConsistencyRuntime.completeRebuildBaseline');
            if (harnessState.completeRebuildBaselineShouldThrow) {
              throw new Error('completeRebuildBaseline failed');
            }
          },
        },
        lastState: createLastState(),
        trader: createTraderDouble({
          startOrderMonitorRuntime: () => {
            harnessState.events.push('trader.startOrderMonitorRuntime');
          },
          stopOrderMonitorRuntimeAndDrain: async () => {
            harnessState.events.push('trader.stopOrderMonitorRuntimeAndDrain');
          },
        }),
        tradeLogHydrator: {
          hydrate: () => new Map(),
        },
        loadTradingDayRuntimeSnapshot: async () => ({
          allOrders: [],
          quotesMap: new Map(),
        }),
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        doomsdayProtection: {
          isBuyCutoffWindowActive: () => false,
          executeClearance: async () => ({ executed: false, signalCount: 0 }),
          cancelPendingBuyOrders: async () => ({ executed: false, cancelRequestAcceptedCount: 0 }),
        },
        signalProcessor: {
          processSellSignals: ({ signals }) => signals,
          applyRiskChecks: async (signals) => signals,
          resetRiskCheckCooldown: () => {},
        },
        indicatorCache: {
          push: () => {},
          getClosest: () => null,
          clearAll: () => {},
        },
        buyTaskQueue: createTaskQueueDouble(),
        sellTaskQueue: createTaskQueueDouble(),
        monitorTaskQueue: {
          scheduleLatest: () => {},
          pop: () => null,
          isEmpty: () => true,
          removeTasks: () => 0,
          clearAll: () => 0,
          onTaskAdded: () => () => {},
        },
      };
    },
    loadStartupSnapshot: async (params) => {
      harnessState.loadStartupSnapshotNow = params.now;
      harnessState.events.push('loadStartupSnapshot');
      return {
        allOrders: [],
        quotesMap: new Map(),
        startupRebuildPending: harnessState.startupRebuildPending,
        now: params.now,
      };
    },
    collectRuntimeValidationSymbols: () => ({
      requiredSymbols: new Set(),
      runtimeValidationInputs: [],
    }),
    createMonitorContexts: (_params) => {
      harnessState.events.push('createMonitorContexts');
    },
    createRebuildTradingDayState: () => {
      harnessState.events.push('createRebuildTradingDayState');
      return async (params) => {
        harnessState.events.push('rebuildTradingDayState');
        harnessState.rebuildCalls.push(params);
        if (harnessState.rebuildShouldThrow) {
          throw new Error('rebuildTradingDayState failed');
        }
      };
    },
    displayAccountAndPositions: async () => {},
    registerDelayedSignalHandlers: () => {
      harnessState.registerDelayedCalls += 1;
      harnessState.events.push('registerDelayedSignalHandlers');
    },
    createBusinessEventProgram: (params) => {
      harnessState.createBusinessEventProgramHasIndicatorCache = 'indicatorCache' in params;
      return {
        start: () => {
          harnessState.events.push('businessEventProgram.start');
        },
        stopAndDrain: async () => {
          harnessState.events.push('businessEventProgram.stopAndDrain');
        },
      };
    },
    createAsyncRuntime: () => {
      harnessState.events.push('createAsyncRuntime');
      return {
        monitorTaskProcessor: {
          start: () => {
            harnessState.events.push('monitorTaskProcessor.start');
          },
          stopAndDrain: async () => {},
          restart: () => {},
        },
        buyProcessor: {
          start: () => {
            harnessState.events.push('buyProcessor.start');
          },
          stop: () => {},
          stopAndDrain: async () => {},
          restart: () => {},
        },
        sellProcessor: {
          start: () => {
            harnessState.events.push('sellProcessor.start');
          },
          stop: () => {},
          stopAndDrain: async () => {},
          restart: () => {},
        },
      };
    },
    createLifecycleRuntime: () => {
      harnessState.events.push('createLifecycleRuntime');
      return {
        tick: async () => {},
      };
    },
    createCleanup: () => ({
      execute: async () => {},
      registerExitHandlers: () => {
        harnessState.cleanupRegistered += 1;
        harnessState.events.push('registerExitHandlers');
      },
    }),
    timeDriverProgram: async (params) => {
      harnessState.timeDriverProgramCalls += 1;
      harnessState.timeDriverProgramRuntimeGateModes.push(params.runtimeGateMode);
      harnessState.timeDriverProgramHasIndicatorCache = 'indicatorCache' in params;
      harnessState.events.push('timeDriverProgram');
    },
    sleep: async (ms) => {
      harnessState.sleepDurations.push(ms);
      harnessState.events.push(`sleep:${ms}`);
      throw STOP_AFTER_FIRST_LOOP;
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    formatError: String,
    validateRuntimeSymbolsFromQuotesMap: () => harnessState.validationResult,
    applyStartupSnapshotFailureState: () => {},
  };
}

describe('app runApp assembly', () => {
  let harnessState = createHarnessState();

  beforeEach(() => {
    harnessState = createHarnessState();
  });

  it('uses a shared startup time source and keeps rebuild before delayed-handler registration', async () => {
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.preGateRuntimeEnv?.['APP_RUNTIME_PROFILE']).toBe('test');
    expect(harnessState.postGateRuntimeEnv?.['APP_RUNTIME_PROFILE']).toBe('test');
    expect(harnessState.createPostGateRuntimeNow).toBe(harnessState.loadStartupSnapshotNow);
    expect(harnessState.rebuildCalls).toHaveLength(1);
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'createMonitorContexts',
      'postTradeConsistencyRuntime.bindBusinessDeps',
      'createRebuildTradingDayState',
      'createAsyncRuntime',
      'createLifecycleRuntime',
      'registerDelayedSignalHandlers',
      'registerExitHandlers',
      'rebuildTradingDayState',
      'postTradeConsistencyRuntime.start',
      'postTradeConsistencyRuntime.completeRebuildBaseline',
      'quoteSubscriptionRuntime.reconcileFromCurrentTruth',
      'quoteSubscriptionRuntime.start',
      'seatActivationDispatcher.start',
      'autoSearchWakeupRuntime.start',
      'businessEventProgram.start',
      'tradingRiskEventRuntime.start',
      'monitorQuoteEventRuntime.start',
      'switchWakeupRuntime.start',
      'monitorTaskProcessor.start',
      'buyProcessor.start',
      'sellProcessor.start',
      'trader.startOrderMonitorRuntime',
      'timeDriverProgram',
      'sleep:1000',
    ]);
    expect(harnessState.sleepDurations).toEqual([1000]);
    expect(harnessState.registerDelayedCalls).toBe(1);
    expect(harnessState.cleanupRegistered).toBe(1);
    expect(harnessState.timeDriverProgramCalls).toBe(1);
    expect(harnessState.timeDriverProgramRuntimeGateModes).toEqual(['strict']);
    expect(harnessState.createBusinessEventProgramHasIndicatorCache).toBeTrue();
    expect(harnessState.timeDriverProgramHasIndicatorCache).toBeFalse();
  });

  it('keeps lifecycle alive when startup snapshot switches to pending open rebuild', async () => {
    harnessState.startupRebuildPending = true;
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.createPostGateRuntimeNow).toBe(harnessState.loadStartupSnapshotNow);
    expect(harnessState.rebuildCalls).toHaveLength(0);
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'createMonitorContexts',
      'postTradeConsistencyRuntime.bindBusinessDeps',
      'createRebuildTradingDayState',
      'createAsyncRuntime',
      'createLifecycleRuntime',
      'registerDelayedSignalHandlers',
      'registerExitHandlers',
      'timeDriverProgram',
      `sleep:${harnessState.sleepDurations[0]}`,
    ]);
    expect(harnessState.sleepDurations).toHaveLength(1);
    expect(harnessState.sleepDurations[0]).toBeGreaterThanOrEqual(0);
    expect(harnessState.sleepDurations[0]).toBeLessThanOrEqual(1000);
    expect(harnessState.registerDelayedCalls).toBe(1);
    expect(harnessState.cleanupRegistered).toBe(1);
    expect(harnessState.timeDriverProgramCalls).toBe(1);
    expect(harnessState.timeDriverProgramRuntimeGateModes).toEqual(['strict']);
  });

  it('keeps lifecycle alive in pending-open-rebuild path under skip runtime gate mode', async () => {
    harnessState.startupRebuildPending = true;
    harnessState.runtimeGateMode = 'skip';
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.rebuildCalls).toHaveLength(0);
    expect(harnessState.timeDriverProgramRuntimeGateModes).toEqual(['skip']);
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'createMonitorContexts',
      'postTradeConsistencyRuntime.bindBusinessDeps',
      'createRebuildTradingDayState',
      'createAsyncRuntime',
      'createLifecycleRuntime',
      'registerDelayedSignalHandlers',
      'registerExitHandlers',
      'timeDriverProgram',
      'sleep:1000',
    ]);
  });

  it('does not start order-monitor-related runtimes when rebuildTradingDayState fails', async () => {
    harnessState.rebuildShouldThrow = true;
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('rebuildTradingDayState failed');
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'createMonitorContexts',
      'postTradeConsistencyRuntime.bindBusinessDeps',
      'createRebuildTradingDayState',
      'createAsyncRuntime',
      'createLifecycleRuntime',
      'registerDelayedSignalHandlers',
      'registerExitHandlers',
      'rebuildTradingDayState',
    ]);
    expect(harnessState.timeDriverProgramCalls).toBe(0);
  });

  it('does not start order monitor runtime when completeRebuildBaseline fails', async () => {
    harnessState.completeRebuildBaselineShouldThrow = true;
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('completeRebuildBaseline failed');
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'createMonitorContexts',
      'postTradeConsistencyRuntime.bindBusinessDeps',
      'createRebuildTradingDayState',
      'createAsyncRuntime',
      'createLifecycleRuntime',
      'registerDelayedSignalHandlers',
      'registerExitHandlers',
      'rebuildTradingDayState',
      'postTradeConsistencyRuntime.start',
      'postTradeConsistencyRuntime.completeRebuildBaseline',
    ]);
    expect(harnessState.timeDriverProgramCalls).toBe(0);
  });

  it('does not abort startup in pending-open-rebuild path when runtime symbol validation reports failure', async () => {
    harnessState.startupRebuildPending = true;
    harnessState.validationResult = {
      valid: false,
      warnings: [],
      errors: ['missing quote'],
    };
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.rebuildCalls).toHaveLength(0);
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'createMonitorContexts',
      'postTradeConsistencyRuntime.bindBusinessDeps',
      'createRebuildTradingDayState',
      'createAsyncRuntime',
      'createLifecycleRuntime',
      'registerDelayedSignalHandlers',
      'registerExitHandlers',
      'timeDriverProgram',
      'sleep:1000',
    ]);
    expect(harnessState.timeDriverProgramCalls).toBe(1);
    expect(harnessState.cleanupRegistered).toBe(1);
  });

  it('throws AppStartupAbortError instead of exiting process when runtime symbol validation fails', async () => {
    harnessState.validationResult = {
      valid: false,
      warnings: [],
      errors: ['missing quote'],
    };
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      name: 'AppStartupAbortError',
      message: '运行时标的验证失败，启动已中止',
    });
    expect(harnessState.events).toEqual(['loadStartupSnapshot']);
    expect(harnessState.timeDriverProgramCalls).toBe(0);
    expect(harnessState.cleanupRegistered).toBe(0);
  });

  it('sleeps only for the remaining interval after a short timeDriverProgram run', async () => {
    const originalDateNow = Date.now;
    let nowCallIndex = 0;
    Date.now = () => {
      nowCallIndex += 1;
      return nowCallIndex === 1 ? 1_000 : 1_250;
    };
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (err) {
      caught = err;
    } finally {
      Date.now = originalDateNow;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.sleepDurations).toEqual([750]);
    expect(harnessState.events.at(-1)).toBe('sleep:750');
  });

  it('starts the next tick immediately when a timeDriverProgram run exceeds the interval', async () => {
    const originalDateNow = Date.now;
    let nowCallIndex = 0;
    Date.now = () => {
      nowCallIndex += 1;
      return nowCallIndex === 1 ? 5_000 : 6_250;
    };
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (err) {
      caught = err;
    } finally {
      Date.now = originalDateNow;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.sleepDurations).toEqual([0]);
    expect(harnessState.events.at(-1)).toBe('sleep:0');
  });
});
