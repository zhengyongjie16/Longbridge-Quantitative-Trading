/**
 * 信号运行时缓存域单元测试
 *
 * 覆盖：midnightClear 停止并排空处理器、清空队列并释放信号、取消延迟信号、
 * clearLatestQuotes、clearPending、indicatorCache.clearAll；
 * openRebuild 重启处理器并 markFresh
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
      (calls).push('stopAndDrain');
    },
    restart: () => {
      (calls).push('restart');
    },
    start: () => {
      (calls).push('start');
    },
    clearLatestQuotes: () => {
      (calls).push('clearLatestQuotes');
    },
    clearPending: () => {
      (calls).push('clearPending');
    },
  };
}

describe('createSignalRuntimeDomain', () => {
  it('midnightClear 依次停止排空各处理器、清空队列并 releaseSignal、取消延迟信号、清理缓存', async () => {
    const buyProcessor = createMockProcessor();
    const sellProcessor = createMockProcessor();
    const monitorTaskProcessor = createMockProcessor();
    const orderMonitorWorker = createMockProcessor();
    const postTradeRefresher = createMockProcessor();
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
    const refreshGate = {
      getStatus: () => ({ staleVersion: 1 }),
      markFresh: (_v: number) => {},
    };

    const deps: SignalRuntimeDomainDeps = {
      monitorContexts,
      buyProcessor: buyProcessor as unknown as SignalRuntimeDomainDeps['buyProcessor'],
      sellProcessor: sellProcessor as unknown as SignalRuntimeDomainDeps['sellProcessor'],
      monitorTaskProcessor: monitorTaskProcessor as unknown as SignalRuntimeDomainDeps['monitorTaskProcessor'],
      orderMonitorWorker: orderMonitorWorker as unknown as SignalRuntimeDomainDeps['orderMonitorWorker'],
      postTradeRefresher: postTradeRefresher as unknown as SignalRuntimeDomainDeps['postTradeRefresher'],
      indicatorCache: indicatorCache as unknown as SignalRuntimeDomainDeps['indicatorCache'],
      buyTaskQueue: buyTaskQueue as unknown as SignalRuntimeDomainDeps['buyTaskQueue'],
      sellTaskQueue: sellTaskQueue as unknown as SignalRuntimeDomainDeps['sellTaskQueue'],
      monitorTaskQueue: monitorTaskQueue as unknown as SignalRuntimeDomainDeps['monitorTaskQueue'],
      refreshGate: refreshGate as unknown as SignalRuntimeDomainDeps['refreshGate'],
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
    expect(orderMonitorWorker.calls).toContain('clearLatestQuotes');
    expect(postTradeRefresher.calls).toContain('clearPending');
    expect(indicatorClearAllCount).toBe(1);
  });

  it('openRebuild 重启各处理器并调用 refreshGate.markFresh', () => {
    const buyProcessor = createMockProcessor();
    const sellProcessor = createMockProcessor();
    const monitorTaskProcessor = createMockProcessor();
    const orderMonitorWorker = createMockProcessor();
    const postTradeRefresher = createMockProcessor();
    let markFreshCalledWith: number | null = null as number | null;
    const refreshGate = {
      getStatus: () => ({ staleVersion: 42 }),
      markFresh: (v: number) => {
        markFreshCalledWith = v;
      },
    };

    const deps: SignalRuntimeDomainDeps = {
      monitorContexts: new Map(),
      buyProcessor: buyProcessor as unknown as SignalRuntimeDomainDeps['buyProcessor'],
      sellProcessor: sellProcessor as unknown as SignalRuntimeDomainDeps['sellProcessor'],
      monitorTaskProcessor: monitorTaskProcessor as unknown as SignalRuntimeDomainDeps['monitorTaskProcessor'],
      orderMonitorWorker: orderMonitorWorker as unknown as SignalRuntimeDomainDeps['orderMonitorWorker'],
      postTradeRefresher: postTradeRefresher as unknown as SignalRuntimeDomainDeps['postTradeRefresher'],
      indicatorCache: { clearAll: () => {} } as unknown as SignalRuntimeDomainDeps['indicatorCache'],
      buyTaskQueue: { clearAll: () => 0 } as unknown as SignalRuntimeDomainDeps['buyTaskQueue'],
      sellTaskQueue: { clearAll: () => 0 } as unknown as SignalRuntimeDomainDeps['sellTaskQueue'],
      monitorTaskQueue: { clearAll: () => 0 } as unknown as SignalRuntimeDomainDeps['monitorTaskQueue'],
      refreshGate: refreshGate as unknown as SignalRuntimeDomainDeps['refreshGate'],
      releaseSignal: () => {},
    };

    const domain = createSignalRuntimeDomain(deps);
    void domain.openRebuild({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(buyProcessor.calls).toContain('restart');
    expect(sellProcessor.calls).toContain('restart');
    expect(monitorTaskProcessor.calls).toContain('restart');
    expect(orderMonitorWorker.calls).toContain('start');
    expect(postTradeRefresher.calls).toContain('start');
    expect(markFreshCalledWith ?? null).toBe(42);
  });
});
