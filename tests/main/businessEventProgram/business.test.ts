/**
 * businessEventProgram 业务测试
 *
 * 功能：
 * - 验证普通链路只由新的 K 线事件驱动
 * - 验证 start() 不会把已有 cache 主动折算成普通信号评估
 */
import { describe, expect, it } from 'bun:test';
import { Period } from 'longbridge';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';

import { createBusinessEventProgram } from '../../../src/main/businessEventProgram/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/types.js';
import { projectVerificationSampleValues } from '../../../src/main/asyncProgram/indicatorCache/utils.js';
import type { BusinessEventProgramDeps } from '../../../src/main/businessEventProgram/types.js';
import type { CandlestickUpdatedEvent } from '../../../src/types/services.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { CandleData } from '../../../src/types/data.js';
import type { Signal } from '../../../src/types/signal.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type {
  IndicatorCache,
  VerificationSampleValues,
} from '../../../src/main/asyncProgram/indicatorCache/types.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import {
  createDelayedSignalVerifierDouble,
  createIndicatorUsageProfileDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createQuoteDouble,
  createSignalDouble,
  createStrategyDouble,
  createTraderDouble,
  createQuoteSubscriptionRuntimeDouble,
  createPeriodicSwitchWakeupRuntimeDouble,
} from '../../helpers/testDoubles.js';
import { createLastState, waitUntil } from '../asyncProgram/utils.js';
import { createMonitorTaskProcessor } from '../../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { createSeatActivationDispatcher } from '../../../src/main/seatActivationDispatcher/index.js';

function createCandles(length: number, start: number, step: number): ReadonlyArray<CandleData> {
  const candles: CandleData[] = [];
  const baseTimestamp = 1_708_000_000_000;
  for (let index = 0; index < length; index += 1) {
    const close = start + index * step;
    candles.push({
      open: close - 0.2,
      high: close + 0.3,
      low: close - 0.4,
      close,
      volume: 5_000 + index,
      timestamp: baseTimestamp + index * 60_000,
    });
  }

  return candles;
}

function createMonitorContext(overrides: Partial<MonitorContext> = {}): MonitorContext {
  return createMonitorContextDouble({
    strategy: createStrategyDouble({
      generateSignals: () => ({
        immediateSignals: [createSignalDouble('BUYCALL', 'BULL.HK')],
        delayedSignals: [],
      }),
    }),
    ...overrides,
  });
}

function createIndicatorCacheRecorder(): {
  readonly indicatorCache: IndicatorCache;
  readonly pushes: Array<{
    readonly monitorSymbol: string;
    readonly values: VerificationSampleValues;
    readonly observedAtMs: number;
  }>;
} {
  const pushes: Array<{
    readonly monitorSymbol: string;
    readonly values: VerificationSampleValues;
    readonly observedAtMs: number;
  }> = [];

  return {
    indicatorCache: {
      push: (monitorSymbol, values, observedAtMs) => {
        pushes.push({
          monitorSymbol,
          values,
          observedAtMs,
        });
      },
      getClosest: () => null,
      clearAll: () => {},
    },
    pushes,
  };
}

function requireCandlestickEventClient(
  marketDataClient: ReturnType<typeof createMarketDataClientDouble>,
): BusinessEventProgramDeps['marketDataClient'] {
  return {
    ...marketDataClient,
    onCandlestickUpdated: marketDataClient.onCandlestickUpdated,
  };
}

function createOrdinarySignalTradingConfig(): ReturnType<typeof createTradingConfig> {
  const tradingConfig = createTradingConfig();
  return {
    ...tradingConfig,
    global: {
      ...tradingConfig.global,
      doomsdayProtection: false,
    },
  };
}

describe('businessEventProgram business flow', () => {
  it('does not clean existing direction tasks when ordinary signal projection sees empty seat', async () => {
    let listener: (event: CandlestickUpdatedEvent) => void = (_event: CandlestickUpdatedEvent) => {
      throw new Error('expected candlestick listener');
    };
    const marketDataClient = requireCandlestickEventClient(
      createMarketDataClientDouble({
        getCandlestickSnapshot: () => ({
          symbol: 'HSI.HK',
          period: Period.Min_1,
          version: 7,
          candles: createCandles(90, 120, 0.2),
          lastBarTimestamp: 1_708_005_340_000,
          lastBarConfirmed: true,
          initialized: true,
        }),
        getQuotes: async () => {
          throw new Error('businessEventProgram must not read realtime quotes');
        },
        onCandlestickUpdated: (nextListener) => {
          listener = nextListener;
          return () => {
            listener = (_event: CandlestickUpdatedEvent) => {
              throw new Error('candlestick listener already unsubscribed');
            };
          };
        },
      }),
    );
    const delayedCancelCalls: string[] = [];
    const monitorContext = createMonitorContext({
      delayedSignalVerifier: createDelayedSignalVerifierDouble({
        cancelAllForDirection: (_monitorSymbol, direction) => {
          delayedCancelCalls.push(direction);
          return 1;
        },
      }),
    });
    monitorContext.symbolRegistry.updateSeatStateWithVersionBump('HSI.HK', 'LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    const buyTaskQueue = createBuyTaskQueue();
    buyTaskQueue.push({
      type: 'IMMEDIATE_BUY',
      monitorSymbol: 'HSI.HK',
      data: createSignalDouble('BUYCALL', 'OLD_BULL.HK'),
    });
    const program = createBusinessEventProgram({
      marketDataClient,
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      lastState: createLastState(),
      tradingConfig: createOrdinarySignalTradingConfig(),
      buyTaskQueue,
      sellTaskQueue: createSellTaskQueue(),
      indicatorCache: createIndicatorCacheRecorder().indicatorCache,
      monitorDisplayRuntime: {
        requestRender: () => {},
      },
    });

    try {
      program.start();
      const snapshot = marketDataClient.getCandlestickSnapshot('HSI.HK', Period.Min_1);
      if (snapshot === null) {
        throw new Error('expected candlestick snapshot');
      }

      listener({
        symbol: 'HSI.HK',
        period: Period.Min_1,
        snapshot,
      });

      await waitUntil(() => monitorContext.state.lastMonitorSnapshot !== null);
      expect(buyTaskQueue.pop()?.data.symbol).toBe('OLD_BULL.HK');
      expect(buyTaskQueue.isEmpty()).toBeTrue();
      expect(delayedCancelCalls).toHaveLength(0);
    } finally {
      await program.stopAndDrain();
    }
  });

  it('requests monitor display after indicator pipeline succeeds', async () => {
    let listener: (event: CandlestickUpdatedEvent) => void = (_event: CandlestickUpdatedEvent) => {
      throw new Error('expected candlestick listener');
    };
    const marketDataClient = requireCandlestickEventClient(
      createMarketDataClientDouble({
        getCandlestickSnapshot: () => ({
          symbol: 'HSI.HK',
          period: Period.Min_1,
          version: 7,
          candles: createCandles(90, 120, 0.2),
          lastBarTimestamp: 1_708_005_340_000,
          lastBarConfirmed: true,
          initialized: true,
        }),
        getQuotes: async () => {
          throw new Error('businessEventProgram must not read realtime quotes');
        },
        onCandlestickUpdated: (nextListener) => {
          listener = nextListener;
          return () => {
            listener = (_event: CandlestickUpdatedEvent) => {
              throw new Error('candlestick listener already unsubscribed');
            };
          };
        },
      }),
    );
    const monitorContext = createMonitorContext();
    const renderRequests: Array<{
      readonly monitorSymbol: string;
      readonly monitorSnapshot: IndicatorSnapshot;
    }> = [];

    const program = createBusinessEventProgram({
      marketDataClient,
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      lastState: createLastState(),
      tradingConfig: createOrdinarySignalTradingConfig(),
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      indicatorCache: createIndicatorCacheRecorder().indicatorCache,
      monitorDisplayRuntime: {
        requestRender: (params: {
          readonly monitorSymbol: string;
          readonly monitorSnapshot: IndicatorSnapshot;
        }) => {
          renderRequests.push(params);
        },
      },
    });

    try {
      program.start();
      const snapshot = marketDataClient.getCandlestickSnapshot('HSI.HK', Period.Min_1);
      if (snapshot === null) {
        throw new Error('expected candlestick snapshot');
      }

      listener({
        symbol: 'HSI.HK',
        period: Period.Min_1,
        snapshot,
      });

      await waitUntil(() => renderRequests.length === 1);
      expect(renderRequests[0]?.monitorSymbol).toBe('HSI.HK');
      const latestMonitorSnapshot = monitorContext.state.lastMonitorSnapshot;
      expect(latestMonitorSnapshot).not.toBeNull();
      if (latestMonitorSnapshot === null) {
        throw new Error('expected latest monitor snapshot');
      }

      expect(renderRequests[0]?.monitorSnapshot).toEqual(latestMonitorSnapshot);
    } finally {
      await program.stopAndDrain();
    }
  });

  it('writes verification samples to indicatorCache immediately after indicator pipeline succeeds', async () => {
    let listener: (event: CandlestickUpdatedEvent) => void = (_event: CandlestickUpdatedEvent) => {
      throw new Error('expected candlestick listener');
    };
    const marketDataClient = requireCandlestickEventClient(
      createMarketDataClientDouble({
        getCandlestickSnapshot: () => ({
          symbol: 'HSI.HK',
          period: Period.Min_1,
          version: 7,
          candles: createCandles(90, 120, 0.2),
          lastBarTimestamp: 1_708_005_340_000,
          lastBarConfirmed: true,
          initialized: true,
        }),
        getQuotes: async () => {
          throw new Error('businessEventProgram must not read realtime quotes');
        },
        onCandlestickUpdated: (nextListener) => {
          listener = nextListener;
          return () => {
            listener = (_event: CandlestickUpdatedEvent) => {
              throw new Error('candlestick listener already unsubscribed');
            };
          };
        },
      }),
    );
    const monitorContext = createMonitorContext({
      indicatorProfile: createIndicatorUsageProfileDouble({
        verificationIndicatorsBySide: {
          buy: ['K', 'D'],
          sell: ['J'],
        },
      }),
    });
    const buyTaskQueue = createBuyTaskQueue();
    const { indicatorCache, pushes } = createIndicatorCacheRecorder();
    const originalDateNow = Date.now;
    Date.now = () => 1_710_000_000_123;

    const program = createBusinessEventProgram({
      marketDataClient,
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      lastState: createLastState(),
      tradingConfig: createOrdinarySignalTradingConfig(),
      buyTaskQueue,
      sellTaskQueue: createSellTaskQueue(),
      indicatorCache,
      monitorDisplayRuntime: {
        requestRender: () => {},
      },
    });

    try {
      program.start();
      const snapshot = marketDataClient.getCandlestickSnapshot('HSI.HK', Period.Min_1);
      if (snapshot === null) {
        throw new Error('expected candlestick snapshot');
      }

      listener({
        symbol: 'HSI.HK',
        period: Period.Min_1,
        snapshot,
      });

      await waitUntil(() => pushes.length === 1);
      const monitorSnapshot = monitorContext.state.lastMonitorSnapshot;
      expect(monitorSnapshot).not.toBeNull();
      if (monitorSnapshot === null) {
        throw new Error('expected monitor snapshot');
      }

      expect(pushes).toEqual([
        {
          monitorSymbol: 'HSI.HK',
          values: projectVerificationSampleValues(monitorSnapshot, ['K', 'D', 'J']),
          observedAtMs: 1_710_000_000_123,
        },
      ]);
    } finally {
      Date.now = originalDateNow;
      await program.stopAndDrain();
    }
  });

  it('uses the latest observedAtMs when multiple events collapse into one route run', async () => {
    let listener: (event: CandlestickUpdatedEvent) => void = (_event: CandlestickUpdatedEvent) => {
      throw new Error('expected candlestick listener');
    };
    const marketDataClient = requireCandlestickEventClient(
      createMarketDataClientDouble({
        getCandlestickSnapshot: () => ({
          symbol: 'HSI.HK',
          period: Period.Min_1,
          version: 7,
          candles: createCandles(90, 120, 0.2),
          lastBarTimestamp: 1_708_005_340_000,
          lastBarConfirmed: true,
          initialized: true,
        }),
        getQuotes: async () => {
          throw new Error('businessEventProgram must not read realtime quotes');
        },
        onCandlestickUpdated: (nextListener) => {
          listener = nextListener;
          return () => {
            listener = (_event: CandlestickUpdatedEvent) => {
              throw new Error('candlestick listener already unsubscribed');
            };
          };
        },
      }),
    );
    const monitorContext = createMonitorContext();
    const { indicatorCache, pushes } = createIndicatorCacheRecorder();
    const originalDateNow = Date.now;
    const observedTimes = [1_710_000_000_100, 1_710_000_000_200];
    let dateNowCallIndex = 0;
    Date.now = () => {
      const next = observedTimes[Math.min(dateNowCallIndex, observedTimes.length - 1)];
      dateNowCallIndex += 1;
      return next ?? observedTimes.at(-1) ?? 0;
    };

    const program = createBusinessEventProgram({
      marketDataClient,
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      lastState: createLastState(),
      tradingConfig: createOrdinarySignalTradingConfig(),
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      indicatorCache,
      monitorDisplayRuntime: {
        requestRender: () => {},
      },
    });

    try {
      program.start();
      const snapshot = marketDataClient.getCandlestickSnapshot('HSI.HK', Period.Min_1);
      if (snapshot === null) {
        throw new Error('expected candlestick snapshot');
      }

      listener({
        symbol: 'HSI.HK',
        period: Period.Min_1,
        snapshot,
      });

      listener({
        symbol: 'HSI.HK',
        period: Period.Min_1,
        snapshot,
      });

      await waitUntil(() => pushes.length === 1);
      expect(pushes[0]?.observedAtMs).toBe(observedTimes[1]);
    } finally {
      Date.now = originalDateNow;
      await program.stopAndDrain();
    }
  });

  it('does not write indicatorCache when indicator pipeline returns null snapshot', async () => {
    let listener: (event: CandlestickUpdatedEvent) => void = (_event: CandlestickUpdatedEvent) => {
      throw new Error('expected candlestick listener');
    };
    const marketDataClient = requireCandlestickEventClient(
      createMarketDataClientDouble({
        getCandlestickSnapshot: () => null,
        getQuotes: async () => {
          throw new Error('businessEventProgram must not read realtime quotes');
        },
        onCandlestickUpdated: (nextListener) => {
          listener = nextListener;
          return () => {
            listener = (_event: CandlestickUpdatedEvent) => {
              throw new Error('candlestick listener already unsubscribed');
            };
          };
        },
      }),
    );
    const monitorContext = createMonitorContext();
    const { indicatorCache, pushes } = createIndicatorCacheRecorder();

    const program = createBusinessEventProgram({
      marketDataClient,
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      lastState: createLastState(),
      tradingConfig: createOrdinarySignalTradingConfig(),
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      indicatorCache,
      monitorDisplayRuntime: {
        requestRender: () => {},
      },
    });

    program.start();

    listener({
      symbol: 'HSI.HK',
      period: Period.Min_1,
      snapshot: {
        symbol: 'HSI.HK',
        period: Period.Min_1,
        version: 0,
        candles: [],
        lastBarTimestamp: 0,
        lastBarConfirmed: false,
        initialized: false,
      },
    });

    await waitUntil(() => monitorContext.state.lastMonitorSnapshot === null);
    expect(pushes).toHaveLength(0);

    await program.stopAndDrain();
  });

  it('does not bootstrap existing candlestick cache on start', async () => {
    let getQuotesCalls = 0;
    let listener: ((event: CandlestickUpdatedEvent) => void) | null = null;

    const marketDataClient = requireCandlestickEventClient(
      createMarketDataClientDouble({
        getCandlestickSnapshot: () => ({
          symbol: 'HSI.HK',
          period: Period.Min_1,
          version: 3,
          candles: createCandles(80, 100, 0.3),
          lastBarTimestamp: 1_708_004_740_000,
          lastBarConfirmed: true,
          initialized: true,
        }),
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_100)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.2, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]);
        },
        onCandlestickUpdated: (nextListener) => {
          listener = nextListener;
          return () => {
            listener = null;
          };
        },
      }),
    );
    const monitorContext = createMonitorContext();
    const buyTaskQueue = createBuyTaskQueue();
    const { indicatorCache } = createIndicatorCacheRecorder();

    const program = createBusinessEventProgram({
      marketDataClient,
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      lastState: createLastState(),
      tradingConfig: createOrdinarySignalTradingConfig(),
      buyTaskQueue,
      sellTaskQueue: createSellTaskQueue(),
      indicatorCache,
      monitorDisplayRuntime: {
        requestRender: () => {},
      },
    });

    program.start();

    expect(listener).not.toBeNull();
    expect(getQuotesCalls).toBe(0);
    expect(monitorContext.state.lastMonitorSnapshot).toBeNull();
    expect(buyTaskQueue.isEmpty()).toBeTrue();

    await program.stopAndDrain();
  });

  it('advances latest snapshot and enqueues signals only after a new candlestick event', async () => {
    let listener: (event: CandlestickUpdatedEvent) => void = (_event: CandlestickUpdatedEvent) => {
      throw new Error('expected candlestick listener');
    };
    const marketDataClient = requireCandlestickEventClient(
      createMarketDataClientDouble({
        getCandlestickSnapshot: () => ({
          symbol: 'HSI.HK',
          period: Period.Min_1,
          version: 7,
          candles: createCandles(90, 120, 0.2),
          lastBarTimestamp: 1_708_005_340_000,
          lastBarConfirmed: true,
          initialized: true,
        }),
        getQuotes: async () => {
          throw new Error('businessEventProgram must not read realtime quotes');
        },
        onCandlestickUpdated: (nextListener) => {
          listener = nextListener;
          return () => {
            listener = (_event: CandlestickUpdatedEvent) => {
              throw new Error('candlestick listener already unsubscribed');
            };
          };
        },
      }),
    );
    const monitorContext = createMonitorContext();
    const buyTaskQueue = createBuyTaskQueue();
    const { indicatorCache } = createIndicatorCacheRecorder();

    const program = createBusinessEventProgram({
      marketDataClient,
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      lastState: createLastState(),
      tradingConfig: createOrdinarySignalTradingConfig(),
      buyTaskQueue,
      sellTaskQueue: createSellTaskQueue(),
      indicatorCache,
      monitorDisplayRuntime: {
        requestRender: () => {},
      },
    });

    program.start();
    const snapshot = marketDataClient.getCandlestickSnapshot('HSI.HK', Period.Min_1);
    if (snapshot === null) {
      throw new Error('expected candlestick snapshot');
    }

    listener({
      symbol: 'HSI.HK',
      period: Period.Min_1,
      snapshot,
    });

    await waitUntil(() => monitorContext.state.lastMonitorSnapshot !== null);
    expect(monitorContext.state.lastMonitorSnapshot).not.toBeNull();
    expect(buyTaskQueue.isEmpty()).toBeFalse();

    const queuedTask = buyTaskQueue.pop();
    expect(queuedTask?.type).toBe('IMMEDIATE_BUY');
    expect(queuedTask?.monitorSymbol).toBe('HSI.HK');

    await program.stopAndDrain();
  });

  it('adds delayed signal again after SEAT_REFRESH restores LONG seat to ACTIVE', async () => {
    let listener: (event: CandlestickUpdatedEvent) => void = (_event: CandlestickUpdatedEvent) => {
      throw new Error('expected candlestick listener');
    };
    let snapshotVersion = 7;
    const marketDataClientDouble = createMarketDataClientDouble({
      getCandlestickSnapshot: () => ({
        symbol: 'HSI.HK',
        period: Period.Min_1,
        version: snapshotVersion,
        candles: createCandles(90, 120, 0.2),
        lastBarTimestamp: 1_708_005_340_000 + snapshotVersion * 60_000,
        lastBarConfirmed: true,
        initialized: true,
      }),
      getQuotes: async () =>
        new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.2, 100)],
          ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1.1, 100)],
        ]),
      onCandlestickUpdated: (nextListener) => {
        listener = nextListener;
        return () => {
          listener = (_event: CandlestickUpdatedEvent) => {
            throw new Error('candlestick listener already unsubscribed');
          };
        };
      },
    });
    const marketDataClient = requireCandlestickEventClient(marketDataClientDouble);

    const delayedSignals = [createSignalDouble('BUYCALL', 'BULL.HK')];
    const addedSignals: Signal[] = [];
    const scheduledMonitorTaskTypes: string[] = [];
    const baseMonitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap> = {
      ...baseMonitorTaskQueue,
      scheduleLatest: (task) => {
        scheduledMonitorTaskTypes.push(task.type);
        baseMonitorTaskQueue.scheduleLatest(task);
      },
    };
    const monitorContext = createMonitorContext({
      strategy: createStrategyDouble({
        generateSignals: () => ({
          immediateSignals: [],
          delayedSignals,
        }),
      }),
      delayedSignalVerifier: createDelayedSignalVerifierDouble({
        addSignal: (params: { readonly signal: Signal }) => {
          addedSignals.push(params.signal);
        },
      }),
    });

    const tradingConfig = createOrdinarySignalTradingConfig();
    const lastState = createLastState();
    const seatActivationDispatcher = createSeatActivationDispatcher({
      tradingConfig,
      symbolRegistry: monitorContext.symbolRegistry,
      monitorTaskQueue,
    });
    const monitorTaskProcessor = createMonitorTaskProcessor({
      monitorTaskQueue,
      getMonitorContext: () => monitorContext,
      trader: createTraderDouble(),
      marketDataClient: marketDataClientDouble,
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
        reconcilePositionHoldFromCurrentTruth: async () => {},
      }),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeDouble(),
      lastState,
      tradingConfig,
      getCanTradeNow: () => true,
    });

    const { indicatorCache } = createIndicatorCacheRecorder();
    const program = createBusinessEventProgram({
      marketDataClient,
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      lastState,
      tradingConfig,
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      indicatorCache,
      monitorDisplayRuntime: {
        requestRender: () => {},
      },
    });

    try {
      seatActivationDispatcher.start();
      monitorContext.symbolRegistry.updateSeatStateWithVersionBump('HSI.HK', 'LONG', {
        ...monitorContext.symbolRegistry.getSeatState('HSI.HK', 'LONG'),
        symbol: 'BULL.HK',
        status: 'ACTIVATING',
        callPrice: 20_000,
      } as never);
      program.start();

      let snapshot = marketDataClient.getCandlestickSnapshot('HSI.HK', Period.Min_1);
      if (snapshot === null) {
        throw new Error('expected candlestick snapshot');
      }

      listener({
        symbol: 'HSI.HK',
        period: Period.Min_1,
        snapshot,
      });

      await waitUntil(() => monitorContext.state.lastMonitorSnapshot !== null);
      expect(addedSignals).toHaveLength(0);
      expect(scheduledMonitorTaskTypes).toContain('SEAT_REFRESH');
      expect(monitorTaskQueue.isEmpty()).toBeFalse();

      monitorTaskProcessor.start();
      await waitUntil(
        () => monitorContext.symbolRegistry.getSeatState('HSI.HK', 'LONG').status === 'ACTIVE',
      );
      expect(addedSignals).toHaveLength(0);

      snapshotVersion += 1;
      snapshot = marketDataClient.getCandlestickSnapshot('HSI.HK', Period.Min_1);
      if (snapshot === null) {
        throw new Error('expected candlestick snapshot');
      }

      listener({
        symbol: 'HSI.HK',
        period: Period.Min_1,
        snapshot,
      });

      await waitUntil(() => addedSignals.length === 1);
      expect(addedSignals[0]?.symbol).toBe('BULL.HK');
    } finally {
      await program.stopAndDrain();
      await monitorTaskProcessor.stopAndDrain();
      seatActivationDispatcher.stop();
    }
  });
});
