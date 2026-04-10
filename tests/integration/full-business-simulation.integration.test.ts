/**
 * full-business-simulation 集成测试
 *
 * 功能：
 * - 验证完整业务仿真端到端场景与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createMonitorContext } from '../../src/app/createMonitorContext.js';
import { mainProgram } from '../../src/main/mainProgram/index.js';
import { processMonitor } from '../../src/main/processMonitor/index.js';
import { createBuyProcessor } from '../../src/main/asyncProgram/buyProcessor/index.js';
import { createSellProcessor } from '../../src/main/asyncProgram/sellProcessor/index.js';
import { createMonitorTaskQueue } from '../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskProcessor } from '../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createIndicatorCache } from '../../src/main/asyncProgram/indicatorCache/index.js';
import { createDelayedSignalVerifier } from '../../src/main/asyncProgram/delayedSignalVerifier/index.js';
import { createAutoSymbolManager } from '../../src/services/autoSymbolManager/index.js';
import { initMonitorState } from '../../src/utils/helpers/index.js';
import { createDayLifecycleManager } from '../../src/main/lifecycle/dayLifecycleManager.js';
import { createSignalRuntimeDomain } from '../../src/main/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { createGlobalStateDomain } from '../../src/main/lifecycle/cacheDomains/globalStateDomain.js';
import { createDefaultMonitorQuoteEventRuntime } from '../../src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createSwitchWakeupRuntime } from '../../src/main/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { Period, type Candlestick } from 'longbridge';
import type { CandleData } from '../../src/types/data.js';
import type { LastState, MonitorContext } from '../../src/types/state.js';
import type { MultiMonitorTradingConfig, MonitorConfig } from '../../src/types/config.js';
import type { DailyLossTracker, UnrealizedLossMonitor } from '../../src/types/risk.js';
import type {
  CandlestickCacheSnapshot,
  OrderStateChangedEvent,
  QuoteUpdatedEvent,
} from '../../src/types/services.js';
import type { DayLifecycleManager } from '../../src/main/lifecycle/types.js';
import type { MonitorTaskDataMap } from '../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import {
  createAccountSnapshotDouble,
  createDoomsdayProtectionDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';
import { waitUntil } from '../main/asyncProgram/utils.js';
import { createWarrantCandidateWithOverrides } from '../services/autoSymbolManager/utils.js';

let autoSymbolCandidates: Array<ReturnType<typeof createWarrantCandidateWithOverrides> | null> = [];

function createCandles(length: number, start: number, step: number): CandleData[] {
  const candles: CandleData[] = [];
  for (let index = 0; index < length; index += 1) {
    const close = start + index * step;
    candles.push({
      open: close - 0.2,
      high: close + 0.3,
      low: close - 0.4,
      close,
      volume: 5_000 + index,
    });
  }

  return candles;
}

function createMockCandlesticks(length: number, start: number, step: number): Candlestick[] {
  const candles = createCandles(length, start, step);
  return candles as unknown as Candlestick[];
}

function createCandlestickSnapshot(
  symbol: string,
  candles: ReadonlyArray<CandleData>,
  version: number = 1,
): CandlestickCacheSnapshot | null {
  if (candles.length === 0) {
    return null;
  }

  const latest = candles.at(-1);
  const lastBarTimestamp =
    latest && typeof latest.timestamp === 'number' && Number.isFinite(latest.timestamp)
      ? latest.timestamp
      : null;
  return {
    symbol,
    period: Period.Min_1,
    version,
    candles,
    lastBarTimestamp,
    lastBarConfirmed: false,
    initialized: true,
  };
}

function createNoopDailyLossTracker(): DailyLossTracker {
  return {
    resetAll: () => {},
    startNewProtectionEpisode: () => {},
    recalculateFromAllOrders: () => {},
    recordFilledOrder: () => {},
    getLossOffset: () => 0,
  };
}

function createNoopUnrealizedLossMonitor(): UnrealizedLossMonitor {
  return {
    monitorDirectionalUnrealizedLoss: async () => {},
  };
}

function createNoopDayLifecycleManager(): DayLifecycleManager {
  return {
    tick: async () => {},
  };
}

function createTradingConfigForMonitor(monitorConfig: MonitorConfig): MultiMonitorTradingConfig {
  const base = createTradingConfig();
  return {
    monitors: [monitorConfig],
    global: base.global,
  };
}

function createSimulationLastState(params: {
  readonly monitorConfig: MonitorConfig;
  readonly monitorState: ReturnType<typeof initMonitorState>;
  readonly positions: ReadonlyArray<ReturnType<typeof createPositionDouble>>;
  readonly currentDayKey: string;
}): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: params.currentDayKey,
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: createAccountSnapshotDouble(200_000),
    cachedPositions: params.positions,
    positionCache: createPositionCacheDouble(params.positions),
    cachedTradingDayInfo: {
      isTradingDay: true,
      isHalfDay: false,
    },
    monitorStates: new Map([[params.monitorConfig.monitorSymbol, params.monitorState]]),
    allTradingSymbols: new Set<string>(),
  };
}

function createSingleListenerEventSource<T>(): {
  readonly subscribe: (listener: (event: T) => void) => () => void;
  readonly emit: (event: T) => void;
} {
  let listener: ((event: T) => void) | null = null;

  return {
    subscribe(nextListener) {
      listener = nextListener;
      return function unsubscribe(): void {
        if (listener === nextListener) {
          listener = null;
        }
      };
    },
    emit(event) {
      listener?.(event);
    },
  };
}

describe('full business simulation integration', () => {
  it('simulates main loop -> risk checks -> sell execution while buy is blocked by risk rule', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      smartCloseEnabled: true,
    });
    const tradingConfig = createTradingConfigForMonitor(monitorConfig);
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });

    const indicatorCache = createIndicatorCache({ maxEntries: 300 });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const monitorState = initMonitorState(monitorConfig);
    const positions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 300, availableQuantity: 300 }),
    ];
    const lastState = createSimulationLastState({
      monitorConfig,
      monitorState,
      positions,
      currentDayKey: '2026-02-16',
    });

    const riskChecker = createRiskCheckerDouble({
      checkBeforeOrder: ({ signal }) =>
        signal?.action === 'BUYCALL'
          ? { allowed: false, reason: '模拟风险规则：买入被拒绝' }
          : { allowed: true },
    });

    const orderRecorder = createOrderRecorderDouble({
      getCostAveragePrice: () => 1.2,
      selectSellableOrders: () => ({
        orders: [
          {
            orderId: 'BUY-001',
            symbol: 'BULL.HK',
            executedPrice: 1,
            executedQuantity: 100,
            executedTime: Date.now(),
            submittedAt: undefined,
            updatedAt: undefined,
          },
        ],
        totalQuantity: 100,
      }),
    });

    const delayedSignalVerifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    const strategy = {
      generateSignals: () => ({
        immediateSignals: [
          createSignal({
            symbol: 'BULL.HK',
            action: 'BUYCALL',
            reason: 'full-simulation-buy',
            triggerTimeMs: Date.now(),
          }),
          createSignal({
            symbol: 'BULL.HK',
            action: 'SELLCALL',
            reason: 'full-simulation-sell',
            triggerTimeMs: Date.now(),
          }),
        ],
        delayedSignals: [],
      }),
    };

    const monitorContext = createMonitorContext({
      config: monitorConfig,
      state: monitorState,
      symbolRegistry,
      quotesMap: new Map([
        ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
        ['BULL.HK', createQuoteDouble('BULL.HK', 1.05, 100)],
        ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.95, 100)],
      ]),
      strategy,
      orderRecorder,
      dailyLossTracker: createNoopDailyLossTracker(),
      riskChecker,
      unrealizedLossMonitor: createNoopUnrealizedLossMonitor(),
      delayedSignalVerifier,
      autoSymbolManager: {
        maybeSearchOnTick: async () => {},
        maybeSwitchOnInterval: async () => ({
          kind: 'NOOP',
        }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        advancePendingSwitch: async (params) => ({
          advanced: false,
          direction: params.direction,
          stillPending: false,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        hasPendingSwitch: () => false,
        resetAllState: () => {},
      },
    });
    const monitorContexts = new Map<string, MonitorContext>([
      [monitorConfig.monitorSymbol, monitorContext],
    ]);

    const submittedActions: string[] = [];
    const trader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(200_000),
      getStockPositions: async () => positions,
      executeSignals: async (signals) => {
        for (const signal of signals) {
          submittedActions.push(signal.action);
        }

        return { submittedCount: signals.length, submittedOrderIds: [] };
      },
    });

    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });

    const postTradeConsistencyRuntime = {
      waitForFresh: async () => {},
      onFreshReached: () => () => {},
    };
    const buyProcessor = createBuyProcessor({
      taskQueue: buyTaskQueue,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
      signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols: Iterable<string>) => {
          const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
          for (const symbol of symbols) {
            if (symbol === 'HSI.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 20_000, 1));
            } else if (symbol === 'BULL.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 1.05, 100));
            } else if (symbol === 'BEAR.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 0.95, 100));
            } else {
              quotes.set(symbol, null);
            }
          }

          return quotes;
        },
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => lastState,
      getIsHalfDay: () => false,
      getCanProcessTask: () => lastState.isTradingEnabled,
    });
    const sellProcessor = createSellProcessor({
      taskQueue: sellTaskQueue,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
      signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols: Iterable<string>) => {
          const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
          for (const symbol of symbols) {
            if (symbol === 'HSI.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 20_000, 1));
            } else if (symbol === 'BULL.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 1.05, 100));
            } else if (symbol === 'BEAR.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 0.95, 100));
            } else {
              quotes.set(symbol, null);
            }
          }

          return quotes;
        },
      }),
      getLastState: () => lastState,
      postTradeConsistencyRuntime,
      getCanProcessTask: () => lastState.isTradingEnabled,
    });

    const candles = createMockCandlesticks(120, 100, 0.2);

    buyProcessor.start();
    sellProcessor.start();
    try {
      await mainProgram({
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async (symbols: Iterable<string>) => {
            const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
            for (const symbol of symbols) {
              if (symbol === 'HSI.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, 20_000, 1));
              } else if (symbol === 'BULL.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, 1.05, 100));
              } else if (symbol === 'BEAR.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, 0.95, 100));
              } else {
                quotes.set(symbol, null);
              }
            }

            return quotes;
          },
          getCandlestickSnapshot: (symbol) =>
            symbol === monitorConfig.monitorSymbol
              ? createCandlestickSnapshot(symbol, candles as unknown as ReadonlyArray<CandleData>)
              : null,
        }),
        trader,
        lastState,
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        doomsdayProtection: createDoomsdayProtectionDouble(),
        signalProcessor,
        tradingConfig,
        dailyLossTracker: createNoopDailyLossTracker(),
        monitorContexts,
        symbolRegistry,
        indicatorCache,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        runtimeGateMode: 'skip',
        dayLifecycleManager: createNoopDayLifecycleManager(),
      });

      await Bun.sleep(80);

      expect(submittedActions).toEqual(['SELLCALL']);
    } finally {
      delayedSignalVerifier.destroy();
      await Promise.all([buyProcessor.stopAndDrain(), sellProcessor.stopAndDrain()]);
    }
  });

  it('simulates auto-search and auto-switch through processMonitor + monitorTaskProcessor', async () => {
    autoSymbolCandidates = [
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: 20_000 }),
      null,
      createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: 21_000 }),
    ];

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      targetNotional: 5_000,
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });
    const tradingConfig = createTradingConfigForMonitor(monitorConfig);
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });

    const indicatorCache = createIndicatorCache({ maxEntries: 300 });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const monitorState = initMonitorState(monitorConfig);
    const lastState = createSimulationLastState({
      monitorConfig,
      monitorState,
      positions: [],
      currentDayKey: '2026-02-16',
    });

    const executedActions: Array<{ action: string; symbol: string }> = [];
    const orderStateChangedEvents = createSingleListenerEventSource<OrderStateChangedEvent>();
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        for (const signal of signals) {
          executedActions.push({
            action: signal.action,
            symbol: signal.symbol,
          });
        }

        const firstSignal = signals[0];
        if (firstSignal?.action === 'SELLCALL' && firstSignal.symbol === 'OLD_BULL.HK') {
          return { submittedCount: signals.length, submittedOrderIds: ['SELL-1'] };
        }

        return { submittedCount: signals.length, submittedOrderIds: ['BUY-1'] };
      },
      getPendingOrders: async () => [],
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
      onOrderStateChanged: orderStateChangedEvents.subscribe,
    });

    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-1'
          ? {
              orderId: 'SELL-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });

    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: (isLongSymbol, seatSymbol) => {
        if (!isLongSymbol || seatSymbol !== 'OLD_BULL.HK') {
          return null;
        }

        return createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceToStrikePercent: 0.1,
        });
      },
    });
    const quoteUpdatedEvents = createSingleListenerEventSource<QuoteUpdatedEvent>();
    const autoSwitchMarketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols: Iterable<string>) => {
        const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
        for (const symbol of symbols) {
          if (symbol === 'HSI.HK') {
            quotes.set(symbol, createQuoteDouble(symbol, 20_000, 1));
            continue;
          }

          quotes.set(symbol, createQuoteDouble(symbol, 1, 100));
        }

        return quotes;
      },
      onQuoteUpdated: quoteUpdatedEvents.subscribe,
    });

    const autoSymbolManager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: autoSwitchMarketDataClient,
      trader,
      orderRecorder,
      riskChecker,
      findBestWarrant: async () => autoSymbolCandidates.shift() ?? null,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
    });

    const delayedSignalVerifier = createDelayedSignalVerifier({
      indicatorCache,
    });
    const monitorContext = createMonitorContext({
      config: monitorConfig,
      state: monitorState,
      symbolRegistry,
      quotesMap: new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)]]),
      strategy: {
        generateSignals: () => ({
          immediateSignals: [],
          delayedSignals: [],
        }),
      },
      orderRecorder,
      dailyLossTracker: createNoopDailyLossTracker(),
      riskChecker,
      unrealizedLossMonitor: createNoopUnrealizedLossMonitor(),
      delayedSignalVerifier,
      autoSymbolManager,
    });
    const monitorContexts = new Map<string, MonitorContext>([
      [monitorConfig.monitorSymbol, monitorContext],
    ]);

    const processedTaskTypes: string[] = [];
    const postTradeConsistencyRuntime = {
      waitForFresh: async () => {},
      getStatus: () => ({
        started: true,
        currentVersion: 1,
        staleVersion: 1,
      }),
      onFreshReached: () => () => {},
    };
    const switchWakeupRuntime = createSwitchWakeupRuntime({
      marketDataClient: autoSwitchMarketDataClient,
      trader,
      symbolRegistry,
      monitorContexts,
      lastState,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      scheduleTimer: (callback, delayMs) => {
        return setTimeout(callback, delayMs);
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });
    const monitorTaskProcessor = createMonitorTaskProcessor({
      monitorTaskQueue,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol) ?? null,
      clearMonitorDirectionQueues: () => {},
      trader,
      marketDataClient: createMarketDataClientDouble(),
      switchWakeupRuntime,
      lastState,
      tradingConfig,
      getCanProcessTask: () => true,
      onProcessed: (task, status) => {
        processedTaskTypes.push(`${task.type}:${status}`);
      },
    });
    const monitorQuoteEventRuntime = createDefaultMonitorQuoteEventRuntime({
      marketDataClient: autoSwitchMarketDataClient,
      monitorContexts,
      trader,
      lastState,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      handoffPendingSwitch: switchWakeupRuntime.handoffPendingSwitch,
    });

    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });

    const buyProcessor = createBuyProcessor({
      taskQueue: buyTaskQueue,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
      signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: autoSwitchMarketDataClient.getQuotes,
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => lastState,
      getIsHalfDay: () => false,
      getCanProcessTask: () => lastState.isTradingEnabled,
    });
    const sellProcessor = createSellProcessor({
      taskQueue: sellTaskQueue,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
      signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: autoSwitchMarketDataClient.getQuotes,
      }),
      getLastState: () => lastState,
      postTradeConsistencyRuntime,
      getCanProcessTask: () => lastState.isTradingEnabled,
    });

    const sharedMainCandles = createCandles(120, 200, 0.5);
    const sharedMainContext = {
      marketDataClient: createMarketDataClientDouble({
        getQuotes: autoSwitchMarketDataClient.getQuotes,
        getCandlestickSnapshot: (symbol) =>
          symbol === monitorConfig.monitorSymbol
            ? createCandlestickSnapshot(symbol, sharedMainCandles)
            : null,
      }),
      trader,
      lastState,
      marketMonitor: {
        monitorPriceChanges: () => false,
        monitorIndicatorChanges: () => false,
      },
      doomsdayProtection: createDoomsdayProtectionDouble(),
      signalProcessor,
      tradingConfig,
      dailyLossTracker: createNoopDailyLossTracker(),
      monitorContexts,
      symbolRegistry,
      indicatorCache,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
      runtimeGateMode: 'skip' as const,
      dayLifecycleManager: createNoopDayLifecycleManager(),
    };

    function emitMonitorQuoteUpdated(price: number): void {
      quoteUpdatedEvents.emit({
        symbol: monitorConfig.monitorSymbol,
        quote: createQuoteDouble(monitorConfig.monitorSymbol, price, 1),
      });
    }

    function emitOrderStateChanged(symbol: string): void {
      orderStateChangedEvents.emit({
        orderId: `order-${symbol}`,
        symbol,
        side: 'SELL',
        source: 'WS',
        status: 'FILLED',
        monitorSymbol: monitorConfig.monitorSymbol,
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedPrice: 1,
        executedQuantity: 100,
        executedTimeMs: Date.now(),
      });
    }

    buyProcessor.start();
    sellProcessor.start();
    monitorTaskProcessor.start();
    switchWakeupRuntime.start();
    monitorQuoteEventRuntime.start();
    try {
      await processMonitor(
        {
          context: sharedMainContext,
          monitorContext,
          runtimeFlags: {
            currentTime: new Date('2026-02-16T01:00:00.000Z'),
            isHalfDay: false,
            canTradeNow: true,
            openProtectionActive: false,
            isTradingEnabled: true,
          },
        },
        new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)]]),
      );

      await waitUntil(() => {
        const seat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
        return seat.status === 'ACTIVATING' && seat.symbol === 'OLD_BULL.HK';
      });

      const searchedSeat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
      expect(searchedSeat.status).toBe('ACTIVATING');
      expect(searchedSeat.symbol).toBe('OLD_BULL.HK');
      expect(symbolRegistry.getSeatVersion(monitorConfig.monitorSymbol, 'LONG')).toBe(2);

      await processMonitor(
        {
          context: sharedMainContext,
          monitorContext,
          runtimeFlags: {
            currentTime: new Date('2026-02-16T01:00:00.500Z'),
            isHalfDay: false,
            canTradeNow: true,
            openProtectionActive: false,
            isTradingEnabled: true,
          },
        },
        new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
          ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
        ]),
      );

      await waitUntil(() => {
        const seat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
        return seat.status === 'ACTIVE' && seat.symbol === 'OLD_BULL.HK';
      }).catch((error: unknown) => {
        throw new Error(
          `seat activation timeout after second monitor cycle: seat=${JSON.stringify(symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG'))}, tasks=${processedTaskTypes.join(',')}, cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });

      const activatedSeat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
      expect(activatedSeat.status).toBe('ACTIVE');
      expect(activatedSeat.symbol).toBe('OLD_BULL.HK');

      const oldPosition = createPositionDouble({
        symbol: 'OLD_BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      });
      lastState.cachedPositions = [oldPosition];
      lastState.positionCache.update([oldPosition]);

      await processMonitor(
        {
          context: sharedMainContext,
          monitorContext,
          runtimeFlags: {
            currentTime: new Date('2026-02-16T01:00:01.000Z'),
            isHalfDay: false,
            canTradeNow: true,
            openProtectionActive: false,
            isTradingEnabled: true,
          },
        },
        new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', 20_010, 1)],
          ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
          ['NEW_BULL.HK', createQuoteDouble('NEW_BULL.HK', 1, 100)],
        ]),
      );
      emitMonitorQuoteUpdated(20_010);
      await waitUntil(() => executedActions.length > 0);

      expect(executedActions[0]?.action).toBe('SELLCALL');
      expect(executedActions[0]?.symbol).toBe('OLD_BULL.HK');

      lastState.cachedPositions = [];
      lastState.positionCache.update([]);
      emitOrderStateChanged('OLD_BULL.HK');

      const finalQuotes = new Map([
        ['HSI.HK', createQuoteDouble('HSI.HK', 20_020, 1)],
        ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
        ['NEW_BULL.HK', createQuoteDouble('NEW_BULL.HK', 1, 100)],
      ]);

      await processMonitor(
        {
          context: sharedMainContext,
          monitorContext,
          runtimeFlags: {
            currentTime: new Date('2026-02-16T01:00:02.000Z'),
            isHalfDay: false,
            canTradeNow: true,
            openProtectionActive: false,
            isTradingEnabled: true,
          },
        },
        finalQuotes,
      );

      await processMonitor(
        {
          context: sharedMainContext,
          monitorContext,
          runtimeFlags: {
            currentTime: new Date('2026-02-16T01:00:02.500Z'),
            isHalfDay: false,
            canTradeNow: true,
            openProtectionActive: false,
            isTradingEnabled: true,
          },
        },
        finalQuotes,
      );

      await processMonitor(
        {
          context: sharedMainContext,
          monitorContext,
          runtimeFlags: {
            currentTime: new Date('2026-02-16T01:00:03.000Z'),
            isHalfDay: false,
            canTradeNow: true,
            openProtectionActive: false,
            isTradingEnabled: true,
          },
        },
        finalQuotes,
      );

      await waitUntil(() => executedActions.length > 1).catch((error: unknown) => {
        throw new Error(
          `rebuy action timeout: seat=${JSON.stringify(symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG'))}, actions=${JSON.stringify(executedActions)}, tasks=${processedTaskTypes.join(',')}, cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });

      await waitUntil(() => {
        const seat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
        return seat.status === 'ACTIVATING' && seat.symbol === 'NEW_BULL.HK';
      }).catch((error: unknown) => {
        throw new Error(
          `rebuy seat transition timeout: seat=${JSON.stringify(symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG'))}, actions=${JSON.stringify(executedActions)}, tasks=${processedTaskTypes.join(',')}, cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });

      expect(executedActions[1]?.action).toBe('BUYCALL');
      expect(executedActions[1]?.symbol).toBe('NEW_BULL.HK');
      expect(executedActions).toHaveLength(2);

      await processMonitor(
        {
          context: sharedMainContext,
          monitorContext,
          runtimeFlags: {
            currentTime: new Date('2026-02-16T01:00:03.500Z'),
            isHalfDay: false,
            canTradeNow: true,
            openProtectionActive: false,
            isTradingEnabled: true,
          },
        },
        new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', 20_020, 1)],
          ['NEW_BULL.HK', createQuoteDouble('NEW_BULL.HK', 1, 100)],
        ]),
      );

      await waitUntil(() => {
        const seat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
        return seat.status === 'ACTIVE' && seat.symbol === 'NEW_BULL.HK';
      }).catch((error: unknown) => {
        throw new Error(
          `final seat activation timeout: seat=${JSON.stringify(symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG'))}, actions=${JSON.stringify(executedActions)}, tasks=${processedTaskTypes.join(',')}, cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });

      const finalSeat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
      expect(finalSeat.status).toBe('ACTIVE');
      expect(finalSeat.symbol).toBe('NEW_BULL.HK');
      expect(symbolRegistry.getSeatVersion(monitorConfig.monitorSymbol, 'LONG')).toBe(3);
    } finally {
      delayedSignalVerifier.destroy();
      await Promise.all([
        monitorQuoteEventRuntime.stopAndDrain(),
        switchWakeupRuntime.stopAndDrain(),
        buyProcessor.stopAndDrain(),
        sellProcessor.stopAndDrain(),
        monitorTaskProcessor.stopAndDrain(),
      ]);
    }
  });

  it('simulates cross-day cleanup and open rebuild via main loop lifecycle domains', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      smartCloseEnabled: true,
    });
    const tradingConfig = createTradingConfigForMonitor(monitorConfig);
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });

    const indicatorCache = createIndicatorCache({ maxEntries: 300 });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const monitorState = initMonitorState(monitorConfig);
    const longPosition = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 200,
      availableQuantity: 200,
    });
    const lastState = createSimulationLastState({
      monitorConfig,
      monitorState,
      positions: [longPosition],
      currentDayKey: '1999-01-01',
    });

    const orderRecorder = createOrderRecorderDouble({
      getCostAveragePrice: () => 1.2,
      selectSellableOrders: () => ({
        orders: [
          {
            orderId: 'BUY-100',
            symbol: 'BULL.HK',
            executedPrice: 1,
            executedQuantity: 100,
            executedTime: Date.now(),
            submittedAt: undefined,
            updatedAt: undefined,
          },
        ],
        totalQuantity: 100,
      }),
    });
    let cancelAllCalls = 0;
    const delayedSignalVerifier = {
      addSignal: () => {},
      cancelAllForSymbol: () => {},
      cancelAllForDirection: () => 0,
      cancelAll: () => {
        cancelAllCalls += 1;
        return 1;
      },
      getPendingCount: () => 1,
      onVerified: () => {},
      destroy: () => {},
    };

    const monitorContext = createMonitorContext({
      config: monitorConfig,
      state: monitorState,
      symbolRegistry,
      quotesMap: new Map([
        ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
        ['BULL.HK', createQuoteDouble('BULL.HK', 1.05, 100)],
        ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.95, 100)],
      ]),
      strategy: {
        generateSignals: () => ({
          immediateSignals: [],
          delayedSignals: [],
        }),
      },
      orderRecorder,
      dailyLossTracker: createNoopDailyLossTracker(),
      riskChecker: createRiskCheckerDouble(),
      unrealizedLossMonitor: createNoopUnrealizedLossMonitor(),
      delayedSignalVerifier,
      autoSymbolManager: {
        maybeSearchOnTick: async () => {},
        maybeSwitchOnInterval: async () => ({
          kind: 'NOOP',
        }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        advancePendingSwitch: async (params) => ({
          advanced: false,
          direction: params.direction,
          stillPending: false,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        hasPendingSwitch: () => false,
        resetAllState: () => {},
      },
    });
    const monitorContexts = new Map<string, MonitorContext>([
      [monitorConfig.monitorSymbol, monitorContext],
    ]);

    const submittedActions: string[] = [];
    const trader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(200_000),
      getStockPositions: async () => [...lastState.cachedPositions],
      executeSignals: async (signals) => {
        for (const signal of signals) {
          submittedActions.push(signal.action);
        }

        return { submittedCount: signals.length, submittedOrderIds: [] };
      },
    });
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });

    const postTradeConsistencyRuntime = {
      waitForFresh: async () => {},
      onFreshReached: () => () => {},
    };
    const buyProcessor = createBuyProcessor({
      taskQueue: buyTaskQueue,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
      signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols: Iterable<string>) => {
          const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
          for (const symbol of symbols) {
            if (symbol === 'HSI.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 20_000, 1));
            } else if (symbol === 'BULL.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 1.05, 100));
            } else if (symbol === 'BEAR.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 0.95, 100));
            } else {
              quotes.set(symbol, null);
            }
          }

          return quotes;
        },
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => lastState,
      getIsHalfDay: () => false,
      getCanProcessTask: () => lastState.isTradingEnabled,
    });
    const sellProcessor = createSellProcessor({
      taskQueue: sellTaskQueue,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
      signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols: Iterable<string>) => {
          const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
          for (const symbol of symbols) {
            if (symbol === 'HSI.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 20_000, 1));
            } else if (symbol === 'BULL.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 1.05, 100));
            } else if (symbol === 'BEAR.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 0.95, 100));
            } else {
              quotes.set(symbol, null);
            }
          }

          return quotes;
        },
      }),
      getLastState: () => lastState,
      postTradeConsistencyRuntime,
      getCanProcessTask: () => lastState.isTradingEnabled,
    });
    const monitorTaskProcessor = createMonitorTaskProcessor({
      monitorTaskQueue,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol) ?? null,
      clearMonitorDirectionQueues: () => {},
      trader,
      marketDataClient: createMarketDataClientDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      lastState,
      tradingConfig,
      getCanProcessTask: () => lastState.isTradingEnabled,
    });

    let runOpenRebuildCount = 0;
    let postTradeStartCount = 0;
    let postTradeStopCount = 0;

    const signalRuntimeDomain = createSignalRuntimeDomain({
      monitorContexts,
      buyProcessor,
      sellProcessor,
      monitorTaskProcessor,
      postTradeConsistencyRuntime: {
        abortWaiting: () => {},
        resetAbort: () => {},
        start: () => {
          postTradeStartCount += 1;
        },
        stopAndDrain: async () => {
          postTradeStopCount += 1;
        },
        midnightClear: () => {},
        completeRebuildBaseline: () => {},
      },
      tradingRiskEventRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
      },
      monitorQuoteEventRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
      },
      switchWakeupRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
      },
      trader,
      indicatorCache,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
      releaseSignal: () => {},
    });

    const globalStateDomain = createGlobalStateDomain({
      lastState,
      runTradingDayOpenRebuild: async () => {
        runOpenRebuildCount += 1;
        // 重建阶段应使用当日快照恢复账户/持仓，这里显式模拟恢复结果，避免依赖跨日残留缓存。
        const rebuiltPositions = [
          createPositionDouble({
            symbol: 'BULL.HK',
            quantity: 500,
            availableQuantity: 500,
          }),
        ];
        lastState.cachedAccount = createAccountSnapshotDouble(200_000);
        lastState.cachedPositions = rebuiltPositions;
        lastState.positionCache.update(rebuiltPositions);
      },
    });

    const dayLifecycleManager = createDayLifecycleManager({
      mutableState: lastState,
      cacheDomains: [signalRuntimeDomain, globalStateDomain],
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      rebuildRetryDelayMs: 10,
    });

    buyTaskQueue.push({
      type: 'IMMEDIATE_BUY',
      monitorSymbol: monitorConfig.monitorSymbol,
      data: createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        reason: 'queued-before-midnight',
        triggerTimeMs: Date.now(),
      }),
    });

    sellTaskQueue.push({
      type: 'IMMEDIATE_SELL',
      monitorSymbol: monitorConfig.monitorSymbol,
      data: createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        reason: 'queued-before-midnight',
        triggerTimeMs: Date.now(),
      }),
    });

    try {
      const marketDataClient = createMarketDataClientDouble({
        getQuotes: async (symbols: Iterable<string>) => {
          const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
          for (const symbol of symbols) {
            if (symbol === 'HSI.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 20_000, 1));
            } else if (symbol === 'BULL.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 1.05, 100));
            } else if (symbol === 'BEAR.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, 0.95, 100));
            } else {
              quotes.set(symbol, null);
            }
          }

          return quotes;
        },
        getCandlestickSnapshot: (symbol) =>
          symbol === monitorConfig.monitorSymbol
            ? createCandlestickSnapshot(symbol, createCandles(120, 100, 0.2))
            : null,
      });

      await mainProgram({
        marketDataClient,
        trader,
        lastState,
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        doomsdayProtection: createDoomsdayProtectionDouble(),
        signalProcessor,
        tradingConfig,
        dailyLossTracker: createNoopDailyLossTracker(),
        monitorContexts,
        symbolRegistry,
        indicatorCache,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        runtimeGateMode: 'skip',
        dayLifecycleManager,
      });

      expect(lastState.lifecycleState).toBe('MIDNIGHT_CLEANED');
      expect(lastState.pendingOpenRebuild).toBeTrue();
      expect(lastState.isTradingEnabled).toBeFalse();
      expect(buyTaskQueue.isEmpty()).toBeTrue();
      expect(sellTaskQueue.isEmpty()).toBeTrue();
      expect(cancelAllCalls).toBe(1);
      expect(postTradeStopCount).toBe(1);

      await mainProgram({
        marketDataClient,
        trader,
        lastState,
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        doomsdayProtection: createDoomsdayProtectionDouble(),
        signalProcessor,
        tradingConfig,
        dailyLossTracker: createNoopDailyLossTracker(),
        monitorContexts,
        symbolRegistry,
        indicatorCache,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        runtimeGateMode: 'skip',
        dayLifecycleManager,
      });

      expect(runOpenRebuildCount).toBe(1);
      expect(lastState.lifecycleState).toBe('ACTIVE');
      expect(lastState.pendingOpenRebuild).toBeFalse();
      expect(lastState.isTradingEnabled).toBeTrue();
      expect(postTradeStartCount).toBe(1);

      sellTaskQueue.push({
        type: 'IMMEDIATE_SELL',
        monitorSymbol: monitorConfig.monitorSymbol,
        data: createSignal({
          symbol: 'BULL.HK',
          action: 'SELLCALL',
          reason: 'after-open-rebuild',
          triggerTimeMs: Date.now(),
        }),
      });
      await Bun.sleep(80);

      expect(submittedActions).toEqual(['SELLCALL']);
    } finally {
      await Promise.all([
        buyProcessor.stopAndDrain(),
        sellProcessor.stopAndDrain(),
        monitorTaskProcessor.stopAndDrain(),
      ]);
    }
  });
});
