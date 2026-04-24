/**
 * app/runApp 组装测试
 *
 * 覆盖：
 * - 正常启动链路保持顶层装配顺序与 bind-before-start 语义
 * - startupRebuildPending 分支保持应用常驻，但不提前启动运行态处理器
 * - runtime symbol validation 失败时直接中止启动
 * - 主循环 sleep 仅等待剩余间隔，超时则立即进入下一轮
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { createRunApp } from '../../src/app/runApp.js';
import type {
  AppEnvironmentParams,
  CreatePostGateRuntimeParams,
  RunAppDeps,
} from '../../src/app/types.js';
import type { BusinessEventProgramDeps } from '../../src/main/businessEventProgram/types.js';
import { TRADING } from '../../src/constants/index.js';
import type { ProcessSellSignalsParams } from '../../src/core/signalProcessor/types.js';
import { createWarrantListCache } from '../../src/services/autoSymbolFinder/utils.js';
import type { Quote } from '../../src/types/quote.js';
import type { RawOrderFromAPI } from '../../src/types/services.js';
import type { LastState } from '../../src/types/state.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import {
  createMarketDataClientDouble,
  createPositionCacheDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createSdkConfigDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createTradingGateEventRuntimeDouble,
} from '../helpers/testDoubles.js';
import type { AppTestTaskQueueDouble, MutableRunAppHarnessState } from './types.js';

const STOP_AFTER_FIRST_LOOP = new Error('STOP_AFTER_FIRST_LOOP');

let harnessState = createHarnessState();

/**
 * 构造 runApp 测试使用的最小 LastState。
 *
 * @returns 可供 app 装配链路复用的最小状态快照
 */
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

/**
 * 创建 app 测试任务队列替身。
 *
 * @returns 仅提供最小队列接口的测试替身
 */
function createTaskQueueDouble(): AppTestTaskQueueDouble {
  return {
    push: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => 0,
    onTaskAdded: () => createOnTaskAddedHandle(),
  };
}

/**
 * 创建 runApp 测试 harness 状态。
 *
 * @returns 可在单个用例内累计事件与统计的可变状态
 */
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
    createBusinessEventProgramHasMonitorDisplayRuntime: null,
    timeDriverProgramHasIndicatorCache: null,
    sleepDurations: [],
    validationResult: {
      valid: true,
      warnings: [],
      errors: [],
    },
  };
}

function createRetainHandle(): () => void {
  return () => {};
}

function createOnFreshReachedHandle(): () => void {
  return () => {};
}

function createOnTaskAddedHandle(): () => void {
  return () => {};
}

/**
 * 创建 runApp 顶层依赖替身。
 *
 * @returns 可直接注入 createRunApp 的受控依赖集合
 */
function createRunAppDeps(): RunAppDeps {
  return {
    createPreGateRuntime: async (params: AppEnvironmentParams) => {
      harnessState.preGateRuntimeEnv = params.env;
      const warrantListCache = createWarrantListCache();
      return {
        config: createSdkConfigDouble(),
        tradingConfig: createTradingConfig({ monitors: [] }),
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
    createPostGateRuntime: async (params: CreatePostGateRuntimeParams) => {
      harnessState.createPostGateRuntimeNow = params.now;
      harnessState.postGateRuntimeEnv = params.env;
      const bindState = { value: false };
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
          retainSymbols: async () => createRetainHandle(),
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
        monitorDisplayRuntime: {
          start: () => {
            harnessState.events.push('monitorDisplayRuntime.start');
          },
          requestRender: () => {
            harnessState.events.push('monitorDisplayRuntime.requestRender');
          },
          stopAndDrain: async () => {
            harnessState.events.push('monitorDisplayRuntime.stopAndDrain');
          },
        },
        tradingQuoteDisplayRuntime: {
          start: () => {
            harnessState.events.push('tradingQuoteDisplayRuntime.start');
          },
          stopAndDrain: async () => {
            harnessState.events.push('tradingQuoteDisplayRuntime.stopAndDrain');
          },
        },
        postTradeConsistencyRuntime: {
          bindBusinessDeps: () => {
            bindState.value = true;
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
          onFreshReached: () => createOnFreshReachedHandle(),
          abortWaiting: () => {},
          resetAbort: () => {},
          start: () => {
            if (!bindState.value) {
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
          renderTradingQuote: () => {},
          renderMonitorIndicators: () => {},
        },
        doomsdayProtection: {
          isBuyCutoffWindowActive: () => false,
          executeClearance: async () => ({ executed: false, signalCount: 0 }),
          cancelPendingBuyOrders: async () => ({ executed: false, cancelRequestAcceptedCount: 0 }),
        },
        signalProcessor: {
          processSellSignals: ({ signals }: ProcessSellSignalsParams) => [...signals],
          applyRiskChecks: async (signals) => [...signals],
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
          onTaskAdded: () => createOnTaskAddedHandle(),
        },
      };
    },
    loadStartupSnapshot: async (params: { readonly now: Date }) => {
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
      requiredSymbols: new Set<string>(),
      runtimeValidationInputs: [],
    }),
    createMonitorContexts: () => {
      harnessState.events.push('createMonitorContexts');
    },
    createRebuildTradingDayState: () => {
      harnessState.events.push('createRebuildTradingDayState');
      return async (params: {
        readonly allOrders: ReadonlyArray<RawOrderFromAPI>;
        readonly quotesMap: ReadonlyMap<string, Quote | null>;
        readonly now?: Date;
      }) => {
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
    createBusinessEventProgram: (params: BusinessEventProgramDeps) => {
      harnessState.events.push('createBusinessEventProgram');
      harnessState.createBusinessEventProgramHasIndicatorCache = 'indicatorCache' in params;
      harnessState.createBusinessEventProgramHasMonitorDisplayRuntime =
        'monitorDisplayRuntime' in params;
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
    createCleanup: () => {
      harnessState.events.push('createCleanup');
      return {
        execute: async () => {},
        registerExitHandlers: () => {
          harnessState.cleanupRegistered += 1;
          harnessState.events.push('registerExitHandlers');
        },
      };
    },
    timeDriverProgram: async (params: {
      readonly runtimeGateMode: 'strict' | 'skip';
      readonly lastState: LastState;
      readonly indicatorCache?: unknown;
    }) => {
      harnessState.timeDriverProgramCalls += 1;
      harnessState.timeDriverProgramRuntimeGateModes.push(params.runtimeGateMode);
      harnessState.timeDriverProgramHasIndicatorCache = 'indicatorCache' in params;
      params.lastState.canTrade = true;
      harnessState.events.push('timeDriverProgram');
    },
    sleep: async (ms: number) => {
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
  beforeEach(() => {
    harnessState = createHarnessState();
  });

  it('preserves startup ordering and bind-before-start semantics on the happy path', async () => {
    const runApp = createRunApp(createRunAppDeps());
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.createPostGateRuntimeNow).toBe(harnessState.loadStartupSnapshotNow);
    expect(harnessState.rebuildCalls).toHaveLength(1);
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'createMonitorContexts',
      'postTradeConsistencyRuntime.bindBusinessDeps',
      'createRebuildTradingDayState',
      'createAsyncRuntime',
      'createBusinessEventProgram',
      'createLifecycleRuntime',
      'registerDelayedSignalHandlers',
      'createCleanup',
      'registerExitHandlers',
      'rebuildTradingDayState',
      'postTradeConsistencyRuntime.start',
      'postTradeConsistencyRuntime.completeRebuildBaseline',
      'quoteSubscriptionRuntime.reconcileFromCurrentTruth',
      'tradingQuoteDisplayRuntime.start',
      'quoteSubscriptionRuntime.start',
      'seatActivationDispatcher.start',
      'autoSearchWakeupRuntime.start',
      'monitorDisplayRuntime.start',
      'businessEventProgram.start',
      'tradingRiskEventRuntime.start',
      'monitorQuoteEventRuntime.start',
      'switchWakeupRuntime.start',
      'monitorTaskProcessor.start',
      'buyProcessor.start',
      'sellProcessor.start',
      'trader.startOrderMonitorRuntime',
      'timeDriverProgram',
      `sleep:${TRADING.INTERVAL_MS}`,
    ]);
    expect(harnessState.registerDelayedCalls).toBe(1);
    expect(harnessState.cleanupRegistered).toBe(1);
    expect(harnessState.timeDriverProgramRuntimeGateModes).toEqual(['strict']);
    expect(harnessState.createBusinessEventProgramHasMonitorDisplayRuntime).toBe(true);
  });

  it('keeps the app alive during startupRebuildPending without starting runtime processors', async () => {
    harnessState.startupRebuildPending = true;
    harnessState.validationResult = {
      valid: false,
      warnings: [],
      errors: ['missing quote'],
    };
    const runApp = createRunApp(createRunAppDeps());
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.rebuildCalls).toHaveLength(0);
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'createMonitorContexts',
      'postTradeConsistencyRuntime.bindBusinessDeps',
      'createRebuildTradingDayState',
      'createAsyncRuntime',
      'createBusinessEventProgram',
      'createLifecycleRuntime',
      'registerDelayedSignalHandlers',
      'createCleanup',
      'registerExitHandlers',
      'timeDriverProgram',
      `sleep:${harnessState.sleepDurations[0]}`,
    ]);
    expect(harnessState.sleepDurations).toHaveLength(1);
    expect(harnessState.sleepDurations[0]).toBeGreaterThanOrEqual(0);
    expect(harnessState.sleepDurations[0]).toBeLessThanOrEqual(TRADING.INTERVAL_MS);
    expect(harnessState.timeDriverProgramRuntimeGateModes).toEqual(['strict']);
  });

  it('fails fast with AppStartupAbortError when runtime symbol validation fails', async () => {
    harnessState.validationResult = {
      valid: false,
      warnings: [],
      errors: ['missing quote'],
    };
    const runApp = createRunApp(createRunAppDeps());
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('AppStartupAbortError');
    expect((caught as Error).message).toBe('运行时标的验证失败，启动已中止');
    expect(harnessState.rebuildCalls).toHaveLength(0);
    expect(harnessState.events).toEqual(['loadStartupSnapshot']);
  });

  it('sleeps only for the remaining interval after a short loop iteration', async () => {
    const realDateNow = Date.now;
    const dateNowValues = [10_000, 10_050];
    let dateNowIndex = 0;
    Date.now = () => {
      const next = dateNowValues[Math.min(dateNowIndex, dateNowValues.length - 1)];
      dateNowIndex += 1;
      return next ?? 0;
    };
    const runApp = createRunApp(createRunAppDeps());
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (error) {
      caught = error;
    } finally {
      Date.now = realDateNow;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.sleepDurations).toEqual([TRADING.INTERVAL_MS - 50]);
    expect(harnessState.timeDriverProgramCalls).toBe(1);
  });

  it('starts the next iteration immediately when a loop iteration exceeds the interval', async () => {
    const realDateNow = Date.now;
    const dateNowValues = [20_000, 21_500];
    let dateNowIndex = 0;
    Date.now = () => {
      const next = dateNowValues[Math.min(dateNowIndex, dateNowValues.length - 1)];
      dateNowIndex += 1;
      return next ?? 0;
    };
    const runApp = createRunApp(createRunAppDeps());
    let caught: unknown = null;

    try {
      await runApp({ env: {} });
    } catch (error) {
      caught = error;
    } finally {
      Date.now = realDateNow;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.sleepDurations).toEqual([0]);
    expect(harnessState.timeDriverProgramCalls).toBe(1);
  });
});
