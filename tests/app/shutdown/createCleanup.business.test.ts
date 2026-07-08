/**
 * createCleanup 业务测试
 *
 * 功能：
 * - 验证退出时排空处理器、销毁延迟验证器与释放资源的流程与边界。
 */
import { describe, expect, it } from 'bun:test';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import {
  createDelayedSignalVerifierDouble,
  createMonitorContextDouble,
} from '../../helpers/testDoubles.js';
import { createCleanupDeps, createLastState, createMonitorState } from './utils.js';

describe('cleanup business flow', () => {
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
      'timeWakeupRuntime',
      'businessEventProgram',
      'tradingRiskEventRuntime',
      'monitorQuoteEventRuntime',
      'monitorDisplayRuntime',
      'tradingQuoteDisplayRuntime',
      'switchWakeupRuntime',
      'periodicSwitchWakeupRuntime',
      'autoSearchWakeupRuntime',
      'seatActivationDispatcher',
      'monitorTask',
      'seatRuntimeCleanupDispatcher',
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
      'timeWakeupRuntime',
      'businessEventProgram',
      'tradingRiskEventRuntime',
      'monitorQuoteEventRuntime',
      'monitorDisplayRuntime',
      'tradingQuoteDisplayRuntime',
      'switchWakeupRuntime',
      'periodicSwitchWakeupRuntime',
      'autoSearchWakeupRuntime',
      'seatActivationDispatcher',
      'monitorTask',
      'seatRuntimeCleanupDispatcher',
      'buy',
      'sell',
      'stopOrderMonitorRuntimeAndDrain',
      'quoteSubscriptionRuntime',
      'postTradeConsistencyRuntime',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
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
      'timeWakeupRuntime',
      'businessEventProgram',
      'tradingRiskEventRuntime',
      'monitorQuoteEventRuntime',
      'monitorDisplayRuntime',
      'tradingQuoteDisplayRuntime',
      'switchWakeupRuntime',
      'periodicSwitchWakeupRuntime',
      'autoSearchWakeupRuntime',
      'seatActivationDispatcher',
      'monitorTask',
      'seatRuntimeCleanupDispatcher',
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
    expect(steps[1]).toBe('timeWakeupRuntime');
    expect(steps[2]).toBe('businessEventProgram');
    expect(steps[3]).toBe('tradingRiskEventRuntime');
    expect(steps[4]).toBe('monitorQuoteEventRuntime');
    expect(steps[5]).toBe('monitorDisplayRuntime');
    expect(steps[6]).toBe('tradingQuoteDisplayRuntime');
    expect(steps[7]).toBe('switchWakeupRuntime');
    expect(steps[8]).toBe('periodicSwitchWakeupRuntime');
    expect(steps[9]).toBe('autoSearchWakeupRuntime');
    expect(steps[10]).toBe('seatActivationDispatcher');
    expect(steps[11]).toBe('monitorTask');
    expect(steps[12]).toBe('seatRuntimeCleanupDispatcher');
    expect(steps[steps.indexOf('stopOrderMonitorRuntimeAndDrain') - 1]).toBe('sell');
    expect(steps).toContain('buy');
    expect(steps).toContain('postTradeConsistencyRuntime');
  });
});
