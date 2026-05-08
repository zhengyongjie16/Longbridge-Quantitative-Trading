/**
 * monitorTaskProcessor 业务测试
 *
 * 功能：
 * - 验证监控任务处理器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createMonitorTaskProcessor } from '../../../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { createExternalApiRequestError } from '../../../../src/utils/apiFailure/index.js';
import { API } from '../../../../src/constants/index.js';
import { createPositionLimitChecker } from '../../../../src/core/riskController/positionLimitChecker.js';
import { createRiskChecker } from '../../../../src/core/riskController/index.js';
import { createUnrealizedLossChecker } from '../../../../src/core/riskController/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../../../src/core/riskController/warrantRiskChecker.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskProcessorDeps,
  MonitorTaskStatus,
} from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTask } from '../../../../src/main/asyncProgram/monitorTaskQueue/types.js';
import type { MultiMonitorTradingConfig } from '../../../../src/types/config.js';

import { createTradingConfig as createTradingConfigFactory } from '../../../../mock/factories/configFactory.js';

import {
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createQuoteSubscriptionRuntimeDouble,
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
import type { CreateBusinessProcessorParams } from '../types.js';

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
    quoteSubscriptionRuntime = createQuoteSubscriptionRuntimeDouble(),
    onProcessed,
    getCanProcessTask,
    getCanTradeNow = () => true,
    periodicSwitchWakeupRuntime = {
      markWaitingEmpty: () => {},
      clearWaitingEmpty: () => {},
      replanRouteAfterTask: () => {},
    },
    onFatalError,
  } = params;

  return createMonitorTaskProcessor({
    monitorTaskQueue: queue,
    getMonitorContext: () => context,
    trader,
    marketDataClient,
    quoteSubscriptionRuntime,
    switchWakeupRuntime: {
      handoffPendingSwitch: () => {},
    },
    lastState,
    tradingConfig: createTradingConfig(),
    getCanTradeNow,
    periodicSwitchWakeupRuntime,
    ...(onProcessed ? { onProcessed } : {}),
    ...(getCanProcessTask ? { getCanProcessTask } : {}),
    ...(onFatalError ? { onFatalError } : {}),
  });
}

function scheduleSeatRefreshTask(
  queue: MonitorTaskProcessorDeps['monitorTaskQueue'],
  dedupeKey: string,
  overrides: Partial<MonitorTaskDataMap['SEAT_REFRESH']> = {},
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
      ...overrides,
    },
  });
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

describe('monitorTaskProcessor business flow', () => {
  it('hands AUTO_SYMBOL_TICK WAIT result to switchWakeupRuntime', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const handoffCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      seatVersion: number;
      driveKind: string;
    }> = [];
    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async (params) => {
          context.symbolRegistry.bumpSeatVersion('HSI.HK', params.direction);
          return {
            kind: 'WAIT',
            wakeups: [{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }],
            pendingDirection: params.direction,
          };
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
    const statuses: MonitorTaskStatus[] = [];

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      getMonitorContext: () => context,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: (params) => {
          handoffCalls.push({
            monitorSymbol: params.monitorSymbol,
            direction: params.direction,
            seatVersion: params.monitorContext.symbolRegistry.getSeatVersion(
              params.monitorSymbol,
              params.direction,
            ),
            driveKind: params.driveResult.kind,
          });
        },
      },
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
      },
      lastState: createLastState(),
      tradingConfig: createTradingConfig(),
      getCanTradeNow: () => true,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:WAKEUP',
          monitorSymbol: 'HSI.HK',
          data: {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['processed']);
    expect(handoffCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 3,
        driveKind: 'WAIT',
      },
    ]);
  });

  it('API 错误标记为普通任务失败且不进入 fatal 通道', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
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
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      getMonitorContext: () => context,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
      },
      lastState: createLastState(),
      tradingConfig: createTradingConfig(),
      getCanTradeNow: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:API_FAIL',
          monitorSymbol: 'HSI.HK',
          data: {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['failed']);
    expect(fatalErrors).toEqual([]);
  });

  it('非 API 程序错误进入 fatal 通道且不标记为普通任务失败', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => {
          throw new TypeError('periodic contract broken');
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
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      getMonitorContext: () => context,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
      },
      lastState: createLastState(),
      tradingConfig: createTradingConfig(),
      getCanTradeNow: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:FATAL',
          monitorSymbol: 'HSI.HK',
          data: {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => fatalErrors.length === 1 || statuses.length === 1,
      timeoutMs: 500,
    });

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBeInstanceOf(TypeError);
    expect(statuses).toEqual([]);
  });

  it('processes AUTO_SYMBOL_TICK with valid seat snapshot', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let maybeSearchCalls = 0;
    const intervalCallArgs: Array<{
      direction: 'LONG' | 'SHORT';
      currentTime: Date;
      canTradeNow: boolean;
    }> = [];

    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {
          maybeSearchCalls += 1;
        },
        evaluatePeriodicSwitchDue: async (params) => {
          intervalCallArgs.push(params);
          return {
            kind: 'NOOP',
          };
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
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(maybeSearchCalls).toBe(0);
    expect(intervalCallArgs).toHaveLength(1);
    expect(intervalCallArgs[0]?.direction).toBe('LONG');
    expect(intervalCallArgs[0]?.canTradeNow).toBeTrue();
    expect(intervalCallArgs[0]?.currentTime.getTime()).toBeGreaterThan(0);
    expect(statuses).toEqual(['processed']);
  });

  it('blocks AUTO_SYMBOL_TICK switch flow outside ordinary trade gate', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const intervalCallArgs: Array<{
      direction: 'LONG' | 'SHORT';
      currentTime: Date;
      canTradeNow: boolean;
    }> = [];

    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async (params) => {
          intervalCallArgs.push(params);
          return {
            kind: 'NOOP',
          };
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
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      getCanTradeNow: () => false,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:CURRENT_GATE',
          monitorSymbol: 'HSI.HK',
          data: {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(intervalCallArgs).toHaveLength(0);
    expect(statuses).toEqual(['blocked']);
  });

  it('marks periodic route waiting-empty when AUTO_SYMBOL_TICK leaves periodic pending state', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const markCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      symbol: string;
      seatVersion: number;
      lastSeatActivatedAt: number;
    }> = [];
    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({
          kind: 'NOOP',
        }),
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
          pending: true,
          pendingSinceMs: 50_000,
          blockedBy: 'ORDER_RECORDER',
        }),
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: (baseline) => {
          markCalls.push(baseline);
        },
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:PERIODIC_PENDING',
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
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['processed']);
    expect(markCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.HK',
        seatVersion: 2,
        lastSeatActivatedAt: 12_000,
      },
    ]);
  });

  it('clears periodic waiting-empty and replans route after processed AUTO_SYMBOL_TICK without pending state', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const clearCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      symbol: string;
      seatVersion: number;
      lastSeatActivatedAt: number;
    }> = [];
    const replanCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      symbol: string;
      seatVersion: number;
      lastSeatActivatedAt: number;
      taskTimeMs: number;
      status: MonitorTaskStatus;
    }> = [];
    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({
          kind: 'NOOP',
        }),
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
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: (baseline) => {
          clearCalls.push(baseline);
        },
        replanRouteAfterTask: (params) => {
          replanCalls.push(params);
        },
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:PERIODIC_REPLAN',
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
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['processed']);
    expect(clearCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.HK',
        seatVersion: 2,
        lastSeatActivatedAt: 12_000,
      },
    ]);

    expect(replanCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.HK',
        seatVersion: 2,
        lastSeatActivatedAt: 12_000,
        taskTimeMs: 70_000,
        status: 'processed',
      },
    ]);
  });

  it('returns blocked and hands periodic route back to runtime outside ordinary trade gate', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const replanCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      symbol: string;
      seatVersion: number;
      lastSeatActivatedAt: number;
      taskTimeMs: number;
      status: MonitorTaskStatus;
    }> = [];
    const clearCalls: string[] = [];
    let periodicDueCalls = 0;
    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => {
          periodicDueCalls += 1;
          return {
            kind: 'NOOP',
          };
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
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      getCanTradeNow: () => false,
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {
          clearCalls.push('clear');
        },
        replanRouteAfterTask: (params) => {
          replanCalls.push(params);
        },
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:PERIODIC_GATE_CLOSED',
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
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['blocked']);
    expect(periodicDueCalls).toBe(0);
    expect(clearCalls).toEqual([]);
    expect(replanCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.HK',
        seatVersion: 2,
        lastSeatActivatedAt: 12_000,
        taskTimeMs: 70_000,
        status: 'blocked',
      },
    ]);
  });

  it('skips AUTO_SYMBOL_TICK when seat snapshot is stale', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let maybeSearchCalls = 0;

    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {
          maybeSearchCalls += 1;
        },
        evaluatePeriodicSwitchDue: async () => ({
          kind: 'NOOP',
        }),
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
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(maybeSearchCalls).toBe(0);
    expect(statuses).toEqual(['skipped']);
  });

  it('skips AUTO_SYMBOL_TICK when seat activation baseline is stale', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let periodicDueCalls = 0;

    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => {
          periodicDueCalls += 1;
          return {
            kind: 'NOOP',
          };
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
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:STALE_ACTIVATION',
          monitorSymbol: 'HSI.HK',
          data: {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 13_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(periodicDueCalls).toBe(0);
    expect(statuses).toEqual(['skipped']);
  });

  it('skips stale SEAT_REFRESH when seatVersion no longer matches', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    let getQuotesCalls = 0;
    let clearLongWarrantCalls = 0;

    const context = createMonitorTaskContext({
      riskChecker: createRiskCheckerDouble({
        clearLongWarrantInfo: () => {
          clearLongWarrantCalls += 1;
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
          return new Map();
        },
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'HSI.HK:SEAT_REFRESH:LONG:STALE_VERSION', {
          seatVersion: 1,
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['skipped']);
    expect(getQuotesCalls).toBe(0);
    expect(clearLongWarrantCalls).toBe(0);
    expect(context.symbolRegistry.getSeatState('HSI.HK', 'LONG')).toMatchObject({
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
    });
  });

  it('skips AUTO_SYMBOL_TICK when lifecycle gate denies processing', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let maybeSearchCalls = 0;

    const context = createMonitorTaskContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {
          maybeSearchCalls += 1;
        },
        evaluatePeriodicSwitchDue: async () => ({
          kind: 'NOOP',
        }),
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
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG:GATE',
          monitorSymbol: 'HSI.HK',
          data: {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => seen.length === 1,
      timeoutMs: 500,
    });

    expect(seen[0]?.status).toBe('skipped');
    expect(maybeSearchCalls).toBe(0);
  });

  it('sends SEAT_REFRESH missing monitor context to fatal channel', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      getMonitorContext: () => null,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
      },
      lastState: createLastState(),
      tradingConfig: createTradingConfig(),
      getCanTradeNow: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'HSI.HK:SEAT_REFRESH:LONG:MISSING_CONTEXT');
      },
      waitCondition: () => fatalErrors.length === 1 || statuses.length === 1,
      timeoutMs: 500,
    });

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBeInstanceOf(Error);
    expect(statuses).toEqual([]);
  });

  it('processes SEAT_REFRESH and rebuilds long-side runtime caches', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let fetchAllOrdersCalls = 0;
    let refreshOrdersCalls = 0;
    let recalculateCalls = 0;
    let refreshUnrealizedCalls = 0;
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
          return new Map([
            ['BULL.HK', { ...createQuoteDouble('BULL.HK', 1.1, 100), name: 'BULL Name' }],
          ]);
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
    expect(fetchAllOrdersCalls).toBe(1);
    expect(refreshOrdersCalls).toBe(1);
    expect(recalculateCalls).toBe(1);
    expect(accountSnapshotCalls).toBe(1);
    expect(stockPositionCalls).toBe(1);
    expect(refreshUnrealizedCalls).toBe(1);
    expect(getQuotesCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    expect(context.longSymbolName).toBe('BULL Name');
    expect(lastState.cachedAccount?.totalCash).toBe(200_000);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(100);
  });

  it('processes SHORT SEAT_REFRESH and updates short-side symbol name', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    let refreshOrdersCalls = 0;
    const context = createMonitorTaskContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [],
        refreshOrdersFromAllOrdersForShort: async (_symbol, _allOrders, quote) => {
          refreshOrdersCalls += 1;
          expect(quote?.price).toBe(0.9);
          return [];
        },
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => ({ r1: 100, n1: 100 }),
      }),
    });
    context.symbolRegistry.updateSeatState('HSI.HK', 'SHORT', {
      ...context.symbolRegistry.getSeatState('HSI.HK', 'SHORT'),
      symbol: 'BEAR.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    } as never);

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([['BEAR.HK', { ...createQuoteDouble('BEAR.HK', 0.9, 100), name: 'BEAR Name' }]]),
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'HSI.HK:SEAT_REFRESH:SHORT', {
          direction: 'SHORT',
          seatVersion: 3,
          previousSymbol: 'OLD_BEAR.HK',
          nextSymbol: 'BEAR.HK',
          symbolName: 'BEAR.HK',
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['processed']);
    expect(refreshOrdersCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('HSI.HK', 'SHORT').status).toBe('ACTIVE');
    expect(context.shortSymbolName).toBe('BEAR Name');
  });

  it('marks SHORT SEAT_REFRESH business failure as EMPTY and clears short-side symbol name', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const context = createMonitorTaskContext({
      shortSymbolName: 'OLD_BEAR',
    });
    context.symbolRegistry.updateSeatState('HSI.HK', 'SHORT', {
      ...context.symbolRegistry.getSeatState('HSI.HK', 'SHORT'),
      symbol: 'BEAR.HK',
      status: 'ACTIVATING',
      callPrice: null,
    } as never);

    const processor = createBusinessProcessor({
      queue,
      context,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'HSI.HK:SEAT_REFRESH:SHORT:INVALID_CALL_PRICE', {
          direction: 'SHORT',
          seatVersion: 3,
          previousSymbol: 'OLD_BEAR.HK',
          nextSymbol: 'BEAR.HK',
          callPrice: null,
          symbolName: 'BEAR.HK',
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['processed']);
    expect(context.symbolRegistry.getSeatState('HSI.HK', 'SHORT')).toMatchObject({
      symbol: null,
      status: 'EMPTY',
      callPrice: null,
    });
    expect(context.shortSymbolName).toBe('');
    expect(context.symbolRegistry.getSeatVersion('HSI.HK', 'SHORT')).toBe(4);
  });

  it('waits for quote admission to resolve before rebuilding SEAT_REFRESH caches', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const admissionDeferred = createDeferred<null>();
    const admissionStartedDeferred = createDeferred<null>();
    let getQuotesCalls = 0;
    let fetchAllOrdersCalls = 0;
    let refreshOrdersCalls = 0;
    let refreshUnrealizedCalls = 0;
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
      riskChecker: createRiskCheckerDouble({
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

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]);
        },
      }),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
        waitForAdmission: async () => {
          admissionStartedDeferred.resolve(null);
          await admissionDeferred.promise;
        },
      }),
      onProcessed: createStatusCollector(statuses),
    });

    processor.start();
    scheduleSeatRefreshTask(queue, 'HSI.HK:SEAT_REFRESH:LONG:ADMISSION');

    await admissionStartedDeferred.promise;
    await Promise.resolve();

    expect(statuses).toEqual([]);
    expect(getQuotesCalls).toBe(0);
    expect(fetchAllOrdersCalls).toBe(0);
    expect(refreshOrdersCalls).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
    expect(context.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');

    admissionDeferred.resolve(null);
    await waitUntil(() => statuses.length === 1, 500);
    await processor.stopAndDrain();

    expect(statuses).toEqual(['processed']);
    expect(getQuotesCalls).toBe(1);
    expect(fetchAllOrdersCalls).toBe(1);
    expect(refreshOrdersCalls).toBe(1);
    expect(refreshUnrealizedCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
  });

  it('does not leave stale warrant risk cache after SEAT_REFRESH skips on changed seat', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const baseRiskChecker = createRiskChecker({
      warrantRiskChecker: createWarrantRiskChecker(),
      positionLimitChecker: createPositionLimitChecker({
        maxPositionNotional: null,
      }),
      unrealizedLossChecker: createUnrealizedLossChecker({
        maxUnrealizedLossPerSymbol: null,
      }),
    });
    const context = createMonitorTaskContext({
      riskChecker: {
        ...baseRiskChecker,
        refreshUnrealizedLossData: async (
          orderRecorder,
          symbol,
          isLongSymbol,
          quote,
          dailyLossOffset,
        ) => {
          const result = await baseRiskChecker.refreshUnrealizedLossData(
            orderRecorder,
            symbol,
            isLongSymbol,
            quote,
            dailyLossOffset,
          );
          const latestSeat = context.symbolRegistry.getSeatState('HSI.HK', 'LONG');
          context.symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
          context.symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
            ...latestSeat,
            symbol: 'NEXT_BULL.HK',
            status: 'SWITCHING',
            lastSwitchAt: Date.now(),
            callPrice: null,
          } as never);
          return result;
        },
      },
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
        scheduleSeatRefreshTask(queue, 'HSI.HK:SEAT_REFRESH:LONG:STALE_CACHE_LEAK');
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['skipped']);
    const riskCheckResult = context.riskChecker.checkWarrantRisk('NEXT_BULL.HK', 'BUYCALL', 20_010);
    expect(riskCheckResult.allowed).toBeTrue();
  });

  it('marks activating seat EMPTY after SEAT_REFRESH API retry is exhausted', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
    let getQuotesCalls = 0;
    const context = createMonitorTaskContext({
      longSymbolName: 'OLD_BULL',
    });
    context.symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
      ...context.symbolRegistry.getSeatState('HSI.HK', 'LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    } as never);
    const originalSeatVersion = context.symbolRegistry.getSeatVersion('HSI.HK', 'LONG');

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          throw createExternalApiRequestError({
            operation: 'test.seatRefreshQuotes',
            attempts: 1,
            cause: new Error('quote unavailable'),
          });
        },
      }),
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    processor.start();
    scheduleSeatRefreshTask(queue, 'HSI.HK:SEAT_REFRESH:LONG:API_FAIL');

    await waitUntil(() => statuses.length === 1 || fatalErrors.length === 1, 500);
    await Bun.sleep(Math.max(API.DEFAULT_RETRY_DELAY_MS - 100, 0));

    expect(statuses).toEqual(['failed']);
    expect(getQuotesCalls).toBe(1);

    await waitUntil(() => statuses.length === 2 || fatalErrors.length === 1, 800);
    await processor.stopAndDrain();

    expect(statuses).toEqual(['failed', 'failed']);
    expect(fatalErrors).toEqual([]);
    expect(getQuotesCalls).toBe(2);
    expect(context.symbolRegistry.getSeatState('HSI.HK', 'LONG')).toMatchObject({
      symbol: null,
      status: 'EMPTY',
      callPrice: null,
    });
    expect(context.longSymbolName).toBe('OLD_BULL');
    expect(context.symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBeGreaterThan(
      originalSeatVersion,
    );
  });

  it('sends SEAT_REFRESH non API order refresh errors to fatal channel', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
    let getQuotesCalls = 0;

    const context = createMonitorTaskContext({
      longSymbolName: 'OLD_BULL',
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
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'HSI.HK:SEAT_REFRESH:LONG:FAIL');
      },
      waitCondition: () => fatalErrors.length === 1 || statuses.length === 1,
      timeoutMs: 500,
    });

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBeInstanceOf(Error);
    expect(statuses).toEqual([]);
    expect(getQuotesCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('HSI.HK', 'LONG')).toMatchObject({
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    });
    expect(context.longSymbolName).toBe('OLD_BULL');
    expect(context.symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
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
});
