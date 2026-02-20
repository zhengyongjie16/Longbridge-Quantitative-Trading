/**
 * cleanup 业务测试
 *
 * 功能：
 * - 验证退出时排空处理器、销毁延迟验证器与释放资源的流程与边界。
 */
import { describe, expect, it } from 'bun:test';

import { createCleanup } from '../../../src/services/cleanup/index.js';
import type { LastState, MonitorContext, MonitorState } from '../../../src/types/state.js';

function createMonitorState(monitorSymbol: string): MonitorState {
  return {
    monitorSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: {
      price: 20_000,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: { k: 50, d: 50, j: 50 },
      macd: { macd: 0, dif: 0, dea: 0 },
    },
    lastMonitorSnapshot: {
      price: 20_000,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: { k: 50, d: 50, j: 50 },
      macd: { macd: 0, dif: 0, dea: 0 },
    },
    lastCandleFingerprint: null,
  };
}

function createLastState(monitorStates: ReadonlyMap<string, MonitorState>): LastState {
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
    positionCache: {
      update: () => {},
      get: () => null,
    },
    cachedTradingDayInfo: null,
    monitorStates,
    allTradingSymbols: new Set(),
  };
}

describe('cleanup business flow', () => {
  it('drains processors, destroys delayed verifiers and releases monitor snapshots', async () => {
    const steps: string[] = [];
    const monitorState = createMonitorState('HSI.HK');
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        {
          delayedSignalVerifier: {
            destroy: () => {
              steps.push('destroyVerifier');
            },
          },
        } as unknown as MonitorContext,
      ],
    ]);
    const lastState = createLastState(new Map([['HSI.HK', monitorState]]));

    const cleanup = createCleanup({
      buyProcessor: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {
          steps.push('buy');
        },
        restart: () => {},
      },
      sellProcessor: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {
          steps.push('sell');
        },
        restart: () => {},
      },
      monitorTaskProcessor: {
        start: () => {},
        stopAndDrain: async () => {
          steps.push('monitorTask');
        },
      } as never,
      orderMonitorWorker: {
        start: () => {},
        schedule: () => {},
        stopAndDrain: async () => {
          steps.push('orderMonitorWorker');
        },
        clearLatestQuotes: () => {},
      },
      postTradeRefresher: {
        start: () => {},
        enqueue: () => {},
        stopAndDrain: async () => {
          steps.push('postTradeRefresher');
        },
        clearPending: () => {},
      },
      marketDataClient: {
        resetRuntimeSubscriptionsAndCaches: async () => {
          steps.push('resetMarketData');
        },
      } as never,
      monitorContexts,
      indicatorCache: {
        push: () => {},
        getAt: () => null,
        clearAll: () => {
          steps.push('clearIndicatorCache');
        },
      },
      lastState,
    });

    await cleanup.execute();

    expect(steps).toEqual([
      'buy',
      'sell',
      'monitorTask',
      'orderMonitorWorker',
      'postTradeRefresher',
      'destroyVerifier',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
    expect(monitorState.lastMonitorSnapshot).toBeNull();
  });

  it('resets market data runtime at the end of cleanup', async () => {
    const steps: string[] = [];

    const cleanup = createCleanup({
      buyProcessor: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {
          steps.push('buy');
        },
        restart: () => {},
      },
      sellProcessor: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {
          steps.push('sell');
        },
        restart: () => {},
      },
      monitorTaskProcessor: {
        start: () => {},
        stopAndDrain: async () => {
          steps.push('monitorTask');
        },
      } as never,
      orderMonitorWorker: {
        start: () => {},
        schedule: () => {},
        stopAndDrain: async () => {
          steps.push('orderMonitorWorker');
        },
        clearLatestQuotes: () => {},
      },
      postTradeRefresher: {
        start: () => {},
        enqueue: () => {},
        stopAndDrain: async () => {
          steps.push('postTradeRefresher');
        },
        clearPending: () => {},
      },
      marketDataClient: {
        resetRuntimeSubscriptionsAndCaches: async () => {
          steps.push('resetMarketData');
        },
      } as never,
      monitorContexts: new Map(),
      indicatorCache: {
        push: () => {},
        getAt: () => null,
        clearAll: () => {
          steps.push('clearIndicatorCache');
        },
      },
      lastState: createLastState(new Map()),
    });

    await cleanup.execute();

    expect(steps).toEqual([
      'buy',
      'sell',
      'monitorTask',
      'orderMonitorWorker',
      'postTradeRefresher',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
  });

  it('registers SIGINT/SIGTERM handlers and exits after cleanup', async () => {
    const handlers = new Map<string, () => void>();
    const exitCodes: number[] = [];
    const steps: string[] = [];

    const originalOnce = process.once;
    const originalExit = process.exit;

    (process as unknown as { once: typeof process.once }).once = ((
      event: string,
      handler: () => void,
    ) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.once;

    (process as unknown as { exit: typeof process.exit }).exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit;

    try {
      const cleanup = createCleanup({
        buyProcessor: {
          start: () => {},
          stop: () => {},
          stopAndDrain: async () => {
            steps.push('buy');
          },
          restart: () => {},
        },
        sellProcessor: {
          start: () => {},
          stop: () => {},
          stopAndDrain: async () => {
            steps.push('sell');
          },
          restart: () => {},
        },
        monitorTaskProcessor: {
          start: () => {},
          stopAndDrain: async () => {
            steps.push('monitorTask');
          },
        } as never,
        orderMonitorWorker: {
          start: () => {},
          schedule: () => {},
          stopAndDrain: async () => {
            steps.push('orderMonitorWorker');
          },
          clearLatestQuotes: () => {},
        },
        postTradeRefresher: {
          start: () => {},
          enqueue: () => {},
          stopAndDrain: async () => {
            steps.push('postTradeRefresher');
          },
          clearPending: () => {},
        },
        marketDataClient: {
          resetRuntimeSubscriptionsAndCaches: async () => {
            steps.push('resetMarketData');
          },
        } as never,
        monitorContexts: new Map(),
        indicatorCache: {
          push: () => {},
          getAt: () => null,
          clearAll: () => {
            steps.push('clearIndicatorCache');
          },
        },
        lastState: createLastState(new Map()),
      });

      cleanup.registerExitHandlers();
      expect(handlers.has('SIGINT')).toBe(true);
      expect(handlers.has('SIGTERM')).toBe(true);

      handlers.get('SIGINT')?.();
      await Bun.sleep(20);

      expect(exitCodes).toEqual([0]);
      expect(steps).toEqual([
        'buy',
        'sell',
        'monitorTask',
        'orderMonitorWorker',
        'postTradeRefresher',
        'clearIndicatorCache',
        'resetMarketData',
      ]);
    } finally {
      (process as unknown as { once: typeof process.once }).once = originalOnce;
      (process as unknown as { exit: typeof process.exit }).exit = originalExit;
    }
  });

  it('continues remaining cleanup steps and throws aggregate error when one step fails', async () => {
    const steps: string[] = [];
    const monitorState = createMonitorState('HSI.HK');
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        {
          delayedSignalVerifier: {
            destroy: () => {
              steps.push('destroyVerifier');
            },
          },
        } as unknown as MonitorContext,
      ],
    ]);

    const cleanup = createCleanup({
      buyProcessor: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {
          steps.push('buy');
          throw new Error('buy failed');
        },
        restart: () => {},
      },
      sellProcessor: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {
          steps.push('sell');
        },
        restart: () => {},
      },
      monitorTaskProcessor: {
        start: () => {},
        stopAndDrain: async () => {
          steps.push('monitorTask');
        },
      } as never,
      orderMonitorWorker: {
        start: () => {},
        schedule: () => {},
        stopAndDrain: async () => {
          steps.push('orderMonitorWorker');
        },
        clearLatestQuotes: () => {},
      },
      postTradeRefresher: {
        start: () => {},
        enqueue: () => {},
        stopAndDrain: async () => {
          steps.push('postTradeRefresher');
        },
        clearPending: () => {},
      },
      marketDataClient: {
        resetRuntimeSubscriptionsAndCaches: async () => {
          steps.push('resetMarketData');
        },
      } as never,
      monitorContexts,
      indicatorCache: {
        push: () => {},
        getAt: () => null,
        clearAll: () => {
          steps.push('clearIndicatorCache');
        },
      },
      lastState: createLastState(new Map([['HSI.HK', monitorState]])),
    });

    let caught: unknown = null;
    try {
      await cleanup.execute();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(steps).toEqual([
      'buy',
      'sell',
      'monitorTask',
      'orderMonitorWorker',
      'postTradeRefresher',
      'destroyVerifier',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
    expect(monitorState.lastMonitorSnapshot).toBeNull();
  });

  it('exits with code 1 when cleanup fails during signal handling', async () => {
    const handlers = new Map<string, () => void>();
    const exitCodes: number[] = [];
    const steps: string[] = [];

    const originalOnce = process.once;
    const originalExit = process.exit;

    (process as unknown as { once: typeof process.once }).once = ((
      event: string,
      handler: () => void,
    ) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.once;

    (process as unknown as { exit: typeof process.exit }).exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit;

    try {
      const cleanup = createCleanup({
        buyProcessor: {
          start: () => {},
          stop: () => {},
          stopAndDrain: async () => {
            steps.push('buy');
            throw new Error('buy failed');
          },
          restart: () => {},
        },
        sellProcessor: {
          start: () => {},
          stop: () => {},
          stopAndDrain: async () => {
            steps.push('sell');
          },
          restart: () => {},
        },
        monitorTaskProcessor: {
          start: () => {},
          stopAndDrain: async () => {
            steps.push('monitorTask');
          },
        } as never,
        orderMonitorWorker: {
          start: () => {},
          schedule: () => {},
          stopAndDrain: async () => {
            steps.push('orderMonitorWorker');
          },
          clearLatestQuotes: () => {},
        },
        postTradeRefresher: {
          start: () => {},
          enqueue: () => {},
          stopAndDrain: async () => {
            steps.push('postTradeRefresher');
          },
          clearPending: () => {},
        },
        marketDataClient: {
          resetRuntimeSubscriptionsAndCaches: async () => {
            steps.push('resetMarketData');
          },
        } as never,
        monitorContexts: new Map(),
        indicatorCache: {
          push: () => {},
          getAt: () => null,
          clearAll: () => {
            steps.push('clearIndicatorCache');
          },
        },
        lastState: createLastState(new Map()),
      });

      cleanup.registerExitHandlers();
      handlers.get('SIGTERM')?.();
      await Bun.sleep(20);

      expect(exitCodes).toEqual([1]);
      expect(steps).toEqual([
        'buy',
        'sell',
        'monitorTask',
        'orderMonitorWorker',
        'postTradeRefresher',
        'clearIndicatorCache',
        'resetMarketData',
      ]);
    } finally {
      (process as unknown as { once: typeof process.once }).once = originalOnce;
      (process as unknown as { exit: typeof process.exit }).exit = originalExit;
    }
  });
});
