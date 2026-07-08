/**
 * app/createAsyncRuntime 接线测试
 *
 * 覆盖：
 * - AUTO_SYMBOL_TICK 任务完成状态回传 PeriodicSwitchWakeupRuntime owner
 * - 清仓接管窗口内普通周期换标任务不会进入换标状态机
 */
import { describe, expect, it } from 'bun:test';
import { createAsyncRuntime } from '../../../src/app/runtime/createAsyncRuntime.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createWarrantListCache } from '../../../src/services/autoSymbolFinder/utils.js';
import type { AsyncRuntimeFactoryDeps } from '../../../src/app/types.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../../../src/main/periodicSwitchWakeupRuntime/types.js';
import type { LastState, MonitorContext } from '../../../src/types/state.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  createDailyLossTrackerDouble,
  createDoomsdayProtectionDouble,
  createMarketDataClientDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteSubscriptionRuntimeDouble,
  createSeatRuntimeCleanupDispatcherDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import {
  createLastState,
  createMonitorTaskContext,
  runProcessorFlow,
} from '../../main/asyncProgram/utils.js';

function createPeriodicSwitchWakeupRuntimeRecorder(
  calls: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0][],
): PeriodicSwitchWakeupRuntime {
  return {
    start: () => {},
    stopAndDrain: async () => {},
    markWaitingEmpty: () => {},
    clearWaitingEmpty: () => {},
    replanRouteAfterTask: (params) => {
      calls.push(params);
    },
  };
}

function createDeps(
  options: Readonly<{
    lastState: LastState;
    monitorTaskQueue: ReturnType<typeof createMonitorTaskQueue<MonitorTaskDataMap>>;
    periodicSwitchWakeupRuntime: PeriodicSwitchWakeupRuntime;
    monitorContexts?: ReadonlyMap<string, MonitorContext>;
  }>,
): AsyncRuntimeFactoryDeps {
  const { lastState, monitorTaskQueue, periodicSwitchWakeupRuntime, monitorContexts } = options;
  const warrantListCache = createWarrantListCache();

  return {
    preGateRuntime: {
      config: { refreshAccessToken: () => Promise.resolve('') },
      tradingConfig: createTradingConfig({ monitors: [] }),
      symbolRegistry: createSymbolRegistryDouble(),
      warrantListCache,
      warrantListCacheConfig: {
        cache: warrantListCache,
        ttlMs: 60_000,
        nowMs: () => 0,
      },
      marketDataClient: createMarketDataClientDouble(),
      startupTradingDayInfo: null,
    },
    postGateRuntime: {
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      monitorContexts: monitorContexts ?? new Map(),
      tradingGateEventRuntime: {
        emitGateStateChanged: () => {},
        onGateStateChanged: () => () => {},
      },
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      seatActivationDispatcher: {
        start: () => {},
        stop: () => {},
        dispatchCurrentActivatingSeats: () => {},
      },
      seatRuntimeCleanupDispatcher: createSeatRuntimeCleanupDispatcherDouble(),
      autoSearchWakeupRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
        drainFatalError: () => new Promise<never>(() => {}),
      },
      periodicSwitchWakeupRuntime,
      tradingRiskEventRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
      },
      monitorQuoteEventRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
      },
      monitorDisplayRuntime: {
        start: () => {},
        requestRender: () => {},
        stopAndDrain: async () => {},
      },
      tradingQuoteDisplayRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
      },
      switchWakeupRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
        handoffPendingSwitch: () => {},
      },
      postTradeConsistencyRuntime: {
        bindBusinessDeps: () => {},
        recordSettlementRefreshNeed: () => {},
        getStatus: () => ({ started: false, currentVersion: 0, staleVersion: 0 }),
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
        drainFatalError: () => new Promise<never>(() => {}),
        abortWaiting: () => {},
        resetAbort: () => {},
        start: () => {},
        stopAndDrain: async () => {},
        midnightClear: () => {},
        completeRebuildBaseline: () => {},
      },
      lastState,
      trader: createTraderDouble(),
      loadTradingDayRuntimeSnapshot: async () => ({ allOrders: [], quotesMap: new Map() }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
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
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      monitorTaskQueue,
      drainFatalError: () => new Promise<never>(() => {}),
    },
  };
}

describe('app createAsyncRuntime wiring', () => {
  it('replans periodic switch route when AUTO_SYMBOL_TICK is skipped by lifecycle gate', async () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const replanCalls: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0][] = [];
    const runtime = createAsyncRuntime(
      createDeps({
        lastState: createLastState({ isTradingEnabled: false }),
        monitorTaskQueue,
        periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeRecorder(replanCalls),
      }),
    );

    await runProcessorFlow({
      processor: runtime.monitorTaskProcessor,
      pushTask: () => {
        monitorTaskQueue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG',
          monitorSymbol: 'HSI.HK',
          data: {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            seatVersion: 7,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 1_000,
            currentTimeMs: 2_000,
          },
        });
      },
      waitCondition: () => monitorTaskQueue.isEmpty(),
    });

    expect(replanCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 7,
        symbol: 'BULL.HK',
        lastSeatActivatedAt: 1_000,
        taskTimeMs: 2_000,
        status: 'skipped',
      },
    ]);
  });

  it('blocks AUTO_SYMBOL_TICK switch flow during doomsday clearance takeover window', async () => {
    const originalNow = Date.now;
    Date.now = () => Date.UTC(2026, 1, 16, 7, 56);
    try {
      const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
      const replanCalls: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0][] = [];
      let periodicDueCalls = 0;
      const context = createMonitorTaskContext({
        autoSymbolManager: {
          maybeSearchOnEvent: async () => {},
          evaluatePeriodicSwitchDue: async () => {
            periodicDueCalls += 1;
            return { kind: 'NOOP' };
          },
          startSwitchOnDistance: async (params) => ({
            started: false,
            direction: params.direction,
            driveResult: {
              kind: 'NOOP',
            },
          }),
          advancePendingSwitch: async (params) => ({
            advanced: false,
            direction: params.direction,
            stillPending: false,
            driveResult: {
              kind: 'NOOP',
            },
          }),
          hasPendingSwitch: () => false,
          getPeriodicSwitchPendingState: () => ({
            pending: false,
            pendingSinceMs: null,
          }),
          resetAllState: () => {},
        },
      });
      const runtime = createAsyncRuntime(
        createDeps({
          lastState: createLastState({ canTrade: true, isHalfDay: false }),
          monitorContexts: new Map([['HSI.HK', context]]),
          monitorTaskQueue,
          periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeRecorder(replanCalls),
        }),
      );

      await runProcessorFlow({
        processor: runtime.monitorTaskProcessor,
        pushTask: () => {
          monitorTaskQueue.scheduleLatest({
            type: 'AUTO_SYMBOL_TICK',
            dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:DOOMSDAY',
            monitorSymbol: 'HSI.HK',
            data: {
              monitorSymbol: 'HSI.HK',
              direction: 'LONG',
              seatVersion: 2,
              symbol: 'BULL.HK',
              lastSeatActivatedAt: 12_000,
              currentTimeMs: 70_000,
            },
          });
        },
        waitCondition: () => monitorTaskQueue.isEmpty(),
      });

      expect(periodicDueCalls).toBe(0);
      expect(replanCalls).toEqual([
        {
          monitorSymbol: 'HSI.HK',
          direction: 'LONG',
          seatVersion: 2,
          symbol: 'BULL.HK',
          lastSeatActivatedAt: 12_000,
          taskTimeMs: 70_000,
          status: 'blocked',
        },
      ]);
    } finally {
      Date.now = originalNow;
    }
  });

  it('marks AUTO_SYMBOL_TICK API failures as failed without entering async fatal channel', async () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const replanCalls: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0][] = [];
    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => {
          throw createExternalApiRequestError({
            operation: 'test.periodicDue',
            attempts: 1,
            cause: new Error('api unavailable'),
          });
        },
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        advancePendingSwitch: async (params) => ({
          advanced: false,
          direction: params.direction,
          stillPending: false,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        hasPendingSwitch: () => false,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const runtime = createAsyncRuntime(
      createDeps({
        lastState: createLastState(),
        monitorContexts: new Map([['HSI.HK', context]]),
        monitorTaskQueue,
        periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeRecorder(replanCalls),
      }),
    );

    await runProcessorFlow({
      processor: runtime.monitorTaskProcessor,
      pushTask: () => {
        monitorTaskQueue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:API_FAIL',
          monitorSymbol: 'HSI.HK',
          data: {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: 70_000,
          },
        });
      },
      waitCondition: () => monitorTaskQueue.isEmpty(),
    });

    expect(replanCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 2,
        symbol: 'BULL.HK',
        lastSeatActivatedAt: 12_000,
        taskTimeMs: 70_000,
        status: 'failed',
      },
    ]);
  });

  it('sends non API AUTO_SYMBOL_TICK processing errors to async fatal channel', async () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const replanCalls: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0][] = [];
    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => {
          throw new TypeError('periodic due contract broken');
        },
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        advancePendingSwitch: async (params) => ({
          advanced: false,
          direction: params.direction,
          stillPending: false,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        hasPendingSwitch: () => false,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const runtime = createAsyncRuntime(
      createDeps({
        lastState: createLastState(),
        monitorContexts: new Map([['HSI.HK', context]]),
        monitorTaskQueue,
        periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeRecorder(replanCalls),
      }),
    );
    const fatalErrorPromise = runtime.drainFatalError().catch((error: unknown) => error);

    await runProcessorFlow({
      processor: runtime.monitorTaskProcessor,
      pushTask: () => {
        monitorTaskQueue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:FAIL',
          monitorSymbol: 'HSI.HK',
          data: {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: 70_000,
          },
        });
      },
      waitCondition: () => monitorTaskQueue.isEmpty(),
    });

    const fatalError = await fatalErrorPromise;

    expect(fatalError).toBeInstanceOf(TypeError);
    expect((fatalError as Error).message).toBe('periodic due contract broken');
    expect(replanCalls).toEqual([]);
  });
});
