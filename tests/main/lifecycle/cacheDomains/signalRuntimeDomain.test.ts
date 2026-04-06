/**
 * 信号运行时缓存域单元测试
 *
 * 覆盖：midnightClear 停止并排空处理器、清空队列并释放信号、取消延迟信号、
 * 调用 postTradeConsistencyRuntime.midnightClear、indicatorCache.clearAll；
 * openRebuild 按 runtime owner 顺序恢复处理器并完成 rebuild baseline
 */
import { describe, it, expect } from 'bun:test';
import { createSignalRuntimeDomain } from '../../../../src/main/lifecycle/cacheDomains/signalRuntimeDomain.js';
import type { SignalRuntimeDomainDeps } from '../../../../src/main/lifecycle/cacheDomains/types.js';
import type { Signal } from '../../../../src/types/signal.js';

function createMockProcessor() {
  const calls: string[] = [];
  return {
    calls: calls as ReadonlyArray<string>,
    stopAndDrain: async () => {
      calls.push('stopAndDrain');
    },
    restart: () => {
      calls.push('restart');
    },
    start: () => {
      calls.push('start');
    },
    clearPending: () => {
      calls.push('clearPending');
    },
  };
}

describe('createSignalRuntimeDomain', () => {
  it('midnightClear 先停止 tradingRiskEventRuntime，再排空其他处理器并调用 runtime.midnightClear', async () => {
    const buyProcessor = createMockProcessor();
    const sellProcessor = createMockProcessor();
    const monitorTaskProcessor = createMockProcessor();
    const orderMonitorWorker = createMockProcessor();
    const tradingRiskEventRuntime = createMockProcessor();
    const postTradeConsistencyRuntime = createMockProcessor();
    let releaseSignalCount = 0;
    let clearAllBuy = 0;
    let clearAllSell = 0;
    let clearAllMonitor = 0;
    let cancelAllCount = 0;
    let indicatorClearAllCount = 0;

    const buyTaskQueue = {
      clearAll: (onRemove?: (task: { data: Signal }) => void) => {
        clearAllBuy += 1;
        if (onRemove) {
          onRemove({ data: {} as Signal });
          onRemove({ data: {} as Signal });
        }

        return 2;
      },
    };
    const sellTaskQueue = {
      clearAll: (onRemove?: (task: { data: Signal }) => void) => {
        clearAllSell += 1;
        if (onRemove) {
          onRemove({ data: {} as Signal });
        }

        return 1;
      },
    };
    const monitorTaskQueue = {
      clearAll: () => {
        clearAllMonitor += 1;
        return 0;
      },
    };
    const monitorContexts = new Map([
      [
        'HSI.HK',
        {
          delayedSignalVerifier: {
            cancelAll: () => {
              cancelAllCount += 1;
              return 3;
            },
          },
        },
      ],
    ]) as unknown as SignalRuntimeDomainDeps['monitorContexts'];
    const indicatorCache = {
      clearAll: () => {
        indicatorClearAllCount += 1;
      },
    };
    const deps: SignalRuntimeDomainDeps = {
      monitorContexts,
      buyProcessor: buyProcessor as unknown as SignalRuntimeDomainDeps['buyProcessor'],
      sellProcessor: sellProcessor as unknown as SignalRuntimeDomainDeps['sellProcessor'],
      monitorTaskProcessor:
        monitorTaskProcessor as unknown as SignalRuntimeDomainDeps['monitorTaskProcessor'],
      orderMonitorWorker:
        orderMonitorWorker as unknown as SignalRuntimeDomainDeps['orderMonitorWorker'],
      tradingRiskEventRuntime: {
        start: () => {
          tradingRiskEventRuntime.start();
        },
        stopAndDrain: async () => {
          await tradingRiskEventRuntime.stopAndDrain();
        },
      },
      postTradeConsistencyRuntime: {
        abortWaiting: () => {
          const runtime = postTradeConsistencyRuntime as unknown as {
            clearPending: () => void;
            calls: string[];
          };
          runtime.calls.push('abortWaiting');
        },
        resetAbort: () => {
          const runtime = postTradeConsistencyRuntime as unknown as {
            clearPending: () => void;
            calls: string[];
          };
          runtime.calls.push('resetAbort');
        },
        start: () => {
          postTradeConsistencyRuntime.start();
        },
        stopAndDrain: async () => {
          await postTradeConsistencyRuntime.stopAndDrain();
        },
        midnightClear: () => {
          postTradeConsistencyRuntime.clearPending();
        },
        completeRebuildBaseline: () => {
          postTradeConsistencyRuntime.restart();
        },
      },
      indicatorCache: indicatorCache as unknown as SignalRuntimeDomainDeps['indicatorCache'],
      buyTaskQueue: buyTaskQueue as unknown as SignalRuntimeDomainDeps['buyTaskQueue'],
      sellTaskQueue: sellTaskQueue as unknown as SignalRuntimeDomainDeps['sellTaskQueue'],
      monitorTaskQueue: monitorTaskQueue as unknown as SignalRuntimeDomainDeps['monitorTaskQueue'],
      releaseSignal: () => {
        releaseSignalCount += 1;
      },
    };

    const domain = createSignalRuntimeDomain(deps);
    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(buyProcessor.calls).toContain('stopAndDrain');
    expect(sellProcessor.calls).toContain('stopAndDrain');
    expect(clearAllBuy).toBe(1);
    expect(clearAllSell).toBe(1);
    expect(clearAllMonitor).toBe(1);
    expect(releaseSignalCount).toBe(3);
    expect(cancelAllCount).toBe(1);
    expect(tradingRiskEventRuntime.calls).toEqual(['stopAndDrain']);
    expect(postTradeConsistencyRuntime.calls).toEqual([
      'abortWaiting',
      'stopAndDrain',
      'clearPending',
    ]);
    expect(indicatorClearAllCount).toBe(1);
  });

  it('openRebuild 先完成 postTradeConsistencyRuntime baseline，再启动 tradingRiskEventRuntime 和其他处理器', async () => {
    const buyProcessor = createMockProcessor();
    const sellProcessor = createMockProcessor();
    const monitorTaskProcessor = createMockProcessor();
    const orderMonitorWorker = createMockProcessor();
    const tradingRiskEventRuntime = createMockProcessor();
    const runtimeCalls: string[] = [];

    const deps: SignalRuntimeDomainDeps = {
      monitorContexts: new Map(),
      buyProcessor: buyProcessor as unknown as SignalRuntimeDomainDeps['buyProcessor'],
      sellProcessor: sellProcessor as unknown as SignalRuntimeDomainDeps['sellProcessor'],
      monitorTaskProcessor:
        monitorTaskProcessor as unknown as SignalRuntimeDomainDeps['monitorTaskProcessor'],
      orderMonitorWorker:
        orderMonitorWorker as unknown as SignalRuntimeDomainDeps['orderMonitorWorker'],
      tradingRiskEventRuntime: {
        start: () => {
          tradingRiskEventRuntime.start();
        },
        stopAndDrain: async () => {
          await tradingRiskEventRuntime.stopAndDrain();
        },
      },
      postTradeConsistencyRuntime: {
        abortWaiting: () => {
          runtimeCalls.push('runtime.abortWaiting');
        },
        resetAbort: () => {
          runtimeCalls.push('runtime.resetAbort');
        },
        start: () => {
          runtimeCalls.push('runtime.start');
        },
        stopAndDrain: async () => {},
        midnightClear: () => {},
        completeRebuildBaseline: () => {
          runtimeCalls.push('runtime.completeRebuildBaseline');
        },
      },
      indicatorCache: {
        clearAll: () => {},
      } as unknown as SignalRuntimeDomainDeps['indicatorCache'],
      buyTaskQueue: { clearAll: () => 0 } as unknown as SignalRuntimeDomainDeps['buyTaskQueue'],
      sellTaskQueue: { clearAll: () => 0 } as unknown as SignalRuntimeDomainDeps['sellTaskQueue'],
      monitorTaskQueue: {
        clearAll: () => 0,
      } as unknown as SignalRuntimeDomainDeps['monitorTaskQueue'],
      releaseSignal: () => {},
    };

    const domain = createSignalRuntimeDomain(deps);
    await domain.openRebuild({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(runtimeCalls).toEqual([
      'runtime.resetAbort',
      'runtime.start',
      'runtime.completeRebuildBaseline',
    ]);
    expect(tradingRiskEventRuntime.calls).toEqual(['start']);
    expect(buyProcessor.calls).toContain('restart');
    expect(sellProcessor.calls).toContain('restart');
    expect(monitorTaskProcessor.calls).toContain('restart');
    expect(orderMonitorWorker.calls).toContain('start');
  });
});
