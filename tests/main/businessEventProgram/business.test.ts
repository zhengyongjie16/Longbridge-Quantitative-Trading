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
import { projectVerificationSampleValues } from '../../../src/main/asyncProgram/indicatorCache/utils.js';
import type { BusinessEventProgramDeps } from '../../../src/main/businessEventProgram/types.js';
import type { CandlestickUpdatedEvent } from '../../../src/types/services.js';
import type { CandleData } from '../../../src/types/data.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type {
  IndicatorCache,
  VerificationSampleValues,
} from '../../../src/main/asyncProgram/indicatorCache/types.js';
import {
  createIndicatorUsageProfileDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createQuoteDouble,
  createSignalDouble,
  createStrategyDouble,
} from '../../helpers/testDoubles.js';
import { createLastState, waitUntil } from '../asyncProgram/utils.js';

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
      monitorTaskQueue: createMonitorTaskQueue(),
      indicatorCache,
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
      monitorTaskQueue: createMonitorTaskQueue(),
      indicatorCache,
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
      monitorTaskQueue: createMonitorTaskQueue(),
      indicatorCache,
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
      monitorTaskQueue: createMonitorTaskQueue(),
      indicatorCache,
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
      monitorTaskQueue: createMonitorTaskQueue(),
      indicatorCache,
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
});
