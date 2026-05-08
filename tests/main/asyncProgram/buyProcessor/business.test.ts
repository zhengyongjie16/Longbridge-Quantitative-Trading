/**
 * buyProcessor 业务测试
 *
 * 功能：
 * - 验证买入处理器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createBuyTaskQueue } from '../../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createBuyProcessor } from '../../../../src/main/asyncProgram/buyProcessor/index.js';
import { createExternalApiRequestError } from '../../../../src/utils/apiFailure/index.js';

import type { Signal } from '../../../../src/types/signal.js';

import {
  createDoomsdayProtectionDouble,
  createMarketDataClientDouble,
  createQuoteDouble,
  createSignalDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import { createLastState, createMonitorContext, runProcessorFlow } from '../utils.js';

describe('buyProcessor business flow', () => {
  it('runs risk pipeline then executes buy order with execution-time realtime quote price/lotSize', async () => {
    const queue = createBuyTaskQueue();
    const monitorContext = createMonitorContext();

    let riskCheckCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async (signals: Signal[]) => {
        riskCheckCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executed = 0;
    const submittedSnapshotRef: {
      current: { price: number | null | undefined; lotSize: number | null | undefined } | null;
    } = {
      current: null,
    };
    const trader = createTraderDouble({
      executeSignals: async (signals: ReadonlyArray<Signal>) => {
        executed += 1;
        const first = signals[0];
        submittedSnapshotRef.current = {
          price: first?.price,
          lotSize: first?.lotSize,
        };
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });

    const quoteRequests: string[][] = [];
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        quoteRequests.push([...symbols]);
        return new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
        ]);
      },
    });

    const processor = createBuyProcessor({
      taskQueue: queue,
      getMonitorContext: () => monitorContext,
      signalProcessor: signalProcessor,
      trader,
      marketDataClient,
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal.seatVersion = 2;

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({
          type: 'IMMEDIATE_BUY',
          monitorSymbol: 'HSI.HK',
          data: signal,
        });
      },
      waitCondition: () => executed === 1,
    });

    expect(riskCheckCalls).toBe(1);
    expect(quoteRequests).toHaveLength(2);
    expect(quoteRequests[0]).toEqual(['HSI.HK', 'BULL.HK', 'BEAR.HK']);
    expect(quoteRequests[1]).toEqual(['BULL.HK']);
    expect(submittedSnapshotRef.current).toEqual({
      price: 1.1,
      lotSize: 100,
    });
  });

  it('drops buy signal when execution-time realtime quote is missing', async () => {
    const queue = createBuyTaskQueue();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async () => {
        riskCalls += 1;
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

    const processor = createBuyProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', null],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal.seatVersion = 2;

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_BUY', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(riskCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it('treats risk rejection as successful handling and does not submit order', async () => {
    const queue = createBuyTaskQueue();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async () => {
        riskCalls += 1;
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

    const processor = createBuyProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal.seatVersion = 2;

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_BUY', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => riskCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(executeCalls).toBe(0);
  });

  it('drops stale-seat-version buy signal before risk checks', async () => {
    const queue = createBuyTaskQueue();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async () => {
        riskCalls += 1;
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

    const processor = createBuyProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    const staleSignal = createSignalDouble('BUYCALL', 'BULL.HK');
    staleSignal.seatVersion = 1;

    processor.start();
    queue.push({ type: 'IMMEDIATE_BUY', monitorSymbol: 'HSI.HK', data: staleSignal });

    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(riskCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it('drops buy signal when seat version changes after risk checks and before execution', async () => {
    const queue = createBuyTaskQueue();
    const monitorContext = createMonitorContext();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async (signals: Signal[]) => {
        riskCalls += 1;
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

    let quoteCalls = 0;
    const processor = createBuyProcessor({
      taskQueue: queue,
      getMonitorContext: () => monitorContext,
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          quoteCalls += 1;
          if (quoteCalls === 2) {
            monitorContext.symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
          }

          return new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]);
        },
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal.seatVersion = 2;

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_BUY', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => riskCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(executeCalls).toBe(0);
  });

  it('sends submitOrder API failure to fatal channel', async () => {
    const queue = createBuyTaskQueue();
    const submitError = createExternalApiRequestError({
      operation: 'TradeContext.submitOrder',
      attempts: 1,
      cause: new Error('submit timeout'),
    });
    const fatalErrors: unknown[] = [];
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async (signals: Signal[]) => signals,
      resetRiskCheckCooldown: () => {},
    };

    const processor = createBuyProcessor({
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
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        const signal = createSignalDouble('BUYCALL', 'BULL.HK');
        signal.seatVersion = 2;
        queue.push({ type: 'IMMEDIATE_BUY', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => fatalErrors.length === 1,
    });

    expect(fatalErrors).toEqual([submitError]);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('consumes non-submit external API failures without fatal channel escalation', async () => {
    const queue = createBuyTaskQueue();
    const quoteError = createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quote timeout'),
    });
    const fatalErrors: unknown[] = [];
    let executeCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async (signals: Signal[]) => signals,
      resetRiskCheckCooldown: () => {},
    };

    const processor = createBuyProcessor({
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
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        const signal = createSignalDouble('BUYCALL', 'BULL.HK');
        signal.seatVersion = 2;
        queue.push({ type: 'IMMEDIATE_BUY', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => executeCalls === 1,
    });

    expect(fatalErrors).toEqual([]);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('base gate blocks task before processTask when lifecycle gate is closed', async () => {
    const queue = createBuyTaskQueue();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async () => {
        riskCalls += 1;
        return [];
      },
      resetRiskCheckCooldown: () => {},
    };

    const processor = createBuyProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => false,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal.seatVersion = 2;

    processor.start();
    queue.push({ type: 'IMMEDIATE_BUY', monitorSymbol: 'HSI.HK', data: signal });

    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(riskCalls).toBe(0);
  });
});
