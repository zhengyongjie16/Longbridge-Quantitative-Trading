import { describe, expect, it } from 'bun:test';

import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskProcessor } from '../../../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { createRefreshGate } from '../../../../src/utils/refreshGate/index.js';

import type { MonitorTaskData, MonitorTaskStatus, MonitorTaskType , MonitorTaskContext } from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTask } from '../../../../src/main/asyncProgram/monitorTaskQueue/types.js';
import type { LastState, MonitorContext } from '../../../../src/types/state.js';
import type { MultiMonitorTradingConfig } from '../../../../src/types/config.js';

import {
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  };
}

function createMonitorTaskContext(overrides: Partial<MonitorContext> = {}): MonitorContext {
  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: 'HSI.HK',
    longSeat: {
      symbol: 'BULL.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longVersion: 2,
    shortVersion: 3,
  });

  return {
    config: createMonitorConfigDouble(),
    state: {
      monitorSymbol: 'HSI.HK',
      monitorPrice: null,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingDelayedSignals: [],
      monitorValues: null,
      lastMonitorSnapshot: null,
      lastCandleFingerprint: null,
    },
    symbolRegistry,
    seatState: {
      long: symbolRegistry.getSeatState('HSI.HK', 'LONG'),
      short: symbolRegistry.getSeatState('HSI.HK', 'SHORT'),
    },
    seatVersion: {
      long: symbolRegistry.getSeatVersion('HSI.HK', 'LONG'),
      short: symbolRegistry.getSeatVersion('HSI.HK', 'SHORT'),
    },
    autoSymbolManager: {
      maybeSearchOnTick: async () => {},
      maybeSwitchOnDistance: async () => {},
      hasPendingSwitch: () => false,
      resetAllState: () => {},
    },
    strategy: {
      generateCloseSignals: () => ({ immediateSignals: [], delayedSignals: [] }),
    },
    orderRecorder: createOrderRecorderDouble(),
    dailyLossTracker: {
      resetAll: () => {},
      recalculateFromAllOrders: () => {},
      recordFilledOrder: () => {},
      getLossOffset: () => 0,
    },
    riskChecker: createRiskCheckerDouble(),
    unrealizedLossMonitor: {
      monitorUnrealizedLoss: async () => {},
    },
    delayedSignalVerifier: {
      addSignal: () => {},
      cancelAllForSymbol: () => {},
      cancelAllForDirection: () => 0,
      cancelAll: () => 0,
      getPendingCount: () => 0,
      onVerified: () => {},
      onRejected: () => {},
      destroy: () => {},
    },
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    monitorSymbolName: 'HSI',
    normalizedMonitorSymbol: 'HSI.HK',
    rsiPeriods: [6],
    emaPeriods: [7],
    psyPeriods: [13],
    longQuote: null,
    shortQuote: null,
    monitorQuote: null,
    ...overrides,
  } as unknown as MonitorContext;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitUntil timeout');
    }
    await Bun.sleep(10);
  }
}

describe('monitorTaskProcessor business flow', () => {
  it('processes AUTO_SYMBOL_TICK with valid seat snapshot', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    let maybeSearchCalls = 0;

    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnTick: async () => {
          maybeSearchCalls += 1;
        },
        maybeSwitchOnDistance: async () => {},
        hasPendingSwitch: () => false,
        resetAllState: () => {},
      },
    });

    const statuses: MonitorTaskStatus[] = [];

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      getMonitorContext: () => context as unknown as MonitorTaskContext,
      clearQueuesForDirection: () => {},
      trader: createTraderDouble(),
      lastState: createLastState(),
      tradingConfig: {
        monitors: [createMonitorConfigDouble()],
      } as unknown as MultiMonitorTradingConfig,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
    });

    processor.start();

    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 2,
        symbol: 'BULL.HK',
        currentTimeMs: Date.now(),
        canTradeNow: true,
      },
    });

    await waitUntil(() => statuses.length === 1);
    await processor.stopAndDrain();

    expect(maybeSearchCalls).toBe(1);
    expect(statuses).toEqual(['processed']);
  });

  it('skips AUTO_SYMBOL_TICK when seat snapshot is stale', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    let maybeSearchCalls = 0;

    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnTick: async () => {
          maybeSearchCalls += 1;
        },
        maybeSwitchOnDistance: async () => {},
        hasPendingSwitch: () => false,
        resetAllState: () => {},
      },
    });

    const statuses: MonitorTaskStatus[] = [];

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      getMonitorContext: () => context as unknown as MonitorTaskContext,
      clearQueuesForDirection: () => {},
      trader: createTraderDouble(),
      lastState: createLastState(),
      tradingConfig: {
        monitors: [createMonitorConfigDouble()],
      } as unknown as MultiMonitorTradingConfig,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
    });

    processor.start();

    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 1,
        symbol: 'BULL.HK',
        currentTimeMs: Date.now(),
        canTradeNow: true,
      },
    });

    await waitUntil(() => statuses.length === 1);
    await processor.stopAndDrain();

    expect(maybeSearchCalls).toBe(0);
    expect(statuses).toEqual(['skipped']);
  });

  it('skips tasks when lifecycle gate denies processing', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    let unrealizedMonitorCalls = 0;

    const context = createMonitorTaskContext({
      unrealizedLossMonitor: {
        monitorUnrealizedLoss: async () => {
          unrealizedMonitorCalls += 1;
        },
      },
    });

    const seen: Array<{ task: MonitorTask<MonitorTaskType, MonitorTaskData>; status: MonitorTaskStatus }> = [];

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      getMonitorContext: () => context as unknown as MonitorTaskContext,
      clearQueuesForDirection: () => {},
      trader: createTraderDouble(),
      lastState: createLastState(),
      tradingConfig: {
        monitors: [createMonitorConfigDouble()],
      } as unknown as MultiMonitorTradingConfig,
      getCanProcessTask: () => false,
      onProcessed: (task, status) => {
        seen.push({ task, status });
      },
    });

    processor.start();

    queue.scheduleLatest({
      type: 'UNREALIZED_LOSS_CHECK',
      dedupeKey: 'HSI.HK:UNREALIZED_LOSS_CHECK',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        long: { seatVersion: 2, symbol: 'BULL.HK', quote: null },
        short: { seatVersion: 3, symbol: 'BEAR.HK', quote: null },
      },
    });

    await waitUntil(() => seen.length === 1);
    await processor.stopAndDrain();

    expect(seen[0]?.status).toBe('skipped');
    expect(unrealizedMonitorCalls).toBe(0);
  });
});
