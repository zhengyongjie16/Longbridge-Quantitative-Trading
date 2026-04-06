/**
 * monitorTaskProcessor 业务测试
 *
 * 功能：
 * - 验证监控任务处理器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createMonitorTaskProcessor } from '../../../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import type {
  LiquidationTask,
  MonitorTaskDataMap,
  MonitorTaskProcessorDeps,
  MonitorTaskStatus,
} from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTask } from '../../../../src/main/asyncProgram/monitorTaskQueue/types.js';
import type { MultiMonitorTradingConfig } from '../../../../src/types/config.js';
import { createPostTradeConsistencyRuntime } from '../../../../src/app/runtime/createPostTradeConsistencyRuntime.js';

import { createTradingConfig as createTradingConfigFactory } from '../../../../mock/factories/configFactory.js';

import {
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import {
  createLastState,
  createMonitorTaskContext,
  runProcessorFlow,
  waitUntil,
} from '../utils.js';
import type {
  CreateBusinessProcessorParams,
  CreateTriggeredLongOnlyLiquidationContextParams,
} from '../types.js';

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
    marketDataClient = createMarketDataClientDouble(),
    scheduleRetry,
    clearRetry,
    onProcessed,
    getCanProcessTask,
    postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
      getTrader: () => trader,
      lastState,
    }),
  } = params;

  return createMonitorTaskProcessor({
    monitorTaskQueue: queue,
    postTradeConsistencyRuntime,
    getMonitorContext: () => context,
    clearMonitorDirectionQueues: () => {},
    trader,
    marketDataClient,
    lastState,
    tradingConfig: createTradingConfig(),
    ...(scheduleRetry ? { scheduleRetry } : {}),
    ...(clearRetry ? { clearRetry } : {}),
    ...(onProcessed ? { onProcessed } : {}),
    ...(getCanProcessTask ? { getCanProcessTask } : {}),
  });
}

function scheduleSeatRefreshTask(
  queue: MonitorTaskProcessorDeps['monitorTaskQueue'],
  dedupeKey: string,
): void {
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
      symbolName: 'BULL.HK',
    },
  });
}

function scheduleLiquidationDistanceCheckTask(
  queue: MonitorTaskProcessorDeps['monitorTaskQueue'],
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
        symbolName: 'BULL.HK',
      },
      short: {
        seatVersion: 3,
        symbol: 'BEAR.HK',
        symbolName: 'BEAR.HK',
      },
    },
  });
}

function scheduleShortOnlyLiquidationDistanceCheckTask(
  queue: MonitorTaskProcessorDeps['monitorTaskQueue'],
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
        seatVersion: 1,
        symbol: null,
        symbolName: null,
      },
      short: {
        seatVersion: 3,
        symbol: 'BEAR.HK',
        symbolName: 'BEAR.HK',
      },
    },
  });
}

function seedBearPosition(lastState: ReturnType<typeof createLastState>): void {
  const shortPosition = createPositionDouble({
    symbol: 'BEAR.HK',
    quantity: 200,
    availableQuantity: 200,
  });

  lastState.positionCache.update([shortPosition]);
}

function pushLiquidationTaskDirection(
  directions: Array<LiquidationTask['direction']>,
  direction: LiquidationTask['direction'],
): void {
  directions.push(direction);
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
  const { onClearBuyOrders, onGetLossOffset, onRefreshUnrealizedLoss } = params;

  return createMonitorTaskContext({
    orderRecorder: createOrderRecorderDouble({
      clearBuyOrders: (_symbol, isLongSymbol) => {
        onClearBuyOrders?.(isLongSymbol);
      },
    }),
    dailyLossTracker: {
      resetAll: () => {},
      recalculateFromAllOrders: () => {},
      recordFilledOrder: () => {},
      getLossOffset: (_monitorSymbol, isLongSymbol) => {
        onGetLossOffset?.(isLongSymbol);
        return 0;
      },
      startNewProtectionEpisode: () => {},
    },
    riskChecker: createRiskCheckerDouble({
      checkWarrantDistanceLiquidation: function checkWarrantDistanceLiquidation(
        _symbol,
        isLongSymbol,
      ) {
        if (isLongSymbol) {
          return { shouldLiquidate: true, reason: '触发清仓阈值' };
        }

        return { shouldLiquidate: false };
      },
      refreshUnrealizedLossData: async (_orderRecorder, _symbol, isLongSymbol) => {
        onRefreshUnrealizedLoss?.(isLongSymbol);
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
    let liquidationChecks = 0;

    const context = createMonitorTaskContext({
      riskChecker: createRiskCheckerDouble({
        checkWarrantDistanceLiquidation: () => {
          liquidationChecks += 1;
          return { shouldLiquidate: false };
        },
      }),
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
          type: 'LIQUIDATION_DISTANCE_CHECK',
          dedupeKey: 'HSI.HK:LIQUIDATION_DISTANCE_CHECK',
          monitorSymbol: 'HSI.HK',
          data: {
            monitorSymbol: 'HSI.HK',
            monitorPrice: 20_000,
            long: { seatVersion: 2, symbol: 'BULL.HK', symbolName: 'BULL' },
            short: { seatVersion: 3, symbol: 'BEAR.HK', symbolName: 'BEAR' },
          },
        });
      },
      waitCondition: () => seen.length === 1,
      timeoutMs: 500,
    });

    expect(seen[0]?.status).toBe('skipped');
    expect(liquidationChecks).toBe(0);
  });

  it('waits for postTradeConsistencyRuntime freshness before processing AUTO_SYMBOL_SWITCH_DISTANCE', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const calledDirections: Array<'LONG' | 'SHORT'> = [];
    const lastState = createLastState();
    const trader = createTraderDouble();
    const postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
      getTrader: () => trader,
      lastState,
    });
    postTradeConsistencyRuntime.bindBusinessDeps({
      monitorContexts: new Map(),
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
        startNewProtectionEpisode: () => {},
      },
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
      protectiveLiquidationEpisodeTracker: {
        recordProtectiveFillProgress: () => {},
        completeIfEligible: () => null,
        restoreCompletedBoundary: () => {},
        restoreInProgressEpisode: () => {},
        getLatestProtectionBoundaryByDirection: () => new Map(),
        getInProgressEpisodes: () => [],
        resetAll: () => {},
      },
    });

    postTradeConsistencyRuntime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnTick: async () => {},
        maybeSwitchOnInterval: async () => {},
        maybeSwitchOnDistance: async (params) => {
          calledDirections.push(params.direction);
        },
        hasPendingSwitch: () => false,
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      lastState,
      trader,
      postTradeConsistencyRuntime,
      onProcessed: createStatusCollector(statuses),
    });

    processor.start();
    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_SWITCH_DISTANCE',
      dedupeKey: 'HSI.HK:AUTO_SYMBOL_SWITCH_DISTANCE:WAIT_FRESH',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        monitorPrice: 20_000,
        seatSnapshots: {
          long: { seatVersion: 2, symbol: 'BULL.HK' },
          short: { seatVersion: 3, symbol: 'BEAR.HK' },
        },
      },
    });

    await Bun.sleep(50);
    expect(calledDirections).toEqual([]);
    expect(statuses).toEqual([]);

    postTradeConsistencyRuntime.start();

    await waitUntil(() => statuses.length === 1);
    await processor.stopAndDrain();

    expect(statuses[0]).toBe('processed');
    expect(calledDirections).toEqual(['LONG', 'SHORT']);
  });

  it('processes AUTO_SYMBOL_SWITCH_DISTANCE for both directions without forwarding quotesMap', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const calledParams: Array<Record<string, unknown>> = [];
    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnTick: async () => {},
        maybeSwitchOnInterval: async () => {},
        maybeSwitchOnDistance: async (params) => {
          calledParams.push(params as unknown as Record<string, unknown>);
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
    expect(calledParams).toHaveLength(2);
    expect(calledParams.map((params) => params['direction'])).toEqual(['LONG', 'SHORT']);
    expect(calledParams.every((params) => !('quotesMap' in params))).toBeTrue();
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
    let getQuotesCalls = 0;

    const context = createMonitorTaskContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => {
          fetchAllOrdersCalls += 1;
          return [];
        },
        refreshOrdersFromAllOrdersForLong: async (_symbol, _allOrders, quote) => {
          refreshOrdersCalls += 1;
          expect(quote?.price).toBe(1.1);
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
    context.symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
      ...context.symbolRegistry.getSeatState('HSI.HK', 'LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    } as never);
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
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]);
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
    expect(getQuotesCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    expect(lastState.cachedAccount?.totalCash).toBe(200_000);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(100);
  });

  it('marks SEAT_REFRESH as processed when order refresh throws', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    let getQuotesCalls = 0;

    const context = createMonitorTaskContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [],
        refreshOrdersFromAllOrdersForLong: async () => {
          throw new Error('seat refresh order rebuild failed');
        },
      }),
    });
    context.symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
      ...context.symbolRegistry.getSeatState('HSI.HK', 'LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    } as never);

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]);
        },
      }),
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

    expect(statuses).toEqual(['processed']);
    expect(getQuotesCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('HSI.HK', 'LONG')).toMatchObject({
      symbol: null,
      status: 'EMPTY',
      lastSeatActivatedAt: null,
      callPrice: null,
    });
    expect(context.symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(3);
  });

  it('skips SEAT_REFRESH final activation when seat snapshot changes during refresh', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const context = createMonitorTaskContext();
    context.symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
      ...context.symbolRegistry.getSeatState('HSI.HK', 'LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    } as never);

    context.riskChecker.refreshUnrealizedLossData = async () => {
      const latestSeat = context.symbolRegistry.getSeatState('HSI.HK', 'LONG');
      context.symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
      context.symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
        ...latestSeat,
        symbol: 'NEXT_BULL.HK',
        status: 'SWITCHING',
        lastSwitchAt: Date.now(),
        callPrice: null,
      } as never);
      return { r1: 100, n1: 100 };
    };

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
          ]),
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'HSI.HK:SEAT_REFRESH:LONG:STALE_DURING_REFRESH');
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['skipped']);
    expect(context.symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(3);
    expect(context.symbolRegistry.getSeatState('HSI.HK', 'LONG')).toMatchObject({
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
    });
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
    context.symbolRegistry.updateSeatState('HSI.HK', 'SHORT', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

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
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1, 100)],
            ['BEAR.HK', null],
          ]),
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

  it('skips stale LIQUIDATION_DISTANCE_CHECK signals when seat changes before execution', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const lastState = createLastState();
    seedBullPosition(lastState);

    const submittedActions: string[] = [];
    let gateCalls = 0;
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
      getCanProcessTask: () => {
        gateCalls += 1;
        if (gateCalls === 2) {
          const currentSeat = context.symbolRegistry.getSeatState('HSI.HK', 'LONG');
          context.symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
          context.symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
            symbol: currentSeat.symbol,
            status: 'SWITCHING',
            lastSwitchAt: Date.now(),
            lastSearchAt: currentSeat.lastSearchAt,
            lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
            callPrice: currentSeat.callPrice ?? null,
            searchFailCountToday: currentSeat.searchFailCountToday,
            frozenTradingDayKey: currentSeat.frozenTradingDayKey,
          });
        }

        return true;
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleLiquidationDistanceCheckTask(queue, 'HSI.HK:LIQUIDATION_DISTANCE_CHECK:STALE_SEAT');
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses[0]).toBe('processed');
    expect(submittedActions).toEqual([]);
    expect(clearedOrders).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
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
    context.symbolRegistry.updateSeatState('HSI.HK', 'SHORT', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

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
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1, 100)],
            ['BEAR.HK', null],
          ]),
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

  it('retries LIQUIDATION_DISTANCE_CHECK non-blockingly when quote is missing, then executes after quote warms', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const lastState = createLastState();
    seedBullPosition(lastState);

    let quoteReady = false;
    const retryCallbacks: Array<() => void> = [];
    const submittedActions: string[] = [];
    const statuses: MonitorTaskStatus[] = [];

    const context = createTriggeredLongOnlyLiquidationContext();
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
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000)],
            ['BULL.HK', quoteReady ? createQuoteDouble('BULL.HK', 1, 100) : null],
            ['BEAR.HK', null],
          ]),
      }),
      scheduleRetry: (callback) => {
        retryCallbacks.push(callback);
        return setTimeout(() => {}, 0);
      },
      clearRetry: () => {},
      onProcessed: createStatusCollector(statuses),
    });

    processor.start();
    queue.scheduleLatest({
      type: 'LIQUIDATION_DISTANCE_CHECK',
      dedupeKey: 'HSI.HK:LIQUIDATION_DISTANCE_CHECK:RETRY',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        monitorPrice: 20_000,
        long: {
          seatVersion: 2,
          symbol: 'BULL.HK',
          symbolName: 'BULL.HK',
        },
        short: {
          seatVersion: 3,
          symbol: null,
          symbolName: null,
        },
      },
    });

    await waitUntil(() => statuses.length === 1);
    expect(submittedActions).toEqual([]);
    expect(retryCallbacks).toHaveLength(1);

    quoteReady = true;
    const retryCallback = retryCallbacks[0];
    if (!retryCallback) {
      throw new Error('retry callback should exist');
    }

    retryCallback();
    await waitUntil(() => submittedActions.length === 1);
    await processor.stopAndDrain();

    expect(submittedActions).toEqual(['SELLCALL']);
  });

  it('executes LIQUIDATION_DISTANCE_CHECK ready subset first and retries unresolved side with fresh monitor price', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const lastState = createLastState();
    lastState.positionCache.update([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
      createPositionDouble({ symbol: 'BEAR.HK', quantity: 200, availableQuantity: 200 }),
    ]);

    let monitorPrice = 20_000;
    let shortQuoteReady = false;
    const retryCallbacks: Array<() => void> = [];
    const submittedSymbols: string[] = [];
    const monitorPricesSeen: number[] = [];

    const context = createMonitorTaskContext({
      riskChecker: createRiskCheckerDouble({
        checkWarrantDistanceLiquidation: (_symbol, _isLongSymbol, currentMonitorPrice) => {
          monitorPricesSeen.push(currentMonitorPrice);
          return { shouldLiquidate: true, reason: '触发清仓阈值' };
        },
        refreshUnrealizedLossData: async () => ({ r1: 100, n1: 100 }),
      }),
    });

    const processor = createBusinessProcessor({
      queue,
      context,
      lastState,
      trader: createTraderDouble({
        executeSignals: async (signals) => {
          for (const signal of signals) {
            submittedSymbols.push(signal.symbol);
          }

          return { submittedCount: signals.length, submittedOrderIds: [] };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', monitorPrice)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1, 100)],
            ['BEAR.HK', shortQuoteReady ? createQuoteDouble('BEAR.HK', 0.9, 100) : null],
          ]),
      }),
      scheduleRetry: (callback) => {
        retryCallbacks.push(callback);
        return setTimeout(() => {}, 0);
      },
      clearRetry: () => {},
    });

    processor.start();
    queue.scheduleLatest({
      type: 'LIQUIDATION_DISTANCE_CHECK',
      dedupeKey: 'HSI.HK:LIQUIDATION_DISTANCE_CHECK:READY_SUBSET',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        monitorPrice: 19_500,
        long: {
          seatVersion: 2,
          symbol: 'BULL.HK',
          symbolName: 'BULL.HK',
        },
        short: {
          seatVersion: 3,
          symbol: 'BEAR.HK',
          symbolName: 'BEAR.HK',
        },
      },
    });

    await waitUntil(() => submittedSymbols.length === 1);
    expect(submittedSymbols).toEqual(['BULL.HK']);
    expect(retryCallbacks).toHaveLength(1);
    expect(monitorPricesSeen).toEqual([20_000]);

    monitorPrice = 20_100;
    shortQuoteReady = true;
    const retryCallback = retryCallbacks[0];
    if (!retryCallback) {
      throw new Error('retry callback should exist');
    }

    retryCallback();
    await waitUntil(() => submittedSymbols.length === 2);
    await processor.stopAndDrain();

    expect(submittedSymbols).toEqual(['BULL.HK', 'BEAR.HK']);
    expect(monitorPricesSeen).toEqual([20_000, 20_100]);
  });

  it('processes LIQUIDATION_DISTANCE_CHECK and keeps short direction consistent for triggered short side', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const lastState = createLastState();
    seedBearPosition(lastState);

    const submittedActions: string[] = [];
    const clearedDirections: Array<LiquidationTask['direction']> = [];
    const lossOffsetDirections: Array<LiquidationTask['direction']> = [];
    const refreshDirections: Array<LiquidationTask['direction']> = [];

    const context = createMonitorTaskContext({
      orderRecorder: createOrderRecorderDouble({
        clearBuyOrders: (_symbol, isLongSymbol) => {
          pushLiquidationTaskDirection(clearedDirections, isLongSymbol ? 'LONG' : 'SHORT');
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: (_monitorSymbol, isLongSymbol) => {
          pushLiquidationTaskDirection(lossOffsetDirections, isLongSymbol ? 'LONG' : 'SHORT');
          return 0;
        },
        startNewProtectionEpisode: () => {},
      },
      riskChecker: createRiskCheckerDouble({
        checkWarrantDistanceLiquidation: (_symbol, isLongSymbol) => {
          if (!isLongSymbol) {
            return { shouldLiquidate: true, reason: '触发清仓阈值' };
          }

          return { shouldLiquidate: false };
        },
        refreshUnrealizedLossData: async (_orderRecorder, _symbol, isLongSymbol) => {
          pushLiquidationTaskDirection(refreshDirections, isLongSymbol ? 'LONG' : 'SHORT');
          return { r1: 100, n1: 100 };
        },
      }),
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
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000)],
            ['BULL.HK', null],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 1, 100)],
          ]),
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleShortOnlyLiquidationDistanceCheckTask(
          queue,
          'HSI.HK:LIQUIDATION_DISTANCE_CHECK:SHORT_ONLY',
        );
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses[0]).toBe('processed');
    expect(submittedActions).toEqual(['SELLPUT']);
    expect(clearedDirections).toEqual(['SHORT']);
    expect(lossOffsetDirections).toEqual(['SHORT']);
    expect(refreshDirections).toEqual(['SHORT']);
  });
});
