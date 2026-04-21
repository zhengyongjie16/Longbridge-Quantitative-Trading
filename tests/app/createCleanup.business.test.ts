/**
 * createCleanup 业务测试
 *
 * 功能：
 * - 验证退出时排空处理器、销毁延迟验证器与释放资源的流程与边界。
 */
import { describe, expect, it } from 'bun:test';
import type { CleanupContext } from '../../src/app/types.js';

import { createCleanup } from '../../src/app/shutdown/createCleanup.js';
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

  function createExitMock(
    exitCodes: number[],
    onExit?: (code: number) => void,
  ): (code?: number) => void {
    return (code = 0) => {
      exitCodes.push(code);
      onExit?.(code);
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

  function createExitSignalSyncPoint(
    createOverrides: (steps: string[]) => Partial<CleanupContext> = () => ({}),
  ) {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const exitCodes: number[] = [];
    const steps: string[] = [];
    let resolveExit: ((code: number) => void) | null = null;
    const exitCompleted = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const onceMock = createOnceMock(handlers);
    const exitMock = createExitMock(exitCodes, (code) => {
      resolveExit?.(code);
      resolveExit = null;
    });
    const cleanup = createCleanup(createCleanupDeps(steps, createOverrides(steps)));

    return {
      handlers,
      exitCodes,
      steps,
      cleanup,
      onceMock,
      exitMock,
      waitForExit: () => exitCompleted,
    };
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
      'businessEventProgram',
      'tradingRiskEventRuntime',
      'monitorQuoteEventRuntime',
      'switchWakeupRuntime',
      'autoSearchWakeupRuntime',
      'seatActivationDispatcher',
      'monitorTask',
      'buy',
      'sell',
      'stopOrderMonitorRuntimeAndDrain',
      'quoteSubscriptionRuntime',
      'postTradeConsistencyRuntime',
      'destroyVerifier',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
    expect(monitorState.lastMonitorSnapshot).toBeNull();
  });

  it('does not mutate detached snapshot objects during cleanup', async () => {
    const steps: string[] = [];
    const monitorState = createMonitorState('HSI.HK');
    const detachedSnapshot = monitorState.lastMonitorSnapshot;
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

    expect(detachedSnapshot?.kdj).toEqual({ k: 50, d: 50, j: 50 });
    expect(detachedSnapshot?.macd).toEqual({ macd: 0, dif: 0, dea: 0 });
  });

  it('resets market data runtime at the end of cleanup', async () => {
    const steps: string[] = [];
    const cleanup = createCleanup(createCleanupDeps(steps));

    await cleanup.execute();

    expect(steps).toEqual([
      'abortWaiting',
      'businessEventProgram',
      'tradingRiskEventRuntime',
      'monitorQuoteEventRuntime',
      'switchWakeupRuntime',
      'autoSearchWakeupRuntime',
      'seatActivationDispatcher',
      'monitorTask',
      'buy',
      'sell',
      'stopOrderMonitorRuntimeAndDrain',
      'quoteSubscriptionRuntime',
      'postTradeConsistencyRuntime',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
  });

  it('registers SIGINT/SIGTERM handlers and exits after cleanup', async () => {
    const originalOnce = process.once;
    const originalExit = process.exit;
    const signalHarness = createExitSignalSyncPoint();

    overrideProcessHandler('once', signalHarness.onceMock);
    overrideProcessHandler('exit', signalHarness.exitMock);

    try {
      signalHarness.cleanup.registerExitHandlers();
      expect(signalHarness.handlers.has('SIGINT')).toBe(true);
      expect(signalHarness.handlers.has('SIGTERM')).toBe(true);

      signalHarness.handlers.get('SIGINT')?.();
      await signalHarness.waitForExit();

      expect(signalHarness.exitCodes).toEqual([0]);
      expect(signalHarness.steps).toEqual([
        'abortWaiting',
        'businessEventProgram',
        'tradingRiskEventRuntime',
        'monitorQuoteEventRuntime',
        'switchWakeupRuntime',
        'autoSearchWakeupRuntime',
        'seatActivationDispatcher',
        'monitorTask',
        'buy',
        'sell',
        'stopOrderMonitorRuntimeAndDrain',
        'quoteSubscriptionRuntime',
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
      'businessEventProgram',
      'tradingRiskEventRuntime',
      'monitorQuoteEventRuntime',
      'switchWakeupRuntime',
      'autoSearchWakeupRuntime',
      'seatActivationDispatcher',
      'monitorTask',
      'buy',
      'sell',
      'stopOrderMonitorRuntimeAndDrain',
      'quoteSubscriptionRuntime',
      'postTradeConsistencyRuntime',
      'destroyVerifier',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
    expect(monitorState.lastMonitorSnapshot).toBeNull();
  });

  it('exits with code 1 when cleanup fails during signal handling', async () => {
    const originalOnce = process.once;
    const originalExit = process.exit;
    const signalHarness = createExitSignalSyncPoint((steps) => ({
      buyProcessor: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {
          steps.push('buy');
          throw new Error('buy failed');
        },
        restart: () => {},
      },
    }));

    overrideProcessHandler('once', signalHarness.onceMock);
    overrideProcessHandler('exit', signalHarness.exitMock);

    try {
      signalHarness.cleanup.registerExitHandlers();
      signalHarness.handlers.get('SIGTERM')?.();
      await signalHarness.waitForExit();

      expect(signalHarness.exitCodes).toEqual([1]);
      expect(signalHarness.steps).toEqual([
        'abortWaiting',
        'businessEventProgram',
        'tradingRiskEventRuntime',
        'monitorQuoteEventRuntime',
        'switchWakeupRuntime',
        'autoSearchWakeupRuntime',
        'seatActivationDispatcher',
        'monitorTask',
        'buy',
        'sell',
        'stopOrderMonitorRuntimeAndDrain',
        'quoteSubscriptionRuntime',
        'postTradeConsistencyRuntime',
        'clearIndicatorCache',
        'resetMarketData',
      ]);
    } finally {
      overrideProcessHandler('once', originalOnce);
      overrideProcessHandler('exit', originalExit);
    }
  });

  it('closes trading gate before draining processors during cleanup', async () => {
    const steps: string[] = [];
    const lastState = createLastState(new Map());
    const cleanup = createCleanup(
      createCleanupDeps(steps, {
        lastState,
        buyProcessor: {
          start: () => {},
          stop: () => {},
          stopAndDrain: async () => {
            steps.push(`buy:${lastState.isTradingEnabled ? 'open' : 'closed'}`);
          },
          restart: () => {},
        },
      }),
    );

    await cleanup.execute();

    expect(steps).toContain('buy:closed');
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
    expect(steps[1]).toBe('businessEventProgram');
    expect(steps[2]).toBe('tradingRiskEventRuntime');
    expect(steps[3]).toBe('monitorQuoteEventRuntime');
    expect(steps[4]).toBe('switchWakeupRuntime');
    expect(steps[5]).toBe('autoSearchWakeupRuntime');
    expect(steps[6]).toBe('seatActivationDispatcher');
    expect(steps[7]).toBe('monitorTask');
    expect(steps[steps.indexOf('stopOrderMonitorRuntimeAndDrain') - 1]).toBe('sell');
    expect(steps).toContain('buy');
    expect(steps).toContain('postTradeConsistencyRuntime');
  });
});
