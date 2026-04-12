/**
 * 信号运行时缓存域单元测试
 *
 * 覆盖：midnightClear 停止并排空处理器、清空队列并释放信号、取消延迟信号、
 * 调用 postTradeConsistencyRuntime.midnightClear、indicatorCache.clearAll；
 * openRebuild 按 runtime owner 顺序恢复处理器并完成 rebuild baseline
 */
import { describe, expect, it } from 'bun:test';
import { createSignalRuntimeDomain } from '../../../../src/main/lifecycle/cacheDomains/signalRuntimeDomain.js';
import type { SignalRuntimeDomainDeps } from '../../../../src/main/lifecycle/cacheDomains/types.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskProcessor,
} from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/types.js';
import type { Processor } from '../../../../src/main/asyncProgram/types.js';
import type {
  BuyTaskType,
  SellTaskType,
  TaskQueue,
} from '../../../../src/main/asyncProgram/tradeTaskQueue/types.js';
import type { Signal } from '../../../../src/types/signal.js';
import type { OrderedMethod } from '../types.js';
import {
  createDelayedSignalVerifierDouble,
  createMonitorContextDouble,
} from '../../../helpers/testDoubles.js';

function createSignalDouble(): Signal {
  return {
    symbol: 'HSI.HK',
    symbolName: 'HSI',
    action: 'HOLD',
  };
}

function createOrderedRuntime(name: string, globalCalls: string[]) {
  const calls: string[] = [];

  const record = (method: OrderedMethod): void => {
    const entry = `${name}.${method}`;
    calls.push(entry);
    globalCalls.push(entry);
  };

  return {
    calls,
    stopAndDrain: async () => {
      record('stopAndDrain');
    },
    restart: () => {
      record('restart');
    },
    start: () => {
      record('start');
    },
    clearPending: () => {
      record('clearPending');
    },
  };
}

function createOrderedProcessor(name: string, globalCalls: string[]): Processor {
  return {
    start: () => {
      globalCalls.push(`${name}.start`);
    },
    stop: () => {},
    stopAndDrain: async () => {
      globalCalls.push(`${name}.stopAndDrain`);
    },
    restart: () => {
      globalCalls.push(`${name}.restart`);
    },
  };
}

function createTaskQueueDouble<TType extends string>(
  signals: ReadonlyArray<Signal>,
  onClear: () => void,
): TaskQueue<TType> {
  return {
    push: () => {},
    pop: () => null,
    isEmpty: () => signals.length === 0,
    removeTasks: () => 0,
    clearAll: (onRemove) => {
      onClear();
      for (const signal of signals) {
        onRemove?.({
          id: `${signal.symbol}-${signal.action}`,
          type: 'TEST' as TType,
          data: signal,
          monitorSymbol: signal.symbol,
          createdAt: 0,
        });
      }

      return signals.length;
    },
    onTaskAdded: () => () => {},
  };
}

function createMonitorTaskQueueDouble(onClear: () => void): MonitorTaskQueue<MonitorTaskDataMap> {
  return {
    scheduleLatest: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => {
      onClear();
      return 0;
    },
    onTaskAdded: () => () => {},
  };
}

describe('createSignalRuntimeDomain', () => {
  it('midnightClear 按全局顺序依次停止 runtime 与处理器，再执行后续清理步骤', async () => {
    const globalCalls: string[] = [];
    const buyProcessor = createOrderedProcessor('buyProcessor', globalCalls);
    const sellProcessor = createOrderedProcessor('sellProcessor', globalCalls);
    const monitorTaskProcessor = createOrderedProcessor(
      'monitorTaskProcessor',
      globalCalls,
    ) as MonitorTaskProcessor;
    const tradingRiskEventRuntime = createOrderedRuntime('tradingRiskEventRuntime', globalCalls);
    const monitorQuoteEventRuntime = createOrderedRuntime('monitorQuoteEventRuntime', globalCalls);
    const switchWakeupRuntime = createOrderedRuntime('switchWakeupRuntime', globalCalls);
    let releaseSignalCount = 0;
    let cancelAllCount = 0;

    const buyTaskQueue = createTaskQueueDouble<BuyTaskType>(
      [createSignalDouble(), createSignalDouble()],
      () => {
        globalCalls.push('buyTaskQueue.clearAll');
      },
    );
    const sellTaskQueue = createTaskQueueDouble<SellTaskType>([createSignalDouble()], () => {
      globalCalls.push('sellTaskQueue.clearAll');
    });
    const monitorTaskQueue = createMonitorTaskQueueDouble(() => {
      globalCalls.push('monitorTaskQueue.clearAll');
    });
    const monitorContexts = new Map([
      [
        'HSI.HK',
        createMonitorContextDouble({
          delayedSignalVerifier: createDelayedSignalVerifierDouble({
            cancelAll: () => {
              cancelAllCount += 1;
              globalCalls.push('delayedSignalVerifier.cancelAll');
              return 3;
            },
          }),
        }),
      ],
    ]);
    const postTradeConsistencyRuntime: SignalRuntimeDomainDeps['postTradeConsistencyRuntime'] = {
      abortWaiting: () => {
        globalCalls.push('postTradeConsistencyRuntime.abortWaiting');
      },
      resetAbort: () => {
        globalCalls.push('postTradeConsistencyRuntime.resetAbort');
      },
      start: () => {
        globalCalls.push('postTradeConsistencyRuntime.start');
      },
      stopAndDrain: async () => {
        globalCalls.push('postTradeConsistencyRuntime.stopAndDrain');
      },
      midnightClear: () => {
        globalCalls.push('postTradeConsistencyRuntime.midnightClear');
      },
      completeRebuildBaseline: () => {
        globalCalls.push('postTradeConsistencyRuntime.completeRebuildBaseline');
      },
    };
    const trader = {
      startOrderMonitorRuntime: () => {
        globalCalls.push('trader.startOrderMonitorRuntime');
      },
      stopOrderMonitorRuntimeAndDrain: async () => {
        globalCalls.push('trader.stopOrderMonitorRuntimeAndDrain');
      },
    };
    const deps: SignalRuntimeDomainDeps = {
      monitorContexts,
      buyProcessor,
      sellProcessor,
      monitorTaskProcessor,
      businessEventProgram: {
        start: () => {
          globalCalls.push('businessEventProgram.start');
        },
        stopAndDrain: async () => {
          globalCalls.push('businessEventProgram.stopAndDrain');
        },
      },
      tradingRiskEventRuntime: {
        start: () => {
          tradingRiskEventRuntime.start();
        },
        stopAndDrain: async () => {
          await tradingRiskEventRuntime.stopAndDrain();
        },
      },
      monitorQuoteEventRuntime: {
        start: () => {
          monitorQuoteEventRuntime.start();
        },
        stopAndDrain: async () => {
          await monitorQuoteEventRuntime.stopAndDrain();
        },
      },
      switchWakeupRuntime: {
        start: () => {
          switchWakeupRuntime.start();
        },
        stopAndDrain: async () => {
          await switchWakeupRuntime.stopAndDrain();
        },
      },
      quoteSubscriptionRuntime: {
        reconcileFromCurrentTruth: async () => {
          globalCalls.push('quoteSubscriptionRuntime.reconcileFromCurrentTruth');
        },
        start: () => {
          globalCalls.push('quoteSubscriptionRuntime.start');
        },
        stopAndDrain: async () => {
          globalCalls.push('quoteSubscriptionRuntime.stopAndDrain');
        },
      },
      autoSearchWakeupRuntime: {
        start: () => {
          globalCalls.push('autoSearchWakeupRuntime.start');
        },
        stopAndDrain: async () => {
          globalCalls.push('autoSearchWakeupRuntime.stopAndDrain');
        },
      },
      seatActivationDispatcher: {
        start: () => {
          globalCalls.push('seatActivationDispatcher.start');
        },
        stop: () => {
          globalCalls.push('seatActivationDispatcher.stop');
        },
      },
      trader,
      postTradeConsistencyRuntime,
      indicatorCache: {
        push: () => {},
        getAt: () => null,
        clearAll: () => {
          globalCalls.push('indicatorCache.clearAll');
        },
      },
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
      releaseSignal: () => {
        releaseSignalCount += 1;
        globalCalls.push('releaseSignal');
      },
    };

    const domain = createSignalRuntimeDomain(deps);
    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(globalCalls).toEqual([
      'postTradeConsistencyRuntime.abortWaiting',
      'businessEventProgram.stopAndDrain',
      'tradingRiskEventRuntime.stopAndDrain',
      'monitorQuoteEventRuntime.stopAndDrain',
      'switchWakeupRuntime.stopAndDrain',
      'autoSearchWakeupRuntime.stopAndDrain',
      'seatActivationDispatcher.stop',
      'monitorTaskProcessor.stopAndDrain',
      'buyProcessor.stopAndDrain',
      'sellProcessor.stopAndDrain',
      'trader.stopOrderMonitorRuntimeAndDrain',
      'quoteSubscriptionRuntime.stopAndDrain',
      'postTradeConsistencyRuntime.stopAndDrain',
      'buyTaskQueue.clearAll',
      'releaseSignal',
      'releaseSignal',
      'sellTaskQueue.clearAll',
      'releaseSignal',
      'monitorTaskQueue.clearAll',
      'delayedSignalVerifier.cancelAll',
      'postTradeConsistencyRuntime.midnightClear',
      'indicatorCache.clearAll',
    ]);
    expect(cancelAllCount).toBe(1);
    expect(releaseSignalCount).toBe(3);
  });

  it('openRebuild 按全局顺序先恢复 postTradeConsistencyRuntime，再启动 runtime 与处理器', async () => {
    const globalCalls: string[] = [];
    const buyProcessor = createOrderedProcessor('buyProcessor', globalCalls);
    const sellProcessor = createOrderedProcessor('sellProcessor', globalCalls);
    const monitorTaskProcessor = createOrderedProcessor(
      'monitorTaskProcessor',
      globalCalls,
    ) as MonitorTaskProcessor;
    const tradingRiskEventRuntime = createOrderedRuntime('tradingRiskEventRuntime', globalCalls);
    const monitorQuoteEventRuntime = createOrderedRuntime('monitorQuoteEventRuntime', globalCalls);
    const switchWakeupRuntime = createOrderedRuntime('switchWakeupRuntime', globalCalls);

    const trader = {
      startOrderMonitorRuntime: () => {
        globalCalls.push('trader.startOrderMonitorRuntime');
      },
      stopOrderMonitorRuntimeAndDrain: async () => {
        globalCalls.push('trader.stopOrderMonitorRuntimeAndDrain');
      },
    };

    const deps: SignalRuntimeDomainDeps = {
      monitorContexts: new Map(),
      buyProcessor,
      sellProcessor,
      monitorTaskProcessor,
      businessEventProgram: {
        start: () => {
          globalCalls.push('businessEventProgram.start');
        },
        stopAndDrain: async () => {
          globalCalls.push('businessEventProgram.stopAndDrain');
        },
      },
      tradingRiskEventRuntime: {
        start: () => {
          tradingRiskEventRuntime.start();
        },
        stopAndDrain: async () => {
          await tradingRiskEventRuntime.stopAndDrain();
        },
      },
      monitorQuoteEventRuntime: {
        start: () => {
          monitorQuoteEventRuntime.start();
        },
        stopAndDrain: async () => {
          await monitorQuoteEventRuntime.stopAndDrain();
        },
      },
      switchWakeupRuntime: {
        start: () => {
          switchWakeupRuntime.start();
        },
        stopAndDrain: async () => {
          await switchWakeupRuntime.stopAndDrain();
        },
      },
      quoteSubscriptionRuntime: {
        reconcileFromCurrentTruth: async () => {
          globalCalls.push('quoteSubscriptionRuntime.reconcileFromCurrentTruth');
        },
        start: () => {
          globalCalls.push('quoteSubscriptionRuntime.start');
        },
        stopAndDrain: async () => {
          globalCalls.push('quoteSubscriptionRuntime.stopAndDrain');
        },
      },
      autoSearchWakeupRuntime: {
        start: () => {
          globalCalls.push('autoSearchWakeupRuntime.start');
        },
        stopAndDrain: async () => {
          globalCalls.push('autoSearchWakeupRuntime.stopAndDrain');
        },
      },
      seatActivationDispatcher: {
        start: () => {
          globalCalls.push('seatActivationDispatcher.start');
        },
        stop: () => {
          globalCalls.push('seatActivationDispatcher.stop');
        },
      },
      trader,
      postTradeConsistencyRuntime: {
        abortWaiting: () => {
          globalCalls.push('postTradeConsistencyRuntime.abortWaiting');
        },
        resetAbort: () => {
          globalCalls.push('postTradeConsistencyRuntime.resetAbort');
        },
        start: () => {
          globalCalls.push('postTradeConsistencyRuntime.start');
        },
        stopAndDrain: async () => {
          globalCalls.push('postTradeConsistencyRuntime.stopAndDrain');
        },
        midnightClear: () => {
          globalCalls.push('postTradeConsistencyRuntime.midnightClear');
        },
        completeRebuildBaseline: () => {
          globalCalls.push('postTradeConsistencyRuntime.completeRebuildBaseline');
        },
      },
      indicatorCache: {
        push: () => {},
        getAt: () => null,
        clearAll: () => {
          globalCalls.push('indicatorCache.clearAll');
        },
      },
      buyTaskQueue: createTaskQueueDouble<BuyTaskType>([], () => {
        globalCalls.push('buyTaskQueue.clearAll');
      }),
      sellTaskQueue: createTaskQueueDouble<SellTaskType>([], () => {
        globalCalls.push('sellTaskQueue.clearAll');
      }),
      monitorTaskQueue: createMonitorTaskQueueDouble(() => {
        globalCalls.push('monitorTaskQueue.clearAll');
      }),
      releaseSignal: () => {
        globalCalls.push('releaseSignal');
      },
    };

    const domain = createSignalRuntimeDomain(deps);
    await domain.openRebuild({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(globalCalls).toEqual([
      'postTradeConsistencyRuntime.resetAbort',
      'postTradeConsistencyRuntime.start',
      'postTradeConsistencyRuntime.completeRebuildBaseline',
      'quoteSubscriptionRuntime.reconcileFromCurrentTruth',
      'quoteSubscriptionRuntime.start',
      'seatActivationDispatcher.start',
      'autoSearchWakeupRuntime.start',
      'businessEventProgram.start',
      'tradingRiskEventRuntime.start',
      'monitorQuoteEventRuntime.start',
      'switchWakeupRuntime.start',
      'buyProcessor.restart',
      'sellProcessor.restart',
      'monitorTaskProcessor.restart',
      'trader.startOrderMonitorRuntime',
    ]);
  });
});
