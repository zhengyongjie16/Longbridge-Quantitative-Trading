/**
 * app/createLifecycleRuntime 接线测试
 *
 * 覆盖：
 * - createLifecycleRuntime 按固定顺序创建各 cache domain
 * - globalState domain 的 openRebuild 统一委托 executeTradingDayOpenRebuild
 * - createLifecycleRuntime 将固定顺序的 cache domains 交给 dayLifecycleManager
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { createLifecycleRuntime } from '../../src/app/createLifecycleRuntime.js';
import type {
  LifecycleRuntimeFactories,
  LifecycleRuntimeFactoryDeps,
  PostTradeConsistencyRuntime,
} from '../../src/app/types.js';
import type { SignalProcessor } from '../../src/core/signalProcessor/types.js';
import type { CacheDomain } from '../../src/main/lifecycle/types.js';
import type { SignalRuntimeDomainDeps } from '../../src/main/lifecycle/cacheDomains/types.js';
import type { MonitorTaskProcessor } from '../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { OrderMonitorWorker } from '../../src/main/asyncProgram/orderMonitorWorker/types.js';
import type { Processor } from '../../src/main/asyncProgram/types.js';
import type { LastState } from '../../src/types/state.js';
import { createWarrantListCache } from '../../src/services/autoSymbolFinder/utils.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createSdkConfigDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';
import type { CreateDayLifecycleManagerCall, ExecuteOpenRebuildCall } from './types.js';

const factoryCalls: string[] = [];
const executeOpenRebuildCalls: ExecuteOpenRebuildCall[] = [];
const createDayLifecycleManagerCalls: CreateDayLifecycleManagerCall[] = [];
const createSignalRuntimeDomainCalls: SignalRuntimeDomainDeps[] = [];
let signalRuntimeDomain: CacheDomain | null = null;
let marketDataDomain: CacheDomain | null = null;
let seatDomain: CacheDomain | null = null;
let orderDomain: CacheDomain | null = null;
let riskDomain: CacheDomain | null = null;
let globalStateDomain: CacheDomain | null = null;

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
  };
}

function createTradingRiskEventRuntimeDouble() {
  return {
    start: () => {
      factoryCalls.push('tradingRiskEventRuntime.start');
    },
    stopAndDrain: async () => {},
  };
}

function createSwitchWakeupRuntimeDouble() {
  return {
    start: () => {
      factoryCalls.push('switchWakeupRuntime.start');
    },
    stopAndDrain: async () => {},
    handoffPendingSwitch: () => {},
  };
}

function createMonitorQuoteEventRuntimeDouble() {
  return {
    start: () => {
      factoryCalls.push('monitorQuoteEventRuntime.start');
    },
    stopAndDrain: async () => {},
  };
}

function createPostTradeConsistencyRuntimeDouble(): PostTradeConsistencyRuntime {
  return {
    bindBusinessDeps: () => {},
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
    abortWaiting: () => {
      factoryCalls.push('postTradeConsistencyRuntime.abortWaiting');
    },
    resetAbort: () => {
      factoryCalls.push('postTradeConsistencyRuntime.resetAbort');
    },
    start: () => {
      factoryCalls.push('postTradeConsistencyRuntime.start');
    },
    stopAndDrain: async () => {},
    midnightClear: () => {},
    completeRebuildBaseline: () => {
      factoryCalls.push('postTradeConsistencyRuntime.completeRebuildBaseline');
    },
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
      config: createSdkConfigDouble(),
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
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      monitorContexts: new Map(),
      tradingRiskEventRuntime: createTradingRiskEventRuntimeDouble(),
      monitorQuoteEventRuntime: createMonitorQuoteEventRuntimeDouble(),
      switchWakeupRuntime: createSwitchWakeupRuntimeDouble(),
      postTradeConsistencyRuntime: createPostTradeConsistencyRuntimeDouble(),
      lastState,
      trader: createTraderDouble(),
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
    createSignalRuntimeDomain: (deps) => {
      createSignalRuntimeDomainCalls.push(deps);
      factoryCalls.push('signalRuntime.factory');
      signalRuntimeDomain = createDomain('signalRuntime');
      return signalRuntimeDomain;
    },
    createMarketDataDomain: () => {
      factoryCalls.push('marketData.factory');
      marketDataDomain = createDomain('marketData');
      return marketDataDomain;
    },
    createSeatDomain: () => {
      factoryCalls.push('seat.factory');
      seatDomain = createDomain('seat');
      return seatDomain;
    },
    createOrderDomain: () => {
      factoryCalls.push('order.factory');
      orderDomain = createDomain('order');
      return orderDomain;
    },
    createRiskDomain: () => {
      factoryCalls.push('risk.factory');
      riskDomain = createDomain('risk');
      return riskDomain;
    },
    createGlobalStateDomain: (deps) => {
      factoryCalls.push('globalState.factory');
      globalStateDomain = {
        midnightClear: async () => {
          factoryCalls.push('globalState.midnightClear');
        },
        openRebuild: async (ctx) => {
          factoryCalls.push('globalState.openRebuild');
          await deps.runTradingDayOpenRebuild(ctx.now);
        },
      };
      return globalStateDomain;
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
    createSignalRuntimeDomainCalls.length = 0;
    signalRuntimeDomain = null;
    marketDataDomain = null;
    seatDomain = null;
    orderDomain = null;
    riskDomain = null;
    globalStateDomain = null;
  });

  it('creates cache domains in the declared order and delegates global open rebuild centrally', async () => {
    const deps = createLifecycleDeps();
    const factories = createLifecycleRuntimeFactories();
    createLifecycleRuntime(deps, factories);
    const domains = createDayLifecycleManagerCalls[0]?.cacheDomains;
    if (domains === undefined) {
      throw new Error('expected createDayLifecycleManager to receive cache domains');
    }

    expect(factoryCalls).toEqual([
      'signalRuntime.factory',
      'marketData.factory',
      'seat.factory',
      'order.factory',
      'risk.factory',
      'globalState.factory',
    ]);
    expect(domains).toHaveLength(6);
    expect(createSignalRuntimeDomainCalls).toHaveLength(1);
    expect(createSignalRuntimeDomainCalls[0]?.monitorQuoteEventRuntime).toBe(
      deps.postGateRuntime.monitorQuoteEventRuntime,
    );

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
    const cacheDomains = createDayLifecycleManagerCalls[0]?.cacheDomains;

    expect(dayLifecycleManager).toBeDefined();
    expect(createDayLifecycleManagerCalls).toHaveLength(1);
    expect(createDayLifecycleManagerCalls[0]?.mutableState).toBe(deps.postGateRuntime.lastState);

    if (
      !signalRuntimeDomain ||
      !marketDataDomain ||
      !seatDomain ||
      !orderDomain ||
      !riskDomain ||
      !globalStateDomain
    ) {
      throw new Error('expected all lifecycle cache domains to be created');
    }

    if (cacheDomains === undefined) {
      throw new Error('expected createDayLifecycleManager to receive cache domains');
    }

    expect(cacheDomains).toHaveLength(6);
    expect(cacheDomains[0]).toBe(signalRuntimeDomain);
    expect(cacheDomains[1]).toBe(marketDataDomain);
    expect(cacheDomains[2]).toBe(seatDomain);
    expect(cacheDomains[3]).toBe(orderDomain);
    expect(cacheDomains[4]).toBe(riskDomain);
    expect(cacheDomains[5]).toBe(globalStateDomain);
  });

  it('passes the same monitorQuoteEventRuntime object into signal runtime domain deps', () => {
    const deps = createLifecycleDeps();
    const factories = createLifecycleRuntimeFactories();

    createLifecycleRuntime(deps, factories);

    expect(createSignalRuntimeDomainCalls).toHaveLength(1);
    const signalRuntimeDeps = createSignalRuntimeDomainCalls[0];
    if (signalRuntimeDeps === undefined) {
      throw new Error('expected createSignalRuntimeDomain to receive deps');
    }

    expect(signalRuntimeDeps.monitorQuoteEventRuntime).toBe(
      deps.postGateRuntime.monitorQuoteEventRuntime,
    );
  });
});
