/**
 * createCleanup 业务测试
 *
 * 功能：
 * - 验证退出时排空处理器、销毁延迟验证器与释放资源的流程与边界。
 */
import { describe, expect, it } from 'bun:test';

import { createCleanup } from '../../src/app/createCleanup.js';
import {
  createDelayedSignalVerifierDouble,
  createMonitorContextDouble,
} from '../helpers/testDoubles.js';
import { createCleanupDeps, createLastState, createMonitorState } from './utils.js';

describe('cleanup business flow', () => {
  function createOnceMock(handlers: Map<string, () => void>): typeof process.once {
    return (event, listener) => {
      if (typeof event === 'string') {
        handlers.set(event, () => {
          Reflect.apply(listener, process, []);
        });
      }

      return process;
    };
  }

  function createExitMock(exitCodes: number[]): (code?: number) => void {
    return (code?: number) => {
      exitCodes.push(code ?? 0);
    };
  }

  function overrideProcessHandler(
    key: 'once' | 'exit',
    value: typeof process.once | ((code?: number) => void),
  ): void {
    Object.defineProperty(process, key, {
      value,
      configurable: true,
      writable: true,
    });
  }

  it('drains processors, destroys delayed verifiers and releases monitor snapshots', async () => {
    const steps: string[] = [];
    const monitorState = createMonitorState('HSI.HK');
    const monitorContexts = new Map([
      [
        'HSI.HK',
        createMonitorContextDouble({
          delayedSignalVerifier: createDelayedSignalVerifierDouble({
            destroy: () => {
              steps.push('destroyVerifier');
            },
          }),
        }),
      ],
    ]);
    const lastState = createLastState(new Map([['HSI.HK', monitorState]]));

    const cleanup = createCleanup(createCleanupDeps(steps, { monitorContexts, lastState }));

    await cleanup.execute();

    expect(steps).toEqual([
      'abortWaiting',
      'tradingRiskEventRuntime',
      'buy',
      'sell',
      'monitorTask',
      'orderMonitorWorker',
      'postTradeConsistencyRuntime',
      'destroyVerifier',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
    expect(monitorState.lastMonitorSnapshot).toBeNull();
  });

  it('resets market data runtime at the end of cleanup', async () => {
    const steps: string[] = [];
    const cleanup = createCleanup(createCleanupDeps(steps));

    await cleanup.execute();

    expect(steps).toEqual([
      'abortWaiting',
      'tradingRiskEventRuntime',
      'buy',
      'sell',
      'monitorTask',
      'orderMonitorWorker',
      'postTradeConsistencyRuntime',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
  });

  it('registers SIGINT/SIGTERM handlers and exits after cleanup', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const exitCodes: number[] = [];
    const steps: string[] = [];

    const originalOnce = process.once;
    const originalExit = process.exit;
    const onceMock = createOnceMock(handlers);
    const exitMock = createExitMock(exitCodes);

    overrideProcessHandler('once', onceMock);
    overrideProcessHandler('exit', exitMock);

    try {
      const cleanup = createCleanup(createCleanupDeps(steps));
      cleanup.registerExitHandlers();
      expect(handlers.has('SIGINT')).toBe(true);
      expect(handlers.has('SIGTERM')).toBe(true);

      handlers.get('SIGINT')?.();
      await Bun.sleep(20);

      expect(exitCodes).toEqual([0]);
      expect(steps).toEqual([
        'abortWaiting',
        'tradingRiskEventRuntime',
        'buy',
        'sell',
        'monitorTask',
        'orderMonitorWorker',
        'postTradeConsistencyRuntime',
        'clearIndicatorCache',
        'resetMarketData',
      ]);
    } finally {
      overrideProcessHandler('once', originalOnce);
      overrideProcessHandler('exit', originalExit);
    }
  });

  it('continues remaining cleanup steps and throws aggregate error when one step fails', async () => {
    const steps: string[] = [];
    const monitorState = createMonitorState('HSI.HK');
    const monitorContexts = new Map([
      [
        'HSI.HK',
        createMonitorContextDouble({
          delayedSignalVerifier: createDelayedSignalVerifierDouble({
            destroy: () => {
              steps.push('destroyVerifier');
            },
          }),
        }),
      ],
    ]);
    const lastState = createLastState(new Map([['HSI.HK', monitorState]]));

    const cleanup = createCleanup(
      createCleanupDeps(steps, {
        monitorContexts,
        lastState,
        buyProcessor: {
          start: () => {},
          stop: () => {},
          stopAndDrain: async () => {
            steps.push('buy');
            throw new Error('buy failed');
          },
          restart: () => {},
        },
      }),
    );

    let caught: unknown = null;
    try {
      await cleanup.execute();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(steps).toEqual([
      'abortWaiting',
      'tradingRiskEventRuntime',
      'buy',
      'sell',
      'monitorTask',
      'orderMonitorWorker',
      'postTradeConsistencyRuntime',
      'destroyVerifier',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
    expect(monitorState.lastMonitorSnapshot).toBeNull();
  });

  it('exits with code 1 when cleanup fails during signal handling', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const exitCodes: number[] = [];
    const steps: string[] = [];

    const originalOnce = process.once;
    const originalExit = process.exit;
    const onceMock = createOnceMock(handlers);
    const exitMock = createExitMock(exitCodes);

    overrideProcessHandler('once', onceMock);
    overrideProcessHandler('exit', exitMock);

    try {
      const cleanup = createCleanup(
        createCleanupDeps(steps, {
          buyProcessor: {
            start: () => {},
            stop: () => {},
            stopAndDrain: async () => {
              steps.push('buy');
              throw new Error('buy failed');
            },
            restart: () => {},
          },
        }),
      );
      cleanup.registerExitHandlers();
      handlers.get('SIGTERM')?.();
      await Bun.sleep(20);

      expect(exitCodes).toEqual([1]);
      expect(steps).toEqual([
        'abortWaiting',
        'tradingRiskEventRuntime',
        'buy',
        'sell',
        'monitorTask',
        'orderMonitorWorker',
        'postTradeConsistencyRuntime',
        'clearIndicatorCache',
        'resetMarketData',
      ]);
    } finally {
      overrideProcessHandler('once', originalOnce);
      overrideProcessHandler('exit', originalExit);
    }
  });

  it('aborts freshness waiters before draining blocked processors', async () => {
    const steps: string[] = [];
    let releaseBlockedProcessor: (() => void) | null = null;
    const blockedProcessor = new Promise<void>((resolve) => {
      releaseBlockedProcessor = resolve;
    });

    const cleanup = createCleanup(
      createCleanupDeps(steps, {
        buyProcessor: {
          start: () => {},
          stop: () => {},
          stopAndDrain: async () => {
            steps.push('buy');
            await blockedProcessor;
          },
          restart: () => {},
        },
        postTradeConsistencyRuntime: {
          ...createCleanupDeps([], {}).postTradeConsistencyRuntime,
          abortWaiting: () => {
            steps.push('abortWaiting');
            releaseBlockedProcessor?.();
          },
          stopAndDrain: async () => {
            steps.push('postTradeConsistencyRuntime');
          },
        },
      }),
    );

    const outcome = await Promise.race([
      cleanup.execute().then(() => 'done' as const),
      Bun.sleep(50).then(() => 'timeout' as const),
    ]);

    if (outcome === 'timeout') {
      throw new Error('cleanup.execute timed out while waiting for blocked processor');
    }

    expect(outcome).toBe('done');
    expect(steps[0]).toBe('abortWaiting');
    expect(steps[1]).toBe('tradingRiskEventRuntime');
    expect(steps).toContain('buy');
    expect(steps).toContain('postTradeConsistencyRuntime');
  });
});
