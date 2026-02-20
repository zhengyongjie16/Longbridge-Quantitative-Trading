/**
 * 主循环延迟全链路性能测试（贴合真实订阅模式）
 *
 * 功能：
 * - 启动阶段：模拟订阅相关 API 每次调用固定延迟 200ms
 * - 主循环阶段：模拟真实逻辑，仅从本地缓存读取行情和 K 线（无 API 延迟）
 * - 构造 5 个监控标的并执行真实 mainProgram -> processMonitor -> indicatorPipeline 链路
 * - 校验每轮都完成 RSI/KDJ/MACD/MFI/EMA/PSY 指标计算，并统计循环耗时
 */
import { describe, expect, it } from 'bun:test';
import type { Candlestick, Period, TradeSessions } from 'longport';
import { TRADING } from '../../src/constants/index.js';
import { mainProgram } from '../../src/main/mainProgram/index.js';
import { createMonitorContext } from '../../src/services/monitorContext/index.js';
import { createHangSengMultiIndicatorStrategy } from '../../src/core/strategy/index.js';
import { createBuyTaskQueue, createSellTaskQueue } from '../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createIndicatorCache } from '../../src/main/asyncProgram/indicatorCache/index.js';
import { initMonitorState } from '../../src/utils/helpers/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import {
  createDoomsdayProtectionDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createRiskCheckerDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

import type { CandleData } from '../../src/types/data.js';
import type { MonitorConfig, MultiMonitorTradingConfig } from '../../src/types/config.js';
import type { MonitorContext, MonitorState, LastState } from '../../src/types/state.js';
import type { Quote } from '../../src/types/quote.js';
import type { SymbolRegistry, SeatState } from '../../src/types/seat.js';
import type { MainProgramContext } from '../../src/main/mainProgram/types.js';
import type { MarketDataClient } from '../../src/types/services.js';
import type { AutoSymbolManager } from '../../src/services/autoSymbolManager/types.js';
import type { DelayedSignalVerifier } from '../../src/main/asyncProgram/delayedSignalVerifier/types.js';
import type { DailyLossTracker, UnrealizedLossMonitor } from '../../src/core/riskController/types.js';
import type { MonitorTaskData, MonitorTaskType } from '../../src/main/asyncProgram/monitorTaskProcessor/types.js';

type DelayedApiMethod =
  | 'subscribeSymbols'
  | 'unsubscribeSymbols'
  | 'subscribeCandlesticks'
  | 'isTradingDay'
  | 'resetRuntimeSubscriptionsAndCaches'
  | 'getQuoteContext';

type ApiCallEvent = {
  readonly stage: 'startup' | 'main-loop';
  readonly iteration: number | null;
  readonly method: DelayedApiMethod;
  readonly elapsedMs: number;
};

type IterationMetric = {
  readonly iteration: number;
  readonly loopLatencyMs: number;
  readonly apiCallCount: number;
  readonly apiLatencyTotalMs: number;
};

type MultiMonitorSeatEntry = {
  longState: SeatState;
  shortState: SeatState;
  longVersion: number;
  shortVersion: number;
};

function createNoopAutoSymbolManager(): AutoSymbolManager {
  return {
    maybeSearchOnTick: async () => {},
    maybeSwitchOnDistance: async () => {},
    hasPendingSwitch: () => false,
    resetAllState: () => {},
  };
}

function createNoopDelayedSignalVerifier(): DelayedSignalVerifier {
  return {
    addSignal: () => {},
    cancelAllForSymbol: () => {},
    cancelAllForDirection: () => 0,
    cancelAll: () => 0,
    getPendingCount: () => 0,
    onVerified: () => {},
    destroy: () => {},
  };
}

function createNoopDailyLossTracker(): DailyLossTracker {
  return {
    resetAll: () => {},
    recalculateFromAllOrders: () => {},
    recordFilledOrder: () => {},
    getLossOffset: () => 0,
  };
}

function createNoopUnrealizedLossMonitor(): UnrealizedLossMonitor {
  return {
    monitorUnrealizedLoss: async () => {},
  };
}

function createSeatState(symbol: string): SeatState {
  return {
    symbol,
    status: 'READY',
    lastSwitchAt: null,
    lastSearchAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
}

function createMultiMonitorSymbolRegistry(
  monitorConfigs: ReadonlyArray<MonitorConfig>,
): SymbolRegistry {
  const seatMap = new Map<string, MultiMonitorSeatEntry>();

  for (const monitorConfig of monitorConfigs) {
    seatMap.set(monitorConfig.monitorSymbol, {
      longState: createSeatState(monitorConfig.longSymbol),
      shortState: createSeatState(monitorConfig.shortSymbol),
      longVersion: 1,
      shortVersion: 1,
    });
  }

  return {
    getSeatState(monitorSymbol: string, direction: 'LONG' | 'SHORT'): SeatState {
      const entry = seatMap.get(monitorSymbol);
      if (!entry) {
        throw new Error(`missing seat entry for monitorSymbol=${monitorSymbol}`);
      }
      return direction === 'LONG' ? entry.longState : entry.shortState;
    },
    getSeatVersion(monitorSymbol: string, direction: 'LONG' | 'SHORT'): number {
      const entry = seatMap.get(monitorSymbol);
      if (!entry) {
        throw new Error(`missing seat entry for monitorSymbol=${monitorSymbol}`);
      }
      return direction === 'LONG' ? entry.longVersion : entry.shortVersion;
    },
    resolveSeatBySymbol(symbol: string) {
      for (const [monitorSymbol, entry] of seatMap) {
        if (entry.longState.symbol === symbol) {
          return {
            monitorSymbol,
            direction: 'LONG' as const,
            seatState: entry.longState,
            seatVersion: entry.longVersion,
          };
        }
        if (entry.shortState.symbol === symbol) {
          return {
            monitorSymbol,
            direction: 'SHORT' as const,
            seatState: entry.shortState,
            seatVersion: entry.shortVersion,
          };
        }
      }
      return null;
    },
    updateSeatState(monitorSymbol: string, direction: 'LONG' | 'SHORT', nextState: SeatState): SeatState {
      const entry = seatMap.get(monitorSymbol);
      if (!entry) {
        throw new Error(`missing seat entry for monitorSymbol=${monitorSymbol}`);
      }
      if (direction === 'LONG') {
        entry.longState = nextState;
        return entry.longState;
      }
      entry.shortState = nextState;
      return entry.shortState;
    },
    bumpSeatVersion(monitorSymbol: string, direction: 'LONG' | 'SHORT'): number {
      const entry = seatMap.get(monitorSymbol);
      if (!entry) {
        throw new Error(`missing seat entry for monitorSymbol=${monitorSymbol}`);
      }
      if (direction === 'LONG') {
        entry.longVersion += 1;
        return entry.longVersion;
      }
      entry.shortVersion += 1;
      return entry.shortVersion;
    },
  };
}

function createMonitorConfigs(monitorCount: number): ReadonlyArray<MonitorConfig> {
  const monitorConfigs: MonitorConfig[] = [];
  for (let index = 1; index <= monitorCount; index += 1) {
    monitorConfigs.push(
      createMonitorConfigDouble({
        originalIndex: index,
        monitorSymbol: `HSI${index}.HK`,
        longSymbol: `BULL${index}.HK`,
        shortSymbol: `BEAR${index}.HK`,
      }),
    );
  }
  return monitorConfigs;
}

function createQuotesForSymbols(
  monitorConfigs: ReadonlyArray<MonitorConfig>,
  iteration: number,
): Map<string, Quote | null> {
  const quotes = new Map<string, Quote | null>();
  for (let index = 0; index < monitorConfigs.length; index += 1) {
    const config = monitorConfigs[index];
    if (!config) {
      continue;
    }
    const baseMonitor = 20_000 + index * 10 + iteration;
    const baseLong = 1.05 + index * 0.02 + iteration * 0.001;
    const baseShort = 0.95 + index * 0.02 + iteration * 0.001;

    quotes.set(config.monitorSymbol, {
      symbol: config.monitorSymbol,
      name: config.monitorSymbol,
      price: baseMonitor,
      prevClose: baseMonitor - 5,
      timestamp: Date.now(),
      lotSize: 1,
    });
    quotes.set(config.longSymbol, {
      symbol: config.longSymbol,
      name: config.longSymbol,
      price: baseLong,
      prevClose: baseLong - 0.01,
      timestamp: Date.now(),
      lotSize: 100,
    });
    quotes.set(config.shortSymbol, {
      symbol: config.shortSymbol,
      name: config.shortSymbol,
      price: baseShort,
      prevClose: baseShort - 0.01,
      timestamp: Date.now(),
      lotSize: 100,
    });
  }
  return quotes;
}

function createCandles(length: number, start: number, step: number): CandleData[] {
  const candles: CandleData[] = [];
  for (let index = 0; index < length; index += 1) {
    const close = start + step * index;
    candles.push({
      open: close - 0.2,
      high: close + 0.3,
      low: close - 0.4,
      close,
      volume: 10_000 + index,
    });
  }
  return candles;
}

function createAllTradingSymbols(monitorConfigs: ReadonlyArray<MonitorConfig>): Set<string> {
  const symbols = new Set<string>();
  for (const monitorConfig of monitorConfigs) {
    symbols.add(monitorConfig.monitorSymbol);
    symbols.add(monitorConfig.longSymbol);
    symbols.add(monitorConfig.shortSymbol);
  }
  return symbols;
}

function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((acc, value) => acc + value, 0);
  return total / values.length;
}

function buildTradingConfig(monitorConfigs: ReadonlyArray<MonitorConfig>): MultiMonitorTradingConfig {
  const baseGlobal = createTradingConfig().global;
  return createTradingConfig({
    monitors: [...monitorConfigs],
    global: {
      ...baseGlobal,
      doomsdayProtection: false,
      openProtection: {
        morning: {
          enabled: false,
          minutes: null,
        },
        afternoon: {
          enabled: false,
          minutes: null,
        },
      },
    },
  });
}

function makeCandleKey(symbol: string, period: Period): string {
  return `${symbol}:${period}`;
}

describe('main loop latency full-chain integration', () => {
  it('matches real loop logic with subscribed candles and 200ms startup API delay', async () => {
    const monitorCount = 5;
    const loopCount = 6;
    const apiDelayMs = 200;

    const monitorConfigs = createMonitorConfigs(monitorCount);
    const tradingConfig = buildTradingConfig(monitorConfigs);
    const symbolRegistry = createMultiMonitorSymbolRegistry(monitorConfigs);
    const allTradingSymbols = createAllTradingSymbols(monitorConfigs);

    const monitorStates = new Map<string, MonitorState>();
    for (const monitorConfig of monitorConfigs) {
      monitorStates.set(monitorConfig.monitorSymbol, initMonitorState(monitorConfig));
    }

    const initialQuotes = createQuotesForSymbols(monitorConfigs, 0);
    const indicatorCache = createIndicatorCache({ maxEntries: 400 });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();

    const monitorContexts = new Map<string, MonitorContext>();
    for (const monitorConfig of monitorConfigs) {
      const monitorState = monitorStates.get(monitorConfig.monitorSymbol);
      if (!monitorState) {
        throw new Error(`missing monitor state for ${monitorConfig.monitorSymbol}`);
      }
      monitorContexts.set(
        monitorConfig.monitorSymbol,
        createMonitorContext({
          config: monitorConfig,
          state: monitorState,
          symbolRegistry,
          quotesMap: initialQuotes,
          strategy: createHangSengMultiIndicatorStrategy({
            signalConfig: monitorConfig.signalConfig,
            verificationConfig: monitorConfig.verificationConfig,
          }),
          orderRecorder: createOrderRecorderDouble(),
          dailyLossTracker: createNoopDailyLossTracker(),
          riskChecker: createRiskCheckerDouble(),
          unrealizedLossMonitor: createNoopUnrealizedLossMonitor(),
          delayedSignalVerifier: createNoopDelayedSignalVerifier(),
          autoSymbolManager: createNoopAutoSymbolManager(),
        }),
      );
    }

    const lastState: LastState = {
      canTrade: true,
      isHalfDay: false,
      openProtectionActive: false,
      currentDayKey: '2026-02-20',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      targetTradingDayKey: null,
      isTradingEnabled: true,
      cachedAccount: null,
      cachedPositions: [],
      positionCache: createPositionCacheDouble([]),
      cachedTradingDayInfo: {
        isTradingDay: true,
        isHalfDay: false,
      },
      monitorStates,
      allTradingSymbols: new Set(allTradingSymbols),
    };

    const apiCallEvents: ApiCallEvent[] = [];
    let currentStage: 'startup' | 'main-loop' = 'startup';
    let currentIteration: number | null = null;

    async function withApiDelay<T>(
      method: DelayedApiMethod,
      run: () => Promise<T>,
    ): Promise<T> {
      const startedAt = performance.now();
      await Bun.sleep(apiDelayMs);
      const result = await run();
      const elapsedMs = performance.now() - startedAt;
      apiCallEvents.push({
        stage: currentStage,
        iteration: currentIteration,
        method,
        elapsedMs,
      });
      return result;
    }

    const subscribedSymbols = new Set<string>();
    const subscribedCandlestickKeys = new Set<string>();
    const quoteCache = new Map<string, Quote>();
    const candleCache = new Map<string, ReadonlyArray<CandleData>>();

    function applyMockRealtimePush(iteration: number): void {
      const latestQuotes = createQuotesForSymbols(monitorConfigs, iteration);
      for (const [symbol, quote] of latestQuotes) {
        if (!quote || !subscribedSymbols.has(symbol)) {
          continue;
        }
        quoteCache.set(symbol, quote);
      }

      for (let index = 0; index < monitorConfigs.length; index += 1) {
        const monitorConfig = monitorConfigs[index];
        if (!monitorConfig) {
          continue;
        }
        const key = makeCandleKey(monitorConfig.monitorSymbol, TRADING.CANDLE_PERIOD);
        if (!subscribedCandlestickKeys.has(key)) {
          continue;
        }
        const base = 100 + index * 20 + iteration;
        candleCache.set(key, createCandles(TRADING.CANDLE_COUNT, base, 0.15));
      }
    }

    const marketDataClient: MarketDataClient = {
      getQuoteContext: async () => withApiDelay('getQuoteContext', async () => ({}) as never),
      getQuotes: async (symbols) => {
        const result = new Map<string, Quote | null>();
        for (const symbol of symbols) {
          if (!subscribedSymbols.has(symbol)) {
            throw new Error(`[行情获取] 标的 ${symbol} 未订阅，请先订阅`);
          }
          result.set(symbol, quoteCache.get(symbol) ?? null);
        }
        return result;
      },
      subscribeSymbols: async (symbols) =>
        withApiDelay('subscribeSymbols', async () => {
          applyMockRealtimePush(0);
          for (const symbol of symbols) {
            subscribedSymbols.add(symbol);
            const quote = initialQuotes.get(symbol);
            if (quote) {
              quoteCache.set(symbol, quote);
            }
          }
        }),
      unsubscribeSymbols: async (symbols) =>
        withApiDelay('unsubscribeSymbols', async () => {
          for (const symbol of symbols) {
            subscribedSymbols.delete(symbol);
            quoteCache.delete(symbol);
          }
        }),
      subscribeCandlesticks: async (symbol: string, period: Period, _tradeSessions?: TradeSessions) =>
        withApiDelay('subscribeCandlesticks', async () => {
          const key = makeCandleKey(symbol, period);
          subscribedCandlestickKeys.add(key);
          const monitorIndex = monitorConfigs.findIndex((config) => config.monitorSymbol === symbol);
          const base = 100 + Math.max(monitorIndex, 0) * 20;
          const candles = createCandles(TRADING.CANDLE_COUNT, base, 0.15);
          candleCache.set(key, candles);
          return candles as unknown as Candlestick[];
        }),
      getRealtimeCandlesticks: async (symbol: string, period: Period, count: number) => {
        const key = makeCandleKey(symbol, period);
        const candles = candleCache.get(key);
        if (!candles || candles.length === 0) {
          return [];
        }
        const startIndex = Math.max(candles.length - count, 0);
        return candles.slice(startIndex) as unknown as Candlestick[];
      },
      isTradingDay: async () =>
        withApiDelay('isTradingDay', async () => ({
          isTradingDay: true,
          isHalfDay: false,
        })),
      resetRuntimeSubscriptionsAndCaches: async () =>
        withApiDelay('resetRuntimeSubscriptionsAndCaches', async () => {
          subscribedSymbols.clear();
          subscribedCandlestickKeys.clear();
          quoteCache.clear();
          candleCache.clear();
        }),
    };

    const sharedContext: MainProgramContext = {
      marketDataClient,
      trader: createTraderDouble(),
      lastState,
      marketMonitor: {
        monitorPriceChanges: () => false,
        monitorIndicatorChanges: () => false,
      },
      doomsdayProtection: createDoomsdayProtectionDouble(),
      signalProcessor: {
        processSellSignals: (signals) => signals,
        applyRiskChecks: async (signals) => signals,
        resetRiskCheckCooldown: () => {},
      },
      tradingConfig,
      dailyLossTracker: createNoopDailyLossTracker(),
      monitorContexts,
      symbolRegistry,
      indicatorCache,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
      orderMonitorWorker: {
        start: () => {},
        schedule: () => {},
        stopAndDrain: async () => {},
        clearLatestQuotes: () => {},
      },
      postTradeRefresher: {
        start: () => {},
        enqueue: () => {},
        stopAndDrain: async () => {},
        clearPending: () => {},
      },
      runtimeGateMode: 'skip',
      dayLifecycleManager: {
        tick: async () => {},
      },
    };

    // 启动阶段：真实链路是先订阅，再进入主循环
    await marketDataClient.subscribeSymbols(Array.from(allTradingSymbols));
    for (const monitorConfig of monitorConfigs) {
      await marketDataClient.subscribeCandlesticks(
        monitorConfig.monitorSymbol,
        TRADING.CANDLE_PERIOD,
      );
    }

    currentStage = 'main-loop';
    const iterationMetrics: IterationMetric[] = [];

    for (let iteration = 1; iteration <= loopCount; iteration += 1) {
      currentIteration = iteration;
      applyMockRealtimePush(iteration);

      const loopStartedAt = performance.now();
      await mainProgram(sharedContext);
      const loopLatencyMs = performance.now() - loopStartedAt;

      const iterationEvents = apiCallEvents.filter(
        (event) => event.stage === 'main-loop' && event.iteration === iteration,
      );
      const apiLatencyTotalMs = iterationEvents.reduce((acc, event) => acc + event.elapsedMs, 0);

      iterationMetrics.push({
        iteration,
        loopLatencyMs,
        apiCallCount: iterationEvents.length,
        apiLatencyTotalMs,
      });

      for (const monitorConfig of monitorConfigs) {
        const monitorState = monitorStates.get(monitorConfig.monitorSymbol);
        expect(monitorState).not.toBeUndefined();
        const snapshot = monitorState?.lastMonitorSnapshot;
        expect(snapshot).not.toBeNull();
        expect(snapshot?.kdj).not.toBeNull();
        expect(snapshot?.macd).not.toBeNull();
        expect(Number.isFinite(snapshot?.mfi ?? Number.NaN)).toBeTrue();
        expect(snapshot?.rsi?.[6]).not.toBeUndefined();
        expect(snapshot?.ema?.[7]).not.toBeUndefined();
        expect(snapshot?.psy?.[13]).not.toBeUndefined();
      }
    }

    const startupEvents = apiCallEvents.filter((event) => event.stage === 'startup');
    const startupApiLatencyTotalMs = startupEvents.reduce((acc, event) => acc + event.elapsedMs, 0);
    const loopLatencies = iterationMetrics.map((metric) => metric.loopLatencyMs);
    const averageLoopLatencyMs = mean(loopLatencies);
    const maxLoopLatencyMs = Math.max(...loopLatencies);

    expect(startupEvents.length).toBe(monitorCount + 1);
    expect(startupEvents.every((event) => event.elapsedMs >= 180)).toBeTrue();
    expect(iterationMetrics.every((metric) => metric.apiCallCount === 0)).toBeTrue();
    expect(averageLoopLatencyMs).toBeLessThan(200);
    expect(maxLoopLatencyMs).toBeLessThan(260);

    console.info(
      '[main-loop-latency] ' +
        JSON.stringify(
          {
            apiDelayMs,
            monitorCount,
            loopCount,
            startupApiCallCount: startupEvents.length,
            startupApiLatencyTotalMs,
            averageLoopLatencyMs,
            maxLoopLatencyMs,
            iterationMetrics,
          },
          null,
          2,
        ),
    );
  });
});
