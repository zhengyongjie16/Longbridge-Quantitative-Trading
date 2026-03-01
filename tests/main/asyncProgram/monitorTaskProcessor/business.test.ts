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

import type {
  MonitorTaskData,
  MonitorTaskStatus,
  MonitorTaskType,
  MonitorTaskContext,
} from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTask } from '../../../../src/main/asyncProgram/monitorTaskQueue/types.js';
import type { MultiMonitorTradingConfig } from '../../../../src/types/config.js';

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

describe('monitorTaskProcessor business flow', () => {
  it('processes AUTO_SYMBOL_TICK with valid seat snapshot', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
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

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      getMonitorContext: () => context as unknown as MonitorTaskContext,
      clearMonitorDirectionQueues: () => {},
      trader: createTraderDouble(),
      lastState: createLastState(),
      tradingConfig: {
        monitors: [createMonitorConfigDouble()],
      } as unknown as MultiMonitorTradingConfig,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
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
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
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

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      getMonitorContext: () => context as unknown as MonitorTaskContext,
      clearMonitorDirectionQueues: () => {},
      trader: createTraderDouble(),
      lastState: createLastState(),
      tradingConfig: {
        monitors: [createMonitorConfigDouble()],
      } as unknown as MultiMonitorTradingConfig,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
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
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    let unrealizedMonitorCalls = 0;

    const context = createMonitorTaskContext({
      unrealizedLossMonitor: {
        monitorUnrealizedLoss: async () => {
          unrealizedMonitorCalls += 1;
        },
      },
    });

    const seen: Array<{
      task: MonitorTask<MonitorTaskType, MonitorTaskData>;
      status: MonitorTaskStatus;
    }> = [];

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      getMonitorContext: () => context as unknown as MonitorTaskContext,
      clearMonitorDirectionQueues: () => {},
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
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
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

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      getMonitorContext: () => context as unknown as MonitorTaskContext,
      clearMonitorDirectionQueues: () => {},
      trader: createTraderDouble(),
      lastState: createLastState(),
      tradingConfig: {
        monitors: [createMonitorConfigDouble()],
      } as unknown as MultiMonitorTradingConfig,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
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
      clearMonitorDirectionQueues: () => {},
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
      lastState,
      tradingConfig: {
        monitors: [createMonitorConfigDouble()],
      } as unknown as MultiMonitorTradingConfig,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
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
      clearMonitorDirectionQueues: () => {},
      trader: createTraderDouble({
        executeSignals: async (signals) => {
          for (const signal of signals) {
            submittedActions.push(signal.action);
          }
          return { submittedCount: signals.length, submittedOrderIds: [] };
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

    await runProcessorFlow({
      processor,
      pushTask: () => {
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
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses[0]).toBe('processed');
    expect(submittedActions).toEqual(['SELLCALL']);
    expect(clearedOrders).toBe(1);
    expect(refreshUnrealizedCalls).toBe(1);
  });
});
