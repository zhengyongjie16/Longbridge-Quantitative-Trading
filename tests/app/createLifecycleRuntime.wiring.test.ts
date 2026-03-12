/**
 * app/createLifecycleRuntime 接线测试
 *
 * 覆盖：
 * - createLifecycleCacheDomains 按固定顺序创建各 cache domain
 * - globalState domain 的 openRebuild 统一委托 executeTradingDayOpenRebuild
 * - createLifecycleRuntime 将固定顺序的 cache domains 交给 dayLifecycleManager
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { createConfig } from '../../src/config/config.index.js';
import {
  createLifecycleCacheDomains,
  createLifecycleRuntime,
} from '../../src/app/createLifecycleRuntime.js';
import type {
  LifecycleRuntimeFactories,
  LifecycleRuntimeFactoryDeps,
} from '../../src/app/types.js';
import type { SignalProcessor } from '../../src/core/signalProcessor/types.js';
import type { CacheDomain } from '../../src/main/lifecycle/types.js';
import type { MonitorTaskProcessor } from '../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { OrderMonitorWorker } from '../../src/main/asyncProgram/orderMonitorWorker/types.js';
import type { PostTradeRefresher } from '../../src/main/asyncProgram/postTradeRefresher/types.js';
import type { Processor } from '../../src/main/asyncProgram/types.js';
import type { LastState } from '../../src/types/state.js';
import { createWarrantListCache } from '../../src/services/autoSymbolFinder/utils.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';
import type { CreateDayLifecycleManagerCall, ExecuteOpenRebuildCall } from './types.js';

const factoryCalls: string[] = [];
const executeOpenRebuildCalls: ExecuteOpenRebuildCall[] = [];
const createDayLifecycleManagerCalls: CreateDayLifecycleManagerCall[] = [];

function createNamedProcessor(name: string): Processor {
  return {
    start: () => {
      factoryCalls.push(`${name}.start`);
    },
    stop: () => {},
    stopAndDrain: async () => {},
    restart: () => {},
  };
}

function createMonitorTaskProcessorDouble(): MonitorTaskProcessor {
  return {
    start: () => {
      factoryCalls.push('monitorTaskProcessor.start');
    },
    stop: () => {},
    stopAndDrain: async () => {},
    restart: () => {},
  };
}

function createOrderMonitorWorkerDouble(): OrderMonitorWorker {
  return {
    start: () => {
      factoryCalls.push('orderMonitorWorker.start');
    },
    schedule: () => {},
    stopAndDrain: async () => {},
    clearLatestQuotes: () => {},
  };
}

function createPostTradeRefresherDouble(): PostTradeRefresher {
  return {
    start: () => {
      factoryCalls.push('postTradeRefresher.start');
    },
    enqueue: () => {},
    stopAndDrain: async () => {},
    clearPending: () => {},
  };
}

function createSignalProcessorDouble(): SignalProcessor {
  return {
    processSellSignals: ({ signals }) => signals,
    applyRiskChecks: async (signals) => signals,
    resetRiskCheckCooldown: () => {},
  };
}

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
    positionCache: {
      update: () => {},
      get: () => null,
    },
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  };
}

function createLifecycleDeps(): LifecycleRuntimeFactoryDeps {
  const lastState = createLastState();
  const tradingConfig = createTradingConfig({ monitors: [] });
  const warrantListCache = createWarrantListCache();

  return {
    preGateRuntime: {
      config: createConfig({ env: {} }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      warrantListCache,
      warrantListCacheConfig: {
        cache: warrantListCache,
        ttlMs: 60_000,
        nowMs: () => 0,
      },
      marketDataClient: createMarketDataClientDouble(),
      runMode: 'prod',
      gatePolicies: {
        startupGate: 'strict',
        runtimeGate: 'strict',
      },
      startupTradingDayInfo: {
        isTradingDay: true,
        isHalfDay: false,
      },
      startupGate: {
        wait: async () => ({ isTradingDay: true, isHalfDay: false }),
      },
    },
    postGateRuntime: {
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
      dailyLossTracker: createDailyLossTrackerDouble(),
      monitorContexts: new Map(),
      lossOffsetLifecycleCoordinator: {
        sync: async () => {},
      },
      refreshGate: {
        markStale: () => 0,
        markFresh: () => {},
        waitForFresh: async () => {},
        getStatus: () => ({
          currentVersion: 1,
          staleVersion: 1,
        }),
      },
      lastState,
      trader: createTraderDouble(),
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
        cancelPendingBuyOrders: async () => ({ executed: false, cancelRequestAcceptedCount: 0 }),
      },
      signalProcessor: createSignalProcessorDouble(),
      indicatorCache: {
        push: () => {},
        getAt: () => null,
        clearAll: () => {},
      },
      buyTaskQueue: {
        push: () => {},
        pop: () => null,
        isEmpty: () => true,
        removeTasks: () => 0,
        clearAll: () => 0,
        onTaskAdded: () => () => {},
      },
      sellTaskQueue: {
        push: () => {},
        pop: () => null,
        isEmpty: () => true,
        removeTasks: () => 0,
        clearAll: () => 0,
        onTaskAdded: () => () => {},
      },
      monitorTaskQueue: {
        scheduleLatest: () => {},
        pop: () => null,
        isEmpty: () => true,
        removeTasks: () => 0,
        clearAll: () => 0,
        onTaskAdded: () => () => {},
      },
    },
    asyncRuntime: {
      orderMonitorWorker: createOrderMonitorWorkerDouble(),
      postTradeRefresher: createPostTradeRefresherDouble(),
      monitorTaskProcessor: createMonitorTaskProcessorDouble(),
      buyProcessor: createNamedProcessor('buyProcessor'),
      sellProcessor: createNamedProcessor('sellProcessor'),
    },
    rebuildTradingDayState: async () => {},
  };
}

function createDomain(name: string): CacheDomain {
  return {
    midnightClear: async () => {
      factoryCalls.push(`${name}.midnightClear`);
    },
    openRebuild: async () => {
      factoryCalls.push(`${name}.openRebuild`);
    },
  };
}

function createLifecycleRuntimeFactories(): LifecycleRuntimeFactories {
  return {
    createSignalRuntimeDomain: () => {
      factoryCalls.push('signalRuntime.factory');
      return createDomain('signalRuntime');
    },
    createMarketDataDomain: () => {
      factoryCalls.push('marketData.factory');
      return createDomain('marketData');
    },
    createSeatDomain: () => {
      factoryCalls.push('seat.factory');
      return createDomain('seat');
    },
    createOrderDomain: () => {
      factoryCalls.push('order.factory');
      return createDomain('order');
    },
    createRiskDomain: () => {
      factoryCalls.push('risk.factory');
      return createDomain('risk');
    },
    createGlobalStateDomain: (deps) => {
      factoryCalls.push('globalState.factory');
      return {
        midnightClear: async () => {
          factoryCalls.push('globalState.midnightClear');
        },
        openRebuild: async (ctx) => {
          factoryCalls.push('globalState.openRebuild');
          await deps.runTradingDayOpenRebuild(ctx.now);
        },
      };
    },
    executeTradingDayOpenRebuild: async (params) => {
      executeOpenRebuildCalls.push(params);
    },
    createDayLifecycleManager: (deps) => {
      createDayLifecycleManagerCalls.push(deps);
      return {
        tick: async () => {},
      };
    },
  };
}

describe('app createLifecycleRuntime wiring', () => {
  beforeEach(() => {
    factoryCalls.length = 0;
    executeOpenRebuildCalls.length = 0;
    createDayLifecycleManagerCalls.length = 0;
  });

  it('creates cache domains in the declared order and delegates global open rebuild centrally', async () => {
    const deps = createLifecycleDeps();
    const factories = createLifecycleRuntimeFactories();
    const domains = createLifecycleCacheDomains(deps, factories);

    expect(factoryCalls).toEqual([
      'signalRuntime.factory',
      'marketData.factory',
      'seat.factory',
      'order.factory',
      'risk.factory',
      'globalState.factory',
    ]);
    expect(domains).toHaveLength(6);

    await domains.at(-1)?.openRebuild({
      now: new Date('2026-03-09T09:30:00.000Z'),
      runtime: {
        dayKey: '2026-03-09',
        canTradeNow: true,
        isTradingDay: true,
      },
    });

    expect(factoryCalls).toContain('globalState.openRebuild');
    expect(executeOpenRebuildCalls).toHaveLength(1);
    expect(executeOpenRebuildCalls[0]?.loadTradingDayRuntimeSnapshot).toBe(
      deps.postGateRuntime.loadTradingDayRuntimeSnapshot,
    );
    expect(executeOpenRebuildCalls[0]?.rebuildTradingDayState).toBe(deps.rebuildTradingDayState);
  });

  it('passes the ordered cache domains into createDayLifecycleManager', () => {
    const deps = createLifecycleDeps();
    const factories = createLifecycleRuntimeFactories();
    const dayLifecycleManager = createLifecycleRuntime(deps, factories);

    expect(dayLifecycleManager).toBeDefined();
    expect(createDayLifecycleManagerCalls).toHaveLength(1);
    expect(createDayLifecycleManagerCalls[0]?.mutableState).toBe(deps.postGateRuntime.lastState);
    expect(createDayLifecycleManagerCalls[0]?.cacheDomains).toHaveLength(6);
  });
});
