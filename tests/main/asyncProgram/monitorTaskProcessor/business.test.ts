/**
 * monitorTaskProcessor 业务测试
 *
 * 功能：
 * - 验证监控任务处理器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskProcessor } from '../../../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { createRefreshGate } from '../../../../src/utils/refreshGate/index.js';

import type { MonitorTaskData, MonitorTaskStatus, MonitorTaskType , MonitorTaskContext } from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTask } from '../../../../src/main/asyncProgram/monitorTaskQueue/types.js';
import type { LastState, MonitorContext } from '../../../../src/types/state.js';
import type { MultiMonitorTradingConfig } from '../../../../src/types/config.js';

import {
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
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

  it('processes AUTO_SYMBOL_SWITCH_DISTANCE for both directions with valid snapshots', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    const calledDirections: Array<'LONG' | 'SHORT'> = [];
    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnTick: async () => {},
        maybeSwitchOnDistance: async ({ direction }) => {
          calledDirections.push(direction);
        },
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
      type: 'AUTO_SYMBOL_SWITCH_DISTANCE',
      dedupeKey: 'HSI.HK:AUTO_SYMBOL_SWITCH_DISTANCE',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        monitorPrice: 20_000,
        quotesMap: new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
        ]),
        seatSnapshots: {
          long: { seatVersion: 2, symbol: 'BULL.HK' },
          short: { seatVersion: 3, symbol: 'BEAR.HK' },
        },
      },
    });

    await waitUntil(() => statuses.length === 1);
    await processor.stopAndDrain();

    expect(statuses[0]).toBe('processed');
    expect(calledDirections).toEqual(['LONG', 'SHORT']);
  });

  it('processes SEAT_REFRESH and rebuilds long-side runtime caches', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    let fetchAllOrdersCalls = 0;
    let refreshOrdersCalls = 0;
    let recalculateCalls = 0;
    let refreshUnrealizedCalls = 0;
    let clearLongWarrantCalls = 0;
    let accountSnapshotCalls = 0;
    let stockPositionCalls = 0;

    const context = createMonitorTaskContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => {
          fetchAllOrdersCalls += 1;
          return [];
        },
        refreshOrdersFromAllOrdersForLong: async () => {
          refreshOrdersCalls += 1;
          return [];
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {
          recalculateCalls += 1;
        },
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      riskChecker: createRiskCheckerDouble({
        clearLongWarrantInfo: () => {
          clearLongWarrantCalls += 1;
        },
        refreshUnrealizedLossData: async () => {
          refreshUnrealizedCalls += 1;
          return { r1: 100, n1: 100 };
        },
      }),
    });
    const statuses: MonitorTaskStatus[] = [];
    const lastState = createLastState();

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      getMonitorContext: () => context as unknown as MonitorTaskContext,
      clearQueuesForDirection: () => {},
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble(200_000);
        },
        getStockPositions: async () => {
          stockPositionCalls += 1;
          return [createPositionDouble({
            symbol: 'BULL.HK',
            quantity: 100,
            availableQuantity: 100,
          })];
        },
      }),
      lastState,
      tradingConfig: {
        monitors: [createMonitorConfigDouble()],
      } as unknown as MultiMonitorTradingConfig,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
    });

    processor.start();
    queue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'HSI.HK:SEAT_REFRESH:LONG',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 2,
        previousSymbol: 'OLD_BULL.HK',
        nextSymbol: 'BULL.HK',
        callPrice: 20_000,
        quote: createQuoteDouble('BULL.HK', 1.1, 100),
        symbolName: 'BULL.HK',
        quotesMap: new Map<string, ReturnType<typeof createQuoteDouble> | null>(),
      },
    });

    await waitUntil(() => statuses.length === 1);
    await processor.stopAndDrain();

    expect(statuses[0]).toBe('processed');
    expect(clearLongWarrantCalls).toBe(1);
    expect(fetchAllOrdersCalls).toBe(1);
    expect(refreshOrdersCalls).toBe(1);
    expect(recalculateCalls).toBe(1);
    expect(accountSnapshotCalls).toBe(1);
    expect(stockPositionCalls).toBe(1);
    expect(refreshUnrealizedCalls).toBe(1);
    expect(lastState.cachedAccount?.totalCash).toBe(200_000);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(100);
  });

  it('processes LIQUIDATION_DISTANCE_CHECK and executes protective sell for triggered side', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    const lastState = createLastState();
    const longPosition = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 200,
      availableQuantity: 200,
    });
    lastState.positionCache.update([longPosition]);

    const submittedActions: string[] = [];
    let clearedOrders = 0;
    let refreshUnrealizedCalls = 0;

    const context = createMonitorTaskContext({
      orderRecorder: createOrderRecorderDouble({
        clearBuyOrders: () => {
          clearedOrders += 1;
        },
      }),
      riskChecker: createRiskCheckerDouble({
        checkWarrantDistanceLiquidation: (_symbol, isLongSymbol) =>
          isLongSymbol
            ? { shouldLiquidate: true, reason: '触发清仓阈值' }
            : { shouldLiquidate: false },
        refreshUnrealizedLossData: async () => {
          refreshUnrealizedCalls += 1;
          return { r1: 100, n1: 100 };
        },
      }),
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      getMonitorContext: () => context as unknown as MonitorTaskContext,
      clearQueuesForDirection: () => {},
      trader: createTraderDouble({
        executeSignals: async (signals) => {
          for (const signal of signals) {
            submittedActions.push(signal.action);
          }
          return { submittedCount: signals.length };
        },
      }),
      lastState,
      tradingConfig: {
        monitors: [createMonitorConfigDouble()],
      } as unknown as MultiMonitorTradingConfig,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
    });

    processor.start();
    queue.scheduleLatest({
      type: 'LIQUIDATION_DISTANCE_CHECK',
      dedupeKey: 'HSI.HK:LIQUIDATION_DISTANCE_CHECK',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        monitorPrice: 20_000,
        long: {
          seatVersion: 2,
          symbol: 'BULL.HK',
          quote: createQuoteDouble('BULL.HK', 1, 100),
          symbolName: 'BULL.HK',
        },
        short: {
          seatVersion: 3,
          symbol: 'BEAR.HK',
          quote: createQuoteDouble('BEAR.HK', 1, 100),
          symbolName: 'BEAR.HK',
        },
      },
    });

    await waitUntil(() => statuses.length === 1);
    await processor.stopAndDrain();

    expect(statuses[0]).toBe('processed');
    expect(submittedActions).toEqual(['SELLCALL']);
    expect(clearedOrders).toBe(1);
    expect(refreshUnrealizedCalls).toBe(1);
  });
});
