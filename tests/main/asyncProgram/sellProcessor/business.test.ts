/**
 * sellProcessor 业务测试
 *
 * 功能：
 * - 验证卖出处理器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createSellTaskQueue } from '../../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createSellProcessor } from '../../../../src/main/asyncProgram/sellProcessor/index.js';
import { createPostTradeConsistencyRuntime } from '../../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createExternalApiRequestError } from '../../../../src/utils/apiFailure/index.js';

import type { Signal } from '../../../../src/types/signal.js';

import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createQuoteDouble,
  createSignalDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import {
  createLastState,
  createLastStateWithPositions,
  createMonitorContext,
  runProcessorFlow,
  waitUntil,
} from '../utils.js';

function requireSignal(signal: Signal | null): Signal {
  if (signal === null) {
    throw new Error('executed signal should exist');
  }

  return signal;
}

describe('sellProcessor business flow', () => {
  it('passes timeout and trading-calendar context into processSellSignals', async () => {
    const queue = createSellTaskQueue();
    const tradingCalendarSnapshot = new Map([
      ['2026-02-16', { isTradingDay: true, isHalfDay: true }],
    ]);
    const lastState = createLastStateWithPositions();
    lastState.isHalfDay = true;
    lastState.tradingCalendarSnapshot = tradingCalendarSnapshot;

    let capturedInput: {
      readonly signals: Signal[];
      readonly smartCloseTimeoutMinutes: number | null;
      readonly isHalfDay: boolean;
      readonly tradingCalendarSnapshot: ReadonlyMap<
        string,
        { readonly isTradingDay: boolean; readonly isHalfDay: boolean }
      >;
      readonly nowMs: number;
    } | null = null;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: (input: unknown) => {
        const typedInput = input as {
          readonly signals: Signal[];
          readonly smartCloseTimeoutMinutes: number | null;
          readonly isHalfDay: boolean;
          readonly tradingCalendarSnapshot: ReadonlyMap<
            string,
            { readonly isTradingDay: boolean; readonly isHalfDay: boolean }
          >;
          readonly nowMs: number;
        };
        capturedInput = typedInput;
        return [...typedInput.signals];
      },
      resetRiskCheckCooldown: () => {},
    };

    const trader = createTraderDouble({
      executeSignals: async () => ({ submittedCount: 1, submittedOrderIds: [] }),
    });

    const monitorContext = createMonitorContext({
      config: createMonitorConfigDouble({
        smartCloseTimeoutMinutes: 45,
      }),
    });

    let quoteRequest: Iterable<string> | null = null;
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        quoteRequest = symbols;
        return new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
        ]);
      },
    });

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => monitorContext,
      signalProcessor: signalProcessor,
      trader,
      marketDataClient,
      getLastState: () => lastState,
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => capturedInput !== null,
    });

    const captured = capturedInput as {
      readonly signals: Signal[];
      readonly smartCloseTimeoutMinutes: number | null;
      readonly isHalfDay: boolean;
      readonly tradingCalendarSnapshot: ReadonlyMap<
        string,
        { readonly isTradingDay: boolean; readonly isHalfDay: boolean }
      >;
      readonly nowMs: number;
    } | null;
    if (captured === null) {
      throw new Error('processSellSignals input not captured');
    }

    expect(captured.smartCloseTimeoutMinutes).toBe(45);
    expect(captured.isHalfDay).toBe(true);
    expect(captured.tradingCalendarSnapshot).toBe(tradingCalendarSnapshot);
    expect(Number.isFinite(captured.nowMs)).toBe(true);
    const requestedSymbols = [...quoteRequest!] as string[];
    expect(requestedSymbols.length).toBe(2);
    expect(requestedSymbols[0]).toBe('BULL.HK');
    expect(requestedSymbols[1]).toBe('BEAR.HK');
  });

  it('executes the processed sell signal returned by quantity resolution', async () => {
    const queue = createSellTaskQueue();
    const processedSignalUpdates = {
      quantity: 300,
      price: 1.23,
      lotSize: 100,
      relatedBuyOrderIds: ['buy-order-1'],
      reason: '智能平仓卖出',
    };
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
        const firstSignal = signals[0];
        if (!firstSignal) {
          throw new Error('sell signal should exist');
        }

        return [
          {
            ...firstSignal,
            ...processedSignalUpdates,
          },
        ];
      },
      resetRiskCheckCooldown: () => {},
    };

    let executedSignal: Signal | null = null;
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        executedSignal = signals[0] ?? null;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastStateWithPositions(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => executedSignal !== null,
    });

    const submittedSignal = requireSignal(executedSignal);
    expect(submittedSignal.quantity).toBe(processedSignalUpdates.quantity);
    expect(submittedSignal.price).toBe(processedSignalUpdates.price);
    expect(submittedSignal.lotSize).toBe(processedSignalUpdates.lotSize);
    expect(submittedSignal.relatedBuyOrderIds).toEqual(processedSignalUpdates.relatedBuyOrderIds);
    expect(submittedSignal.reason).toBe(processedSignalUpdates.reason);
    expect(signal.quantity).toBeUndefined();
    expect(signal.relatedBuyOrderIds).toBeUndefined();
  });

  it('waits for postTradeConsistencyRuntime freshness before processing sell task', async () => {
    const queue = createSellTaskQueue();
    const lastState = createLastState();

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });

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

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
        processSellCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => lastState,
      postTradeConsistencyRuntime,
      getCanProcessTask: () => true,
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });

    await Bun.sleep(50);
    expect(processSellCalls).toBe(0);

    postTradeConsistencyRuntime.start();

    await waitUntil(() => executeCalls === 1);
    await processor.stopAndDrain();

    expect(processSellCalls).toBe(1);
  });

  it('treats STOP_AND_DRAIN freshness abort as normal processor shutdown', async () => {
    const queue = createSellTaskQueue();
    const fatalErrors: unknown[] = [];
    let waitForFreshCalls = 0;
    let processSellCalls = 0;
    let executeCalls = 0;
    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: {
        applyRiskChecks: async () => [],
        processSellSignals: ({ signals }: { signals: Signal[] }) => {
          processSellCalls += 1;
          return signals;
        },
        resetRiskCheckCooldown: () => {},
      },
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { submittedCount: 1, submittedOrderIds: [] };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {
          waitForFreshCalls += 1;
          throw new Error('[postTradeConsistencyRuntime] freshness wait aborted: STOP_AND_DRAIN');
        },
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
    await waitUntil(() => waitForFreshCalls === 1);
    await processor.stopAndDrain();

    expect(fatalErrors).toEqual([]);
    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('skips stale-seat-version sell signal before sell quantity resolution', async () => {
    const queue = createSellTaskQueue();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: () => {
        processSellCalls += 1;
        return [];
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
    });

    let staleSignal = createSignalDouble('SELLCALL', 'BULL.HK');
    staleSignal = { ...staleSignal, seatVersion: 1 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: staleSignal });

    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it('drops sell signal when seat version changes after quantity resolution and before execution', async () => {
    const queue = createSellTaskQueue();
    const monitorContext = createMonitorContext();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
        processSellCalls += 1;
        monitorContext.symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => monitorContext,
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => processSellCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(executeCalls).toBe(0);
  });

  it('retries sell non-blockingly when execution-time quote is missing, then executes after quote warms', async () => {
    const queue = createSellTaskQueue();
    let quoteReady = false;
    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
        processSellCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });

    const scheduledRetries: Array<() => void> = [];
    let clearedRetryHandles = 0;
    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', quoteReady ? createQuoteDouble('BULL.HK', 1.1, 100) : null],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
      scheduleRetry: (callback) => {
        scheduledRetries.push(callback);
        return setTimeout(() => {}, 0);
      },
      clearRetry: () => {
        clearedRetryHandles += 1;
      },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
    await waitUntil(() => scheduledRetries.length === 1);
    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);

    quoteReady = true;
    const retryCallback = scheduledRetries[0];
    if (!retryCallback) {
      throw new Error('retry callback should exist');
    }

    retryCallback();
    await waitUntil(() => executeCalls === 1);
    await processor.stopAndDrain();
    expect(processSellCalls).toBe(1);
    expect(clearedRetryHandles).toBe(1);
  });

  it('drops sell execution when execution-time quote has invalid price instead of retrying', async () => {
    const queue = createSellTaskQueue();
    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
        processSellCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const scheduledRetries: Array<() => void> = [];
    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor,
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { submittedCount: 1, submittedOrderIds: [] };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 0, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
      scheduleRetry: (callback) => {
        scheduledRetries.push(callback);
        return setTimeout(() => {}, 0);
      },
      clearRetry: () => {},
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(scheduledRetries).toHaveLength(0);
    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('cancels pending sell retry during stopAndDrain and does not re-enqueue stale signal', async () => {
    const queue = createSellTaskQueue();
    let quoteReady = false;
    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
        processSellCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });

    const scheduledRetries: Array<() => void> = [];
    let clearedRetryHandles = 0;
    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', quoteReady ? createQuoteDouble('BULL.HK', 1.1, 100) : null],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
      scheduleRetry: (callback) => {
        scheduledRetries.push(callback);
        return setTimeout(() => {}, 0);
      },
      clearRetry: () => {
        clearedRetryHandles += 1;
      },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
    await waitUntil(() => scheduledRetries.length === 1);

    await processor.stopAndDrain();
    expect(clearedRetryHandles).toBe(1);

    quoteReady = true;
    const retryCallback = scheduledRetries[0];
    if (!retryCallback) {
      throw new Error('retry callback should exist');
    }

    retryCallback();
    await Bun.sleep(30);

    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('continues scheduling sell quote retries across multiple unresolved rounds', async () => {
    const queue = createSellTaskQueue();
    let quoteReady = false;
    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
        processSellCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    let clearedRetryHandles = 0;
    const scheduledRetries: Array<() => void> = [];
    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { submittedCount: 1, submittedOrderIds: [] };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', quoteReady ? createQuoteDouble('BULL.HK', 1.1, 100) : null],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
      scheduleRetry: (callback) => {
        scheduledRetries.push(callback);
        return setTimeout(() => {}, 0);
      },
      clearRetry: () => {
        clearedRetryHandles += 1;
      },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
    await waitUntil(() => scheduledRetries.length === 1);

    const firstRetry = scheduledRetries[0];
    if (!firstRetry) {
      throw new Error('first retry callback should exist');
    }

    firstRetry();
    await waitUntil(() => scheduledRetries.length === 2);
    expect(processSellCalls).toBe(0);

    quoteReady = true;
    const secondRetry = scheduledRetries[1];
    if (!secondRetry) {
      throw new Error('second retry callback should exist');
    }

    secondRetry();
    await waitUntil(() => executeCalls === 1);
    await processor.stopAndDrain();

    expect(processSellCalls).toBe(1);
    expect(clearedRetryHandles).toBe(1);
  });

  it('re-enqueues sell retry with detached indicators snapshot', async () => {
    const queue = createSellTaskQueue();
    let quoteReady = false;
    let executedSignal: Signal | null = null;
    const scheduledRetries: Array<() => void> = [];
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => signals,
      resetRiskCheckCooldown: () => {},
    };
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        executedSignal = signals[0] ?? null;
        return { submittedCount: signals.length, submittedOrderIds: [] };
      },
    });
    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', quoteReady ? createQuoteDouble('BULL.HK', 1.1, 100) : null],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
      scheduleRetry: (callback) => {
        scheduledRetries.push(callback);
        return setTimeout(() => {}, 0);
      },
      clearRetry: () => {},
    });

    const indicators1 = { K: 80 };
    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };
    signal = { ...signal, indicators1: indicators1 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
    await waitUntil(() => scheduledRetries.length === 1);

    indicators1.K = 20;
    quoteReady = true;
    const retryCallback = scheduledRetries[0];
    if (!retryCallback) {
      throw new Error('retry callback should exist');
    }

    retryCallback();
    await waitUntil(() => executedSignal !== null);
    await processor.stopAndDrain();

    const submittedSignal = requireSignal(executedSignal);
    expect(submittedSignal.indicators1).toEqual({ K: 80 });
    expect(submittedSignal.indicators1).not.toBe(indicators1);
  });

  it('does not register new sell retry after stopAndDrain begins while task is still in flight', async () => {
    const queue = createSellTaskQueue();
    let releaseQuotes:
      | ((quotes: Map<string, ReturnType<typeof createQuoteDouble> | null>) => void)
      | null = null;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => signals,
      resetRiskCheckCooldown: () => {},
    };

    const scheduledRetries: Array<() => void> = [];
    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          await new Promise<Map<string, ReturnType<typeof createQuoteDouble> | null>>((resolve) => {
            releaseQuotes = resolve;
          }),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
      scheduleRetry: (callback) => {
        scheduledRetries.push(callback);
        return setTimeout(() => {}, 0);
      },
      clearRetry: () => {},
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
    await waitUntil(() => releaseQuotes !== null);

    const drainPromise = processor.stopAndDrain();
    const resolveQuotes = releaseQuotes!;

    resolveQuotes(
      new Map([
        ['BULL.HK', null],
        ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
      ]),
    );
    await drainPromise;

    expect(scheduledRetries).toHaveLength(0);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('does not execute when processSellSignals turns signal into HOLD', async () => {
    const queue = createSellTaskQueue();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
        processSellCalls += 1;
        if (signals[0]) {
          signals[0] = { ...signals[0], action: 'HOLD' as const };
        }

        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => processSellCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(executeCalls).toBe(0);
  });

  it('sends submitOrder API failure to fatal channel', async () => {
    const queue = createSellTaskQueue();
    const submitError = createExternalApiRequestError({
      operation: 'TradeContext.submitOrder',
      attempts: 1,
      cause: new Error('submit timeout'),
    });
    const fatalErrors: unknown[] = [];
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => signals,
      resetRiskCheckCooldown: () => {},
    };

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor,
      trader: createTraderDouble({
        executeSignals: async () => {
          throw submitError;
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        let signal = createSignalDouble('SELLCALL', 'BULL.HK');
        signal = { ...signal, seatVersion: 2 };
        queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => fatalErrors.length === 1,
    });

    expect(fatalErrors).toEqual([submitError]);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('consumes non-submit external API failures without fatal channel escalation', async () => {
    const queue = createSellTaskQueue();
    const quoteError = createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quote timeout'),
    });
    const fatalErrors: unknown[] = [];
    let executeCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => signals,
      resetRiskCheckCooldown: () => {},
    };

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor,
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          throw quoteError;
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastStateWithPositions(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        let signal = createSignalDouble('SELLCALL', 'BULL.HK');
        signal = { ...signal, seatVersion: 2 };
        queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => executeCalls === 1,
    });

    expect(fatalErrors).toEqual([]);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('base gate blocks sell task before freshness wait and sell quantity resolution', async () => {
    const queue = createSellTaskQueue();

    let waitForFreshCalls = 0;
    let processSellCalls = 0;
    let executeCalls = 0;
    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: {
        applyRiskChecks: async () => [],
        processSellSignals: ({ signals }: { signals: Signal[] }) => {
          processSellCalls += 1;
          return signals;
        },
        resetRiskCheckCooldown: () => {},
      },
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { submittedCount: 1, submittedOrderIds: [] };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {
          waitForFreshCalls += 1;
        },
        onFreshReached: () => () => {},
      },
      getCanProcessTask: () => false,
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });

    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(waitForFreshCalls).toBe(0);
    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it('blocks final execution when lifecycle gate closes after sell-quantity resolution', async () => {
    const queue = createSellTaskQueue();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
        processSellCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });

    let gateCheckCount = 0;
    const dynamicGate = () => {
      gateCheckCount += 1;
      return gateCheckCount === 1;
    };

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        onFreshReached: () => () => {},
      },
      getCanProcessTask: dynamicGate,
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => processSellCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(executeCalls).toBe(0);
  });
});
