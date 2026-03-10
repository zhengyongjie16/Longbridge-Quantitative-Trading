/**
 * app/runApp 组装测试
 *
 * 覆盖：
 * - 正常启动链路保持统一时间源与关键装配顺序
 * - startupRebuildPending 分支会跳过首次重建，但仍完成后续装配
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { createConfig } from '../../src/config/config.index.js';
import { createWarrantListCache } from '../../src/services/autoSymbolFinder/utils.js';
import { createRunApp } from '../../src/app/runApp.js';
import type { AppEnvironmentParams, RunAppDeps } from '../../src/app/types.js';
import type { LastState } from '../../src/types/state.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import {
  createMarketDataClientDouble,
  createPositionCacheDouble,
  createSymbolRegistryDouble,
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
    createPostGateRuntimeNow: null,
    loadStartupSnapshotNow: null,
    rebuildCalls: [],
    registerDelayedCalls: 0,
    cleanupRegistered: 0,
    mainProgramCalls: 0,
    mainProgramRuntimeGateModes: [],
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
    createPreGateRuntime: async (_params: AppEnvironmentParams) => ({
      config: createConfig({ env: {} }),
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
    }),
    createPostGateRuntime: async (params) => {
      harnessState.createPostGateRuntimeNow = params.now;
      const refreshGateStatus = {
        currentVersion: 3,
        staleVersion: 7,
      };

      return {
        liquidationCooldownTracker: {
          recordLiquidationTrigger: () => ({
            currentCount: 1,
            cooldownActivated: false,
          }),
          recordCooldown: () => {},
          restoreTriggerCount: () => {},
          getRemainingMs: () => 0,
          sweepExpired: () => [],
          clearMidnightEligible: () => {},
          resetAllTriggerCounts: () => {},
        },
        dailyLossTracker: {
          resetAll: () => {},
          recalculateFromAllOrders: () => {},
          recordFilledOrder: () => {},
          getLossOffset: () => 0,
          resetDirectionSegment: () => {},
        },
        monitorContexts: new Map(),
        lossOffsetLifecycleCoordinator: {
          sync: async () => {},
        },
        refreshGate: {
          markStale: () => 0,
          markFresh: (version: number) => {
            harnessState.events.push(`markFresh:${version}`);
          },
          waitForFresh: async () => {},
          getStatus: () => refreshGateStatus,
        },
        lastState: createLastState(),
        trader: {
          orderRecorder: {
            recordLocalBuy: () => {},
            recordLocalSell: () => {},
            clearBuyOrders: () => {},
            getLatestBuyOrderPrice: () => null,
            getLatestSellRecord: () => null,
            getSellRecordByOrderId: () => null,
            fetchAllOrdersFromAPI: async () => [],
            refreshOrdersFromAllOrdersForLong: async () => [],
            refreshOrdersFromAllOrdersForShort: async () => [],
            clearOrdersCacheForSymbol: () => {},
            getBuyOrdersForSymbol: () => [],
            submitSellOrder: () => {},
            updatePendingSell: () => null,
            markSellFilled: () => null,
            markSellPartialFilled: () => null,
            markSellCancelled: () => null,
            getPendingSellSnapshot: () => [],
            allocateRelatedBuyOrderIdsForRecovery: () => [],
            getCostAveragePrice: () => null,
            selectSellableOrders: () => ({
              orders: [],
              totalQuantity: 0,
            }),
            resetAll: () => {},
          },
          getAccountSnapshot: async () => null,
          getStockPositions: async () => [],
          getPendingOrders: async () => [],
          seedOrderHoldSymbols: () => {},
          getOrderHoldSymbols: () => new Set(),
          cancelOrder: async () => ({
            kind: 'CANCEL_CONFIRMED',
            closedReason: 'CANCELED',
            source: 'API',
            relatedBuyOrderIds: null,
          }),
          monitorAndManageOrders: async () => {},
          getAndClearPendingRefreshSymbols: () => [],
          initializeOrderMonitor: async () => {},
          canTradeNow: () => ({ canTrade: true }),
          recordBuyAttempt: () => {},
          fetchAllOrdersFromAPI: async () => [],
          resetRuntimeState: () => {},
          recoverOrderTrackingFromSnapshot: async () => {},
          executeSignals: async () => ({ submittedCount: 0, submittedOrderIds: [] }),
        },
        tradeLogHydrator: {
          hydrate: () => ({
            segmentStartByDirection: new Map(),
          }),
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
          shouldRejectBuy: () => false,
          executeClearance: async () => ({ executed: false, signalCount: 0 }),
          cancelPendingBuyOrders: async () => ({ executed: false, cancelledCount: 0 }),
        },
        signalProcessor: {
          processSellSignals: ({ signals }) => signals,
          applyRiskChecks: async (signals) => signals,
          resetRiskCheckCooldown: () => {},
        },
        indicatorCache: {
          push: () => {},
          getAt: () => null,
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
      };
    },
    displayAccountAndPositions: async () => {},
    registerDelayedSignalHandlers: () => {
      harnessState.registerDelayedCalls += 1;
      harnessState.events.push('registerDelayedSignalHandlers');
    },
    createAsyncRuntime: () => ({
      monitorTaskProcessor: {
        start: () => {
          harnessState.events.push('monitorTaskProcessor.start');
        },
        stop: () => {},
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
      orderMonitorWorker: {
        start: () => {
          harnessState.events.push('orderMonitorWorker.start');
        },
        schedule: () => {},
        stopAndDrain: async () => {},
        clearLatestQuotes: () => {},
      },
      postTradeRefresher: {
        start: () => {
          harnessState.events.push('postTradeRefresher.start');
        },
        enqueue: () => {},
        stopAndDrain: async () => {},
        clearPending: () => {},
      },
    }),
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
    mainProgram: async (params) => {
      harnessState.mainProgramCalls += 1;
      harnessState.mainProgramRuntimeGateModes.push(params.runtimeGateMode);
      harnessState.events.push('mainProgram');
    },
    sleep: async () => {
      harnessState.events.push('sleep');
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
    expect(harnessState.createPostGateRuntimeNow).toBe(harnessState.loadStartupSnapshotNow);
    expect(harnessState.rebuildCalls).toHaveLength(1);
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'createMonitorContexts',
      'createRebuildTradingDayState',
      'rebuildTradingDayState',
      'markFresh:7',
      'registerDelayedSignalHandlers',
      'createLifecycleRuntime',
      'monitorTaskProcessor.start',
      'buyProcessor.start',
      'sellProcessor.start',
      'orderMonitorWorker.start',
      'postTradeRefresher.start',
      'registerExitHandlers',
      'mainProgram',
      'sleep',
    ]);
    expect(harnessState.registerDelayedCalls).toBe(1);
    expect(harnessState.cleanupRegistered).toBe(1);
    expect(harnessState.mainProgramCalls).toBe(1);
    expect(harnessState.mainProgramRuntimeGateModes).toEqual(['strict']);
  });

  it('skips the initial rebuild when startup snapshot switches to pending open rebuild', async () => {
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
      'createRebuildTradingDayState',
      'registerDelayedSignalHandlers',
      'createLifecycleRuntime',
      'monitorTaskProcessor.start',
      'buyProcessor.start',
      'sellProcessor.start',
      'orderMonitorWorker.start',
      'postTradeRefresher.start',
      'registerExitHandlers',
      'mainProgram',
      'sleep',
    ]);
    expect(harnessState.registerDelayedCalls).toBe(1);
    expect(harnessState.cleanupRegistered).toBe(1);
    expect(harnessState.mainProgramCalls).toBe(1);
    expect(harnessState.mainProgramRuntimeGateModes).toEqual(['strict']);
  });

  it('keeps startup pending-open-rebuild assembly behavior in skip runtime gate mode', async () => {
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
    expect(harnessState.mainProgramRuntimeGateModes).toEqual(['skip']);
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
    expect(harnessState.mainProgramCalls).toBe(0);
    expect(harnessState.cleanupRegistered).toBe(0);
  });
});
