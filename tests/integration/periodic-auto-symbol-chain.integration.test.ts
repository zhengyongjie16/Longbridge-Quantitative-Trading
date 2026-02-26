/**
 * periodic-auto-symbol-chain 集成测试
 *
 * 功能：
 * - 验证周期换标的任务链路：任务调度 -> 任务处理器 -> 自动换标管理器状态机。
 */
import { describe, expect, it, mock } from 'bun:test';

import { scheduleAutoSymbolTasks } from '../../src/main/processMonitor/autoSymbolTasks.js';
import { createAutoSymbolManager } from '../../src/services/autoSymbolManager/index.js';
import { createRefreshGate } from '../../src/utils/refreshGate/index.js';
import { createMonitorTaskQueue } from '../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskProcessor } from '../../src/main/asyncProgram/monitorTaskProcessor/index.js';

import type { MultiMonitorTradingConfig } from '../../src/types/config.js';
import type { LastState, MonitorContext } from '../../src/types/state.js';
import type { MainProgramContext } from '../../src/main/mainProgram/types.js';
import type {
  MonitorTaskData,
  MonitorTaskStatus,
  MonitorTaskType,
} from '../../src/main/asyncProgram/monitorTaskProcessor/types.js';

import {
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

let candidateQueue: Array<{ symbol: string; callPrice: number } | null> = [];

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun:test mock.module 同步注册
mock.module('../../src/services/autoSymbolFinder/index.js', () => ({
  findBestWarrant: async () => candidateQueue.shift() ?? null,
}));

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitUntil timeout');
    }
    await Bun.sleep(10);
  }
}

describe('periodic auto-symbol full chain integration', () => {
  it('completes periodic switch through AUTO_SYMBOL_TICK and AUTO_SYMBOL_SWITCH_DISTANCE tasks', async () => {
    const readyMs = Date.parse('2026-02-16T01:30:00.000Z');
    let currentNowMs = Date.parse('2026-02-16T01:31:00.000Z');
    candidateQueue = [{ symbol: 'NEW_BULL.HK', callPrice: 21_000 }];
    const tradingCalendarSnapshot = new Map([
      ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
    ]);

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 1,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: readyMs,
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

    let executeSignalsCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        executeSignalsCalls += signals.length;
        return { submittedCount: signals.length, submittedOrderIds: [] };
      },
      getPendingOrders: async () => [],
      cancelOrder: async () => true,
    });

    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [],
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: () => ({ warrantType: 'BULL', distanceToStrikePercent: 0.1 }),
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
      now: () => new Date(currentNowMs),
      getTradingCalendarSnapshot: () => tradingCalendarSnapshot,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    const monitorContext = {
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager,
      orderRecorder,
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      riskChecker,
      unrealizedLossMonitor: {
        monitorUnrealizedLoss: async () => {},
      },
      longSymbolName: 'OLD_BULL.HK',
      shortSymbolName: '',
      monitorSymbolName: 'HSI.HK',
      longQuote: null,
      shortQuote: null,
      monitorQuote: null,
    } as unknown as MonitorContext;
    const mainContext = {
      monitorTaskQueue,
    } as unknown as MainProgramContext;

    const statuses: MonitorTaskStatus[] = [];
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue,
      refreshGate: createRefreshGate(),
      getMonitorContext: () => monitorContext as never,
      clearQueuesForDirection: () => {},
      trader,
      lastState: createLastState(),
      tradingConfig: {
        monitors: [monitorConfig],
      } as unknown as MultiMonitorTradingConfig,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
    });

    processor.start();
    try {
      scheduleAutoSymbolTasks({
        monitorSymbol: 'HSI.HK',
        monitorContext,
        mainContext,
        autoSearchEnabled: true,
        currentTimeMs: currentNowMs,
        canTradeNow: true,
        openProtectionActive: false,
        monitorPriceChanged: false,
        resolvedMonitorPrice: 20_000,
        quotesMap: new Map(),
      });

      await waitUntil(() => statuses.length >= 2);
      expect(statuses).toEqual(['processed', 'processed']);

      const switchingSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
      expect(switchingSeat.status).toBe('SWITCHING');
      expect(switchingSeat.symbol).toBe('OLD_BULL.HK');
      expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeTrue();
      expect(executeSignalsCalls).toBe(0);

      statuses.length = 0;
      currentNowMs += 1_000;

      scheduleAutoSymbolTasks({
        monitorSymbol: 'HSI.HK',
        monitorContext,
        mainContext,
        autoSearchEnabled: true,
        currentTimeMs: currentNowMs,
        canTradeNow: true,
        openProtectionActive: false,
        monitorPriceChanged: false,
        resolvedMonitorPrice: 20_000,
        quotesMap: new Map(),
      });

      await waitUntil(() => statuses.length >= 3);
      expect(statuses).toEqual(['processed', 'processed', 'processed']);

      const finalSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
      expect(finalSeat.status).toBe('READY');
      expect(finalSeat.symbol).toBe('NEW_BULL.HK');
      expect(finalSeat.lastSeatReadyAt).toBe(currentNowMs);
      expect(finalSeat.callPrice).toBe(21_000);
      expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();
      expect(executeSignalsCalls).toBe(0);
      expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
    } finally {
      await processor.stopAndDrain();
    }
  });

  it('applies cross-day trading-duration rule before periodic switch is triggered', async () => {
    const readyMs = Date.parse('2026-02-16T07:59:00.000Z'); // Day1 15:59 HK
    let currentNowMs = Date.parse('2026-02-17T01:30:00.000Z'); // Day2 09:30 HK
    candidateQueue = [null, { symbol: 'NEW_BULL.HK', callPrice: 21_000 }];
    const tradingCalendarSnapshot = new Map([
      ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
      ['2026-02-17', { isTradingDay: true, isHalfDay: false }],
    ]);

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 2,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: readyMs,
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

    let executeSignalsCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        executeSignalsCalls += signals.length;
        return { submittedCount: signals.length, submittedOrderIds: [] };
      },
      getPendingOrders: async () => [],
      cancelOrder: async () => true,
    });

    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [],
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: () => ({ warrantType: 'BULL', distanceToStrikePercent: 0.1 }),
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
      now: () => new Date(currentNowMs),
      getTradingCalendarSnapshot: () => tradingCalendarSnapshot,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    const monitorContext = {
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager,
      orderRecorder,
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      riskChecker,
      unrealizedLossMonitor: {
        monitorUnrealizedLoss: async () => {},
      },
      longSymbolName: 'OLD_BULL.HK',
      shortSymbolName: '',
      monitorSymbolName: 'HSI.HK',
      longQuote: null,
      shortQuote: null,
      monitorQuote: null,
    } as unknown as MonitorContext;
    const mainContext = {
      monitorTaskQueue,
    } as unknown as MainProgramContext;

    const statuses: MonitorTaskStatus[] = [];
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue,
      refreshGate: createRefreshGate(),
      getMonitorContext: () => monitorContext as never,
      clearQueuesForDirection: () => {},
      trader,
      lastState: createLastState(),
      tradingConfig: {
        monitors: [monitorConfig],
      } as unknown as MultiMonitorTradingConfig,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
    });

    processor.start();
    try {
      scheduleAutoSymbolTasks({
        monitorSymbol: 'HSI.HK',
        monitorContext,
        mainContext,
        autoSearchEnabled: true,
        currentTimeMs: currentNowMs,
        canTradeNow: true,
        openProtectionActive: false,
        monitorPriceChanged: false,
        resolvedMonitorPrice: 20_000,
        quotesMap: new Map(),
      });

      await waitUntil(() => statuses.length >= 2);
      expect(statuses).toEqual(['processed', 'processed']);
      expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('READY');
      expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();

      statuses.length = 0;
      currentNowMs += 60_000; // Day2 09:31 HK

      scheduleAutoSymbolTasks({
        monitorSymbol: 'HSI.HK',
        monitorContext,
        mainContext,
        autoSearchEnabled: true,
        currentTimeMs: currentNowMs,
        canTradeNow: true,
        openProtectionActive: false,
        monitorPriceChanged: false,
        resolvedMonitorPrice: 20_000,
        quotesMap: new Map(),
      });

      await waitUntil(() => statuses.length >= 2);
      expect(statuses).toEqual(['processed', 'processed']);

      const switchingSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
      expect(switchingSeat.status).toBe('SWITCHING');
      expect(switchingSeat.symbol).toBe('OLD_BULL.HK');
      expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeTrue();

      statuses.length = 0;
      currentNowMs += 1_000;

      scheduleAutoSymbolTasks({
        monitorSymbol: 'HSI.HK',
        monitorContext,
        mainContext,
        autoSearchEnabled: true,
        currentTimeMs: currentNowMs,
        canTradeNow: true,
        openProtectionActive: false,
        monitorPriceChanged: false,
        resolvedMonitorPrice: 20_000,
        quotesMap: new Map(),
      });

      await waitUntil(() => statuses.length >= 3);
      expect(statuses).toEqual(['processed', 'processed', 'processed']);

      const finalSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
      expect(finalSeat.status).toBe('READY');
      expect(finalSeat.symbol).toBe('NEW_BULL.HK');
      expect(finalSeat.lastSeatReadyAt).toBe(currentNowMs);
      expect(finalSeat.callPrice).toBe(21_000);
      expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();
      expect(executeSignalsCalls).toBe(0);
      expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
    } finally {
      await processor.stopAndDrain();
    }
  });
});
