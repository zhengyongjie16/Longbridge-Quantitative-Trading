/**
 * monitorTaskProcessor 业务测试
 *
 * 功能：
 * - 验证监控任务处理器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createMonitorTaskProcessor } from '../../../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskProcessorDeps,
  MonitorTaskStatus,
} from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTask } from '../../../../src/main/asyncProgram/monitorTaskQueue/types.js';
import type { MultiMonitorTradingConfig } from '../../../../src/types/config.js';
import { createRefreshGate } from '../../../../src/utils/refreshGate/index.js';

import { createTradingConfig as createTradingConfigFactory } from '../../../../mock/factories/configFactory.js';

import {
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import { createLastState, createMonitorTaskContext, runProcessorFlow } from '../utils.js';

type MonitorTaskQueueForTest = MonitorTaskProcessorDeps['monitorTaskQueue'];

type CreateBusinessProcessorParams = Readonly<{
  queue: MonitorTaskQueueForTest;
  context: ReturnType<typeof createMonitorTaskContext>;
  lastState?: ReturnType<typeof createLastState>;
  trader?: ReturnType<typeof createTraderDouble>;
  onProcessed?: MonitorTaskProcessorDeps['onProcessed'];
  getCanProcessTask?: MonitorTaskProcessorDeps['getCanProcessTask'];
}>;

type CreateTriggeredLongOnlyLiquidationContextParams = Readonly<{
  onClearBuyOrders?: () => void;
  onRefreshUnrealizedLoss?: () => void;
}>;

function createTradingConfig(): MultiMonitorTradingConfig {
  return createTradingConfigFactory({
    monitors: [createMonitorConfigDouble()],
  });
}

function createStatusCollector(
  statuses: MonitorTaskStatus[],
): NonNullable<MonitorTaskProcessorDeps['onProcessed']> {
  return function collectStatus(
    _task: MonitorTask<MonitorTaskDataMap>,
    status: MonitorTaskStatus,
  ): void {
    statuses.push(status);
  };
}

function createBusinessProcessor(
  params: CreateBusinessProcessorParams,
): ReturnType<typeof createMonitorTaskProcessor> {
  const {
    queue,
    context,
    lastState = createLastState(),
    trader = createTraderDouble(),
    onProcessed,
    getCanProcessTask,
  } = params;

  return createMonitorTaskProcessor({
    monitorTaskQueue: queue,
    refreshGate: createRefreshGate(),
    getMonitorContext: () => context,
    clearMonitorDirectionQueues: () => {},
    trader,
    lastState,
    tradingConfig: createTradingConfig(),
    ...(onProcessed ? { onProcessed } : {}),
    ...(getCanProcessTask ? { getCanProcessTask } : {}),
  });
}

function scheduleSeatRefreshTask(queue: MonitorTaskQueueForTest, dedupeKey: string): void {
  queue.scheduleLatest({
    type: 'SEAT_REFRESH',
    dedupeKey,
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
}

function scheduleLiquidationDistanceCheckTask(
  queue: MonitorTaskQueueForTest,
  dedupeKey: string,
): void {
  queue.scheduleLatest({
    type: 'LIQUIDATION_DISTANCE_CHECK',
    dedupeKey,
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
}

function seedBullPosition(lastState: ReturnType<typeof createLastState>): void {
  const longPosition = createPositionDouble({
    symbol: 'BULL.HK',
    quantity: 200,
    availableQuantity: 200,
  });

  lastState.positionCache.update([longPosition]);
}

function createTriggeredLongOnlyLiquidationContext(
  params: CreateTriggeredLongOnlyLiquidationContextParams = {},
): ReturnType<typeof createMonitorTaskContext> {
  const { onClearBuyOrders, onRefreshUnrealizedLoss } = params;

  return createMonitorTaskContext({
    orderRecorder: createOrderRecorderDouble({
      clearBuyOrders: () => {
        onClearBuyOrders?.();
      },
    }),
    riskChecker: createRiskCheckerDouble({
      checkWarrantDistanceLiquidation: function checkWarrantDistanceLiquidation(_symbol, isLongSymbol) {
        if (isLongSymbol) {
          return { shouldLiquidate: true, reason: '触发清仓阈值' };
        }

        return { shouldLiquidate: false };
      },
      refreshUnrealizedLossData: async () => {
        onRefreshUnrealizedLoss?.();
        return { r1: 100, n1: 100 };
      },
    }),
  });
}

describe('monitorTaskProcessor business flow', () => {
  it('processes AUTO_SYMBOL_TICK with valid seat snapshot', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let maybeSearchCalls = 0;
    const intervalCallArgs: Array<{
      direction: 'LONG' | 'SHORT';
      currentTime: Date;
      canTradeNow: boolean;
      openProtectionActive: boolean;
    }> = [];

    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnTick: async () => {
          maybeSearchCalls += 1;
        },
        maybeSwitchOnInterval: async (params) => {
          intervalCallArgs.push(params);
        },
        maybeSwitchOnDistance: async () => {},
        hasPendingSwitch: () => false,
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
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
            openProtectionActive: false,
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(maybeSearchCalls).toBe(1);
    expect(intervalCallArgs).toHaveLength(1);
    expect(intervalCallArgs[0]?.direction).toBe('LONG');
    expect(intervalCallArgs[0]?.canTradeNow).toBeTrue();
    expect(intervalCallArgs[0]?.openProtectionActive).toBeFalse();
    expect(intervalCallArgs[0]?.currentTime.getTime()).toBeGreaterThan(0);
    expect(statuses).toEqual(['processed']);
  });

  it('skips AUTO_SYMBOL_TICK when seat snapshot is stale', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let maybeSearchCalls = 0;

    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnTick: async () => {
          maybeSearchCalls += 1;
        },
        maybeSwitchOnInterval: async () => {},
        maybeSwitchOnDistance: async () => {},
        hasPendingSwitch: () => false,
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
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
            openProtectionActive: false,
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(maybeSearchCalls).toBe(0);
    expect(statuses).toEqual(['skipped']);
  });

  it('skips tasks when lifecycle gate denies processing', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let unrealizedMonitorCalls = 0;

    const context = createMonitorTaskContext({
      unrealizedLossMonitor: {
        monitorUnrealizedLoss: async () => {
          unrealizedMonitorCalls += 1;
        },
      },
    });

    const seen: Array<{
      task: MonitorTask<MonitorTaskDataMap>;
      status: MonitorTaskStatus;
    }> = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      getCanProcessTask: () => false,
      onProcessed: (task, status) => {
        seen.push({ task, status });
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
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
      },
      waitCondition: () => seen.length === 1,
      timeoutMs: 500,
    });

    expect(seen[0]?.status).toBe('skipped');
    expect(unrealizedMonitorCalls).toBe(0);
  });

  it('processes AUTO_SYMBOL_SWITCH_DISTANCE for both directions with valid snapshots', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const calledDirections: Array<'LONG' | 'SHORT'> = [];
    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnTick: async () => {},
        maybeSwitchOnInterval: async () => {},
        maybeSwitchOnDistance: async ({ direction }) => {
          calledDirections.push(direction);
        },
        hasPendingSwitch: () => false,
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
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
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses[0]).toBe('processed');
    expect(calledDirections).toEqual(['LONG', 'SHORT']);
  });

  it('processes SEAT_REFRESH and rebuilds long-side runtime caches', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
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
        startNewProtectionEpisode: () => {},
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

    const processor = createBusinessProcessor({
      queue,
      context,
      lastState,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble(200_000);
        },
        getStockPositions: async () => {
          stockPositionCalls += 1;
          return [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 100,
              availableQuantity: 100,
            }),
          ];
        },
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'HSI.HK:SEAT_REFRESH:LONG');
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

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

  it('marks SEAT_REFRESH as failed when order refresh throws', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];

    const context = createMonitorTaskContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [],
        refreshOrdersFromAllOrdersForLong: async () => {
          throw new Error('seat refresh order rebuild failed');
        },
      }),
    });

    const processor = createBusinessProcessor({
      queue,
      context,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'HSI.HK:SEAT_REFRESH:LONG:FAIL');
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['failed']);
  });

  it('processes LIQUIDATION_DISTANCE_CHECK and executes protective sell for triggered side', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const lastState = createLastState();
    seedBullPosition(lastState);

    const submittedActions: string[] = [];
    let clearedOrders = 0;
    let refreshUnrealizedCalls = 0;

    const context = createTriggeredLongOnlyLiquidationContext({
      onClearBuyOrders: () => {
        clearedOrders += 1;
      },
      onRefreshUnrealizedLoss: () => {
        refreshUnrealizedCalls += 1;
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      lastState,
      trader: createTraderDouble({
        executeSignals: async (signals) => {
          for (const signal of signals) {
            submittedActions.push(signal.action);
          }

          return { submittedCount: signals.length, submittedOrderIds: [] };
        },
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleLiquidationDistanceCheckTask(queue, 'HSI.HK:LIQUIDATION_DISTANCE_CHECK');
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses[0]).toBe('processed');
    expect(submittedActions).toEqual(['SELLCALL']);
    expect(clearedOrders).toBe(1);
    expect(refreshUnrealizedCalls).toBe(1);
  });

  it('keeps cache unchanged when LIQUIDATION_DISTANCE_CHECK signals are not submitted', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const lastState = createLastState();
    seedBullPosition(lastState);

    const submittedActions: string[] = [];
    let clearedOrders = 0;
    let refreshUnrealizedCalls = 0;

    const context = createTriggeredLongOnlyLiquidationContext({
      onClearBuyOrders: () => {
        clearedOrders += 1;
      },
      onRefreshUnrealizedLoss: () => {
        refreshUnrealizedCalls += 1;
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      lastState,
      trader: createTraderDouble({
        executeSignals: async (signals) => {
          for (const signal of signals) {
            submittedActions.push(signal.action);
          }

          return { submittedCount: 0, submittedOrderIds: [] };
        },
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleLiquidationDistanceCheckTask(
          queue,
          'HSI.HK:LIQUIDATION_DISTANCE_CHECK:NOT_SUBMITTED',
        );
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses[0]).toBe('processed');
    expect(submittedActions).toEqual(['SELLCALL']);
    expect(clearedOrders).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
  });
});
