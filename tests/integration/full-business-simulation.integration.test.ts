/**
 * full-business-simulation 集成测试
 *
 * 功能：
 * - 验证完整业务仿真端到端场景与业务期望。
 */
import { describe, expect, it, mock } from 'bun:test';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createMonitorContext } from '../../src/services/monitorContext/index.js';
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
import { createRefreshGate } from '../../src/utils/refreshGate/index.js';
import { initMonitorState } from '../../src/utils/helpers/index.js';
import { createDayLifecycleManager } from '../../src/main/lifecycle/dayLifecycleManager.js';
import { createSignalRuntimeDomain } from '../../src/main/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { createGlobalStateDomain } from '../../src/main/lifecycle/cacheDomains/globalStateDomain.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import type { Candlestick } from 'longport';
import type { CandleData } from '../../src/types/data.js';
import type { LastState, MonitorContext } from '../../src/types/state.js';
import type { MultiMonitorTradingConfig, MonitorConfig } from '../../src/types/config.js';
import type {
  DailyLossTracker,
  UnrealizedLossMonitor,
} from '../../src/core/riskController/types.js';
import type { DayLifecycleManager } from '../../src/main/lifecycle/types.js';
import type {
  MonitorTaskData,
  MonitorTaskType,
} from '../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import {
  createAccountSnapshotDouble,
  createDoomsdayProtectionDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

let autoSymbolCandidates: Array<{ symbol: string; callPrice: number } | null> = [];

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun:test mock.module 在导入 createAutoSymbolManager 前同步注册
mock.module('../../src/services/autoSymbolFinder/index.js', () => ({
  findBestWarrant: async () => autoSymbolCandidates.shift() ?? null,
}));

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
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });

    const indicatorCache = createIndicatorCache({ maxEntries: 300 });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
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
      verificationConfig: monitorConfig.verificationConfig,
    });

    const strategy = {
      generateCloseSignals: () => ({
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
        maybeSwitchOnInterval: async () => {},
        maybeSwitchOnDistance: async () => {},
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
        recordCooldown: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
      },
    });

    const refreshGate = createRefreshGate();
    const buyProcessor = createBuyProcessor({
      taskQueue: buyTaskQueue,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
      signalProcessor,
      trader,
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
      getLastState: () => lastState,
      refreshGate,
      getCanProcessTask: () => lastState.isTradingEnabled,
    });

    let orderMonitorScheduleCount = 0;
    let postTradeEnqueueCount = 0;
    const candles = createMockCandlesticks(120, 100, 0.2);

    buyProcessor.start();
    sellProcessor.start();
    try {
      await mainProgram({
        marketDataClient: {
          getQuoteContext: async () => ({}) as never,
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
          subscribeSymbols: async () => {},
          unsubscribeSymbols: async () => {},
          subscribeCandlesticks: async () => [],
          getRealtimeCandlesticks: async () => candles,
          isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
          resetRuntimeSubscriptionsAndCaches: async () => {},
        },
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
        orderMonitorWorker: {
          start: () => {},
          schedule: () => {
            orderMonitorScheduleCount += 1;
          },
          stopAndDrain: async () => {},
          clearLatestQuotes: () => {},
        },
        postTradeRefresher: {
          start: () => {},
          enqueue: () => {
            postTradeEnqueueCount += 1;
          },
          stopAndDrain: async () => {},
          clearPending: () => {},
        },
        runtimeGateMode: 'skip',
        dayLifecycleManager: createNoopDayLifecycleManager(),
      });

      await Bun.sleep(80);

      expect(submittedActions).toEqual(['SELLCALL']);
      expect(orderMonitorScheduleCount).toBe(1);
      expect(postTradeEnqueueCount).toBe(1);
    } finally {
      delayedSignalVerifier.destroy();
      await Promise.all([buyProcessor.stopAndDrain(), sellProcessor.stopAndDrain()]);
    }
  });

  it('simulates auto-search and auto-switch through processMonitor + monitorTaskProcessor', async () => {
    autoSymbolCandidates = [
      { symbol: 'OLD_BULL.HK', callPrice: 20_000 },
      null,
      { symbol: 'NEW_BULL.HK', callPrice: 21_000 },
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
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });

    const indicatorCache = createIndicatorCache({ maxEntries: 300 });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    const monitorState = initMonitorState(monitorConfig);
    const lastState = createSimulationLastState({
      monitorConfig,
      monitorState,
      positions: [],
      currentDayKey: '2026-02-16',
    });

    const executedActions: Array<{ action: string; symbol: string }> = [];
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
      cancelOrder: async () => true,
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
        return {
          warrantType: 'BULL',
          distanceToStrikePercent: 0.1,
        };
      },
    });

    const autoSymbolManager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async () => new Map(),
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => [],
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
        resetRuntimeSubscriptionsAndCaches: async () => {},
      },
      trader,
      orderRecorder,
      riskChecker,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
    });

    const delayedSignalVerifier = createDelayedSignalVerifier({
      indicatorCache,
      verificationConfig: monitorConfig.verificationConfig,
    });
    const monitorContext = createMonitorContext({
      config: monitorConfig,
      state: monitorState,
      symbolRegistry,
      quotesMap: new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)]]),
      strategy: {
        generateCloseSignals: () => ({
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

    const refreshGate = createRefreshGate();
    const monitorTaskProcessor = createMonitorTaskProcessor({
      monitorTaskQueue,
      refreshGate,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol) ?? null,
      clearQueuesForDirection: () => {},
      trader,
      lastState,
      tradingConfig,
      getCanProcessTask: () => true,
    });

    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordCooldown: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
      },
    });

    const sharedMainContext = {
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async () => new Map(),
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => createMockCandlesticks(120, 200, 0.5),
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
        resetRuntimeSubscriptionsAndCaches: async () => {},
      },
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
      runtimeGateMode: 'skip' as const,
      dayLifecycleManager: createNoopDayLifecycleManager(),
    };

    monitorTaskProcessor.start();
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
      await Bun.sleep(80);

      const searchedSeat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
      expect(searchedSeat.status).toBe('READY');
      expect(searchedSeat.symbol).toBe('OLD_BULL.HK');
      expect(symbolRegistry.getSeatVersion(monitorConfig.monitorSymbol, 'LONG')).toBe(2);

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
      await Bun.sleep(80);

      expect(executedActions[0]?.action).toBe('SELLCALL');
      expect(executedActions[0]?.symbol).toBe('OLD_BULL.HK');

      lastState.cachedPositions = [];
      lastState.positionCache.update([]);

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
        new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', 20_020, 1)],
          ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
          ['NEW_BULL.HK', createQuoteDouble('NEW_BULL.HK', 1, 100)],
        ]),
      );
      await Bun.sleep(80);

      expect(executedActions[1]?.action).toBe('BUYCALL');
      expect(executedActions[1]?.symbol).toBe('NEW_BULL.HK');
      expect(executedActions).toHaveLength(2);

      const finalSeat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
      expect(finalSeat.status).toBe('READY');
      expect(finalSeat.symbol).toBe('NEW_BULL.HK');
      expect(symbolRegistry.getSeatVersion(monitorConfig.monitorSymbol, 'LONG')).toBe(3);
    } finally {
      delayedSignalVerifier.destroy();
      await monitorTaskProcessor.stopAndDrain();
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
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });

    const indicatorCache = createIndicatorCache({ maxEntries: 300 });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
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
        generateCloseSignals: () => ({
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
        maybeSwitchOnInterval: async () => {},
        maybeSwitchOnDistance: async () => {},
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
        recordCooldown: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
      },
    });

    const refreshGate = createRefreshGate();
    const buyProcessor = createBuyProcessor({
      taskQueue: buyTaskQueue,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
      signalProcessor,
      trader,
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
      getLastState: () => lastState,
      refreshGate,
      getCanProcessTask: () => lastState.isTradingEnabled,
    });
    const monitorTaskProcessor = createMonitorTaskProcessor({
      monitorTaskQueue,
      refreshGate,
      getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol) ?? null,
      clearQueuesForDirection: () => {},
      trader,
      lastState,
      tradingConfig,
      getCanProcessTask: () => lastState.isTradingEnabled,
    });

    let runOpenRebuildCount = 0;
    let orderMonitorStartCount = 0;
    let orderMonitorStopCount = 0;
    let postTradeStartCount = 0;
    let postTradeStopCount = 0;

    const signalRuntimeDomain = createSignalRuntimeDomain({
      monitorContexts,
      buyProcessor,
      sellProcessor,
      monitorTaskProcessor,
      orderMonitorWorker: {
        start: () => {
          orderMonitorStartCount += 1;
        },
        schedule: () => {},
        stopAndDrain: async () => {
          orderMonitorStopCount += 1;
        },
        clearLatestQuotes: () => {},
      },
      postTradeRefresher: {
        start: () => {
          postTradeStartCount += 1;
        },
        enqueue: () => {},
        stopAndDrain: async () => {
          postTradeStopCount += 1;
        },
        clearPending: () => {},
      },
      indicatorCache,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
      refreshGate,
      releaseSignal: () => {},
    });

    const globalStateDomain = createGlobalStateDomain({
      lastState,
      runOpenRebuild: async () => {
        runOpenRebuildCount += 1;
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
      const marketDataClient = {
        getQuoteContext: async () => ({}) as never,
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
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => createMockCandlesticks(120, 100, 0.2),
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
        resetRuntimeSubscriptionsAndCaches: async () => {},
      };

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
        dayLifecycleManager,
      });

      expect(lastState.lifecycleState).toBe('MIDNIGHT_CLEANED');
      expect(lastState.pendingOpenRebuild).toBeTrue();
      expect(lastState.isTradingEnabled).toBeFalse();
      expect(buyTaskQueue.isEmpty()).toBeTrue();
      expect(sellTaskQueue.isEmpty()).toBeTrue();
      expect(cancelAllCalls).toBe(1);
      expect(orderMonitorStopCount).toBe(1);
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
        dayLifecycleManager,
      });

      expect(runOpenRebuildCount).toBe(1);
      expect(lastState.lifecycleState).toBe('ACTIVE');
      expect(lastState.pendingOpenRebuild).toBeFalse();
      expect(lastState.isTradingEnabled).toBeTrue();
      expect(orderMonitorStartCount).toBe(1);
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
