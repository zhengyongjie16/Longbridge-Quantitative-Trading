/**
 * periodic-auto-symbol-chain 集成测试
 *
 * 功能：
 * - 验证周期换标的任务链路：任务调度 -> 任务处理器 -> 自动换标管理器状态机。
 */
import { describe, expect, it } from 'bun:test';

import { createAutoSymbolManager } from '../../src/services/autoSymbolManager/index.js';
import { createMonitorTaskQueue } from '../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskProcessor } from '../../src/main/asyncProgram/monitorTaskProcessor/index.js';

import type { MultiMonitorTradingConfig } from '../../src/types/config.js';
import type { LastState, MonitorContext } from '../../src/types/state.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskStatus,
} from '../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTaskQueue } from '../../src/main/asyncProgram/monitorTaskQueue/types.js';

import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createQuoteSubscriptionRuntimeDouble,
  createPeriodicSwitchWakeupRuntimeDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';
import { createWarrantCandidateWithOverrides } from '../services/autoSymbolManager/utils.js';

let candidateQueue: Array<ReturnType<typeof createWarrantCandidateWithOverrides> | null> = [];

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

function schedulePeriodicTick(
  params: Readonly<{
    monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
    monitorContext: MonitorContext;
    monitorSymbol: string;
    direction: 'LONG' | 'SHORT';
    currentTimeMs: number;
  }>,
): void {
  const { monitorTaskQueue, monitorContext, monitorSymbol, direction, currentTimeMs } = params;
  const seatSnapshot = monitorContext.symbolRegistry.getSeatState(monitorSymbol, direction);
  if (
    seatSnapshot.status !== 'ACTIVE' ||
    seatSnapshot.symbol === null ||
    seatSnapshot.lastSeatActivatedAt === null
  ) {
    return;
  }

  monitorTaskQueue.scheduleLatest({
    type: 'AUTO_SYMBOL_TICK',
    dedupeKey: `${monitorSymbol}:AUTO_SYMBOL_TICK:${direction}`,
    monitorSymbol,
    data: {
      monitorSymbol,
      direction,
      seatVersion: monitorContext.symbolRegistry.getSeatVersion(monitorSymbol, direction),
      symbol: seatSnapshot.symbol,
      lastSeatActivatedAt: seatSnapshot.lastSeatActivatedAt,
      currentTimeMs,
    },
  });
}

describe('periodic auto-symbol full chain integration', () => {
  it('hands periodic no-candidate back to EMPTY without letting AUTO_SYMBOL_TICK restart auto-search', async () => {
    const readyMs = Date.parse('2026-02-16T01:30:00.000Z');
    let currentNowMs = Date.parse('2026-02-16T01:31:00.000Z');
    candidateQueue = [
      null,
      null,
      createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: 21_000 }),
    ];
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
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: readyMs,
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

    const trader = createTraderDouble({
      getPendingOrders: async () => [],
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
    });
    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [],
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceToStrikePercent: 0.1,
        }),
    });

    const autoSymbolManager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble(),
      trader,
      orderRecorder,
      riskChecker,
      findBestWarrant: async () => candidateQueue.shift() ?? null,
      now: () => new Date(currentNowMs),
      getTradingCalendarSnapshot: () => tradingCalendarSnapshot,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
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
        monitorDirectionalUnrealizedLoss: async () => {},
      },
      longSymbolName: 'OLD_BULL.HK',
      shortSymbolName: '',
      monitorSymbolName: 'HSI.HK',
      longQuote: null,
      shortQuote: null,
      monitorQuote: null,
    } as unknown as MonitorContext;
    const statuses: MonitorTaskStatus[] = [];
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue,
      getMonitorContext: () => monitorContext,
      trader,
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeDouble(),
      lastState: createLastState(),
      tradingConfig: {
        monitors: [monitorConfig],
      } as unknown as MultiMonitorTradingConfig,
      getCanTradeNow: () => true,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
    });

    processor.start();
    try {
      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        currentTimeMs: currentNowMs,
      });

      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        currentTimeMs: currentNowMs,
      });

      await waitUntil(() => statuses.length > 0);
      expect(statuses).toEqual(['processed']);

      const seatAfterPeriodicMiss = symbolRegistry.getSeatState('HSI.HK', 'LONG');
      expect(seatAfterPeriodicMiss.status).toBe('EMPTY');
      expect(seatAfterPeriodicMiss.symbol).toBeNull();
      expect(seatAfterPeriodicMiss.searchFailCountToday).toBe(1);
      expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
      expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();

      statuses.length = 0;
      currentNowMs += 600_000;

      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        currentTimeMs: currentNowMs,
      });

      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        currentTimeMs: currentNowMs,
      });

      expect(statuses).toEqual([]);

      const seatAfterAutoSearch = symbolRegistry.getSeatState('HSI.HK', 'LONG');
      expect(seatAfterAutoSearch.status).toBe('EMPTY');
      expect(seatAfterAutoSearch.symbol).toBeNull();
      expect(seatAfterAutoSearch.searchFailCountToday).toBe(1);
      expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();
      expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
    } finally {
      await processor.stopAndDrain();
    }
  });

  it('keeps seat ACTIVE when local pending buy order exists before order recorder is written', async () => {
    const readyMs = Date.parse('2026-02-16T01:30:00.000Z');
    const currentNowMs = Date.parse('2026-02-16T01:31:00.000Z');
    candidateQueue = [createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: 21_000 })];
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
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: readyMs,
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

    const trader = createTraderDouble({
      getPendingOrders: async () => [],
      getOrderHoldSymbols: () => new Set(['OLD_BULL.HK']),
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
    });

    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [],
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceToStrikePercent: 0.1,
        }),
    });

    const autoSymbolManager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble(),
      trader,
      orderRecorder,
      riskChecker,
      findBestWarrant: async () => candidateQueue.shift() ?? null,
      now: () => new Date(currentNowMs),
      getTradingCalendarSnapshot: () => tradingCalendarSnapshot,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
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
        monitorDirectionalUnrealizedLoss: async () => {},
      },
      longSymbolName: 'OLD_BULL.HK',
      shortSymbolName: '',
      monitorSymbolName: 'HSI.HK',
      longQuote: null,
      shortQuote: null,
      monitorQuote: null,
    } as unknown as MonitorContext;
    const statuses: MonitorTaskStatus[] = [];
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue,
      getMonitorContext: () => monitorContext,
      trader,
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeDouble(),
      lastState: createLastState(),
      tradingConfig: {
        monitors: [monitorConfig],
      } as unknown as MultiMonitorTradingConfig,
      getCanTradeNow: () => true,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
    });

    processor.start();
    try {
      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        currentTimeMs: currentNowMs,
      });

      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        currentTimeMs: currentNowMs,
      });

      await waitUntil(() => statuses.length > 0);
      expect(statuses).toEqual(['processed']);
      const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
      expect(seat.status).toBe('ACTIVE');
      expect(seat.symbol).toBe('OLD_BULL.HK');
      expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(1);
      expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();
    } finally {
      await processor.stopAndDrain();
    }
  });

  it('keeps seat ACTIVE when local pending sell order remains after order recorder is cleared', async () => {
    const readyMs = Date.parse('2026-02-16T01:30:00.000Z');
    const currentNowMs = Date.parse('2026-02-16T01:31:00.000Z');
    candidateQueue = [createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: 21_000 })];
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
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: readyMs,
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

    const trader = createTraderDouble({
      getPendingOrders: async () => [],
      getOrderHoldSymbols: () => new Set(['OLD_BULL.HK']),
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
    });

    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [],
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceToStrikePercent: 0.1,
        }),
    });

    const autoSymbolManager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble(),
      trader,
      orderRecorder,
      riskChecker,
      findBestWarrant: async () => candidateQueue.shift() ?? null,
      now: () => new Date(currentNowMs),
      getTradingCalendarSnapshot: () => tradingCalendarSnapshot,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
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
        monitorDirectionalUnrealizedLoss: async () => {},
      },
      longSymbolName: 'OLD_BULL.HK',
      shortSymbolName: '',
      monitorSymbolName: 'HSI.HK',
      longQuote: null,
      shortQuote: null,
      monitorQuote: null,
    } as unknown as MonitorContext;
    const statuses: MonitorTaskStatus[] = [];
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue,
      getMonitorContext: () => monitorContext,
      trader,
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeDouble(),
      lastState: createLastState(),
      tradingConfig: {
        monitors: [monitorConfig],
      } as unknown as MultiMonitorTradingConfig,
      getCanTradeNow: () => true,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
    });

    processor.start();
    try {
      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        currentTimeMs: currentNowMs,
      });

      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        currentTimeMs: currentNowMs,
      });

      await waitUntil(() => statuses.length > 0);
      expect(statuses).toEqual(['processed']);
      const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
      expect(seat.status).toBe('ACTIVE');
      expect(seat.symbol).toBe('OLD_BULL.HK');
      expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(1);
      expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();
    } finally {
      await processor.stopAndDrain();
    }
  });

  it('applies cross-day trading-duration rule before periodic switch is triggered', async () => {
    const readyMs = Date.parse('2026-02-16T07:59:00.000Z'); // Day1 15:59 HK
    let currentNowMs = Date.parse('2026-02-17T01:30:00.000Z'); // Day2 09:30 HK
    candidateQueue = [createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: 21_000 })];
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
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: readyMs,
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

    const trader = createTraderDouble({
      getPendingOrders: async () => [],
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
    });

    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [],
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceToStrikePercent: 0.1,
        }),
    });

    const autoSymbolManager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble(),
      trader,
      orderRecorder,
      riskChecker,
      findBestWarrant: async () => candidateQueue.shift() ?? null,
      now: () => new Date(currentNowMs),
      getTradingCalendarSnapshot: () => tradingCalendarSnapshot,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
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
        monitorDirectionalUnrealizedLoss: async () => {},
      },
      longSymbolName: 'OLD_BULL.HK',
      shortSymbolName: '',
      monitorSymbolName: 'HSI.HK',
      longQuote: null,
      shortQuote: null,
      monitorQuote: null,
    } as unknown as MonitorContext;
    const statuses: MonitorTaskStatus[] = [];
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue,
      getMonitorContext: () => monitorContext,
      trader,
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeDouble(),
      lastState: createLastState(),
      tradingConfig: {
        monitors: [monitorConfig],
      } as unknown as MultiMonitorTradingConfig,
      getCanTradeNow: () => true,
      onProcessed: (_task, status) => {
        statuses.push(status);
      },
    });

    processor.start();
    try {
      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        currentTimeMs: currentNowMs,
      });

      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        currentTimeMs: currentNowMs,
      });

      await waitUntil(() => statuses.length > 0);
      expect(statuses).toEqual(['processed']);
      expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
      expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();

      statuses.length = 0;
      currentNowMs += 60_000; // Day2 09:31 HK

      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        currentTimeMs: currentNowMs,
      });

      schedulePeriodicTick({
        monitorTaskQueue,
        monitorContext,
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        currentTimeMs: currentNowMs,
      });

      await waitUntil(() => statuses.length > 0);
      expect(statuses).toEqual(['processed']);

      const switchingSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
      expect(switchingSeat.status).toBe('ACTIVATING');
      expect(switchingSeat.symbol).toBe('NEW_BULL.HK');
      expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();
      expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
    } finally {
      await processor.stopAndDrain();
    }
  });
});
