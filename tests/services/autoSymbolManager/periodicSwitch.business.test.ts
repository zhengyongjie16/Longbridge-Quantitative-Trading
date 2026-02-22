/**
 * periodicSwitch 业务回归测试
 *
 * 功能：
 * - 按方案文档验证周期换标新增能力与关键边界行为。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide } from 'longport';

import { createSwitchStateMachine } from '../../../src/services/autoSymbolManager/switchStateMachine.js';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import {
  calculateBuyQuantityByNotional,
  createSignalBuilder,
  resolveDirectionSymbols,
} from '../../../src/services/autoSymbolManager/signalBuilder.js';
import { resolveAutoSearchThresholds } from '../../../src/services/autoSymbolManager/thresholdResolver.js';
import {
  getHKDateKey,
  getTradingMinutesSinceOpen,
} from '../../../src/utils/helpers/tradingTime.js';
import { signalObjectPool } from '../../../src/utils/objectPool/index.js';
import { PENDING_ORDER_STATUSES } from '../../../src/constants/index.js';

import type { Quote } from '../../../src/types/quote.js';
import type { SwitchState } from '../../../src/services/autoSymbolManager/types.js';

import {
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

function createLoggerStub() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  } as never;
}

function createQuotes(prices: Readonly<Record<string, number>>): ReadonlyMap<string, Quote | null> {
  const map = new Map<string, Quote | null>();
  for (const [symbol, price] of Object.entries(prices)) {
    map.set(symbol, {
      symbol,
      name: symbol,
      price,
      prevClose: price,
      timestamp: Date.now(),
      lotSize: 100,
    });
  }
  return map;
}

type HarnessParams = {
  readonly switchIntervalMinutes: number;
  readonly nowMs: number;
  readonly lastSeatReadyAt: number | null;
  readonly findBestSymbol: string;
  readonly getBuyOrdersCount?: () => number;
  readonly executeSignalsHook?: () => void;
};

function createPeriodicHarness(params: HarnessParams): {
  machine: ReturnType<typeof createSwitchStateMachine>;
  symbolRegistry: ReturnType<typeof createSymbolRegistryDouble>;
  seatStateManager: ReturnType<typeof createSeatStateManager>;
  setNowMs: (nextNowMs: number) => void;
} {
  let currentNowMs = params.nowMs;

  const monitorConfig = createMonitorConfigDouble({
    autoSearchConfig: {
      autoSearchEnabled: true,
      autoSearchMinDistancePctBull: 0.35,
      autoSearchMinDistancePctBear: -0.35,
      autoSearchMinTurnoverPerMinuteBull: 100_000,
      autoSearchMinTurnoverPerMinuteBear: 100_000,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 0,
      switchIntervalMinutes: params.switchIntervalMinutes,
      switchDistanceRangeBull: { min: 0.2, max: 1.5 },
      switchDistanceRangeBear: { min: -1.5, max: -0.2 },
    },
  });

  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: 'HSI.HK',
    longSeat: {
      symbol: 'OLD_BULL.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatReadyAt: params.lastSeatReadyAt,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longVersion: 1,
  });

  const switchStates = new Map<'LONG' | 'SHORT', SwitchState>();
  const switchSuppressions = new Map();
  const periodicSwitchPending = new Map();

  const seatStateManager = createSeatStateManager({
    monitorSymbol: 'HSI.HK',
    symbolRegistry,
    switchStates,
    switchSuppressions,
    now: () => new Date(currentNowMs),
    logger: createLoggerStub(),
    getHKDateKey,
  });

  const signalBuilder = createSignalBuilder({ signalObjectPool });

  const trader = createTraderDouble({
    executeSignals: async () => {
      params.executeSignalsHook?.();
      return { submittedCount: 1 };
    },
    getPendingOrders: async () => [],
  });

  const orderRecorder = createOrderRecorderDouble({
    getBuyOrdersForSymbol: () => {
      const count = params.getBuyOrdersCount?.() ?? 0;
      if (count <= 0) {
        return [];
      }
      return Array.from({ length: count }, (_, index) => ({
        orderId: `B-${index}`,
        symbol: 'OLD_BULL.HK',
        executedPrice: 1,
        executedQuantity: 100,
        executedTime: 1,
        submittedAt: undefined,
        updatedAt: undefined,
      }));
    },
  });

  const machine = createSwitchStateMachine({
    autoSearchConfig: monitorConfig.autoSearchConfig,
    monitorConfig,
    monitorSymbol: 'HSI.HK',
    symbolRegistry,
    trader,
    orderRecorder,
    riskChecker: createRiskCheckerDouble({
      getWarrantDistanceInfo: () => ({ warrantType: 'BULL', distanceToStrikePercent: 0.1 }),
    }),
    now: () => new Date(currentNowMs),
    switchStates,
    periodicSwitchPending,
    resolveSuppression: seatStateManager.resolveSuppression,
    markSuppression: seatStateManager.markSuppression,
    clearSeat: seatStateManager.clearSeat,
    buildSeatState: seatStateManager.buildSeatState,
    updateSeatState: seatStateManager.updateSeatState,
    resolveAutoSearchThresholds,
    resolveAutoSearchThresholdInput: () => ({
      minDistancePct: 0.35,
      minTurnoverPerMinute: 100_000,
    }),
    buildFindBestWarrantInput: async () => ({}) as never,
    findBestWarrant: async () => ({
      symbol: params.findBestSymbol,
      name: params.findBestSymbol,
      callPrice: 21_000,
      distancePct: 0.5,
      turnover: 1_000_000,
      turnoverPerMinute: 100_000,
    }),
    resolveDirectionSymbols,
    calculateBuyQuantityByNotional,
    buildOrderSignal: signalBuilder.buildOrderSignal,
    signalObjectPool,
    pendingOrderStatuses: PENDING_ORDER_STATUSES,
    buySide: OrderSide.Buy,
    logger: createLoggerStub(),
    maxSearchFailuresPerDay: 3,
    getHKDateKey,
    getTradingMinutesSinceOpen,
  });

  return {
    machine,
    symbolRegistry,
    seatStateManager,
    setNowMs: (nextNowMs: number) => {
      currentNowMs = nextNowMs;
    },
  };
}

describe('periodic auto-switch regression', () => {
  it('case1: switchIntervalMinutes=0 does not trigger periodic switch', async () => {
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 0,
      nowMs,
      lastSeatReadyAt: nowMs - 60 * 60 * 1000,
      findBestSymbol: 'NEW_BULL.HK',
    });

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
      openProtectionActive: false,
    });

    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('READY');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('case2: periodic trigger starts switch when no buy orders', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z'); // 09:00 HK
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z'); // 09:31 HK
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatReadyAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
    });

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
      openProtectionActive: false,
    });

    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('SWITCHING');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeTrue();
  });

  it('case3: periodic trigger enters pending on position and switches after cleared', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    let buyOrdersCount = 1;
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatReadyAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      getBuyOrdersCount: () => buyOrdersCount,
    });

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
      openProtectionActive: false,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('READY');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();

    buyOrdersCount = 0;
    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs + 1000),
      canTradeNow: true,
      openProtectionActive: false,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('SWITCHING');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeTrue();
  });

  it('case4: distance switch takes priority while periodic pending', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatReadyAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      getBuyOrdersCount: () => 1,
    });

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
      openProtectionActive: false,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('READY');

    await harness.machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: createQuotes({ 'OLD_BULL.HK': 1, 'NEW_BULL.HK': 1 }),
      positions: [],
    });

    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('READY');
    expect(seat.symbol).toBe('NEW_BULL.HK');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('case5: same candidate marks suppression and skips periodic switch', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatReadyAt: readyMs,
      findBestSymbol: 'OLD_BULL.HK',
    });

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
      openProtectionActive: false,
    });

    const suppression = harness.seatStateManager.resolveSuppression('LONG', 'OLD_BULL.HK');
    expect(suppression?.symbol).toBe('OLD_BULL.HK');
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('READY');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('case6: no trigger in non-trading session, triggers after session resumes', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatReadyAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
    });

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: false,
      openProtectionActive: false,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('READY');

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs + 1000),
      canTradeNow: true,
      openProtectionActive: false,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('SWITCHING');
  });

  it('case7: trading-minute timer pauses at lunch break', async () => {
    const readyMs = Date.parse('2026-02-16T03:59:00.000Z'); // 11:59 HK
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 2,
      nowMs: Date.parse('2026-02-16T04:30:00.000Z'), // 12:30 HK
      lastSeatReadyAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
    });

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(Date.parse('2026-02-16T04:30:00.000Z')), // 午休
      canTradeNow: false,
      openProtectionActive: false,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('READY');

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(Date.parse('2026-02-16T05:00:00.000Z')), // 13:00 HK
      canTradeNow: true,
      openProtectionActive: false,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('READY');

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(Date.parse('2026-02-16T05:01:00.000Z')), // 13:01 HK
      canTradeNow: true,
      openProtectionActive: false,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('SWITCHING');
  });

  it('case8: open protection blocks periodic switch until protection ends', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatReadyAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
    });

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
      openProtectionActive: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('READY');

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs + 1000),
      canTradeNow: true,
      openProtectionActive: false,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('SWITCHING');
  });

  it('case9: periodic switch never submits sell/rebuy orders', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    let executeCalls = 0;
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatReadyAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      executeSignalsHook: () => {
        executeCalls += 1;
      },
    });

    await harness.machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
      openProtectionActive: false,
    });
    expect(harness.machine.hasPendingSwitch('LONG')).toBeTrue();

    await harness.machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: createQuotes({ 'OLD_BULL.HK': 1, 'NEW_BULL.HK': 1 }),
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
          market: 'HK',
        },
      ],
    });

    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('READY');
    expect(seat.symbol).toBe('NEW_BULL.HK');
    expect(executeCalls).toBe(0);
  });

  it('case10: periodic switch cancel stage only cancels pending buy orders', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const canceledOrderIds: string[] = [];

    const monitorConfig = createMonitorConfigDouble({
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
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: readyMs,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });

    const switchStates = new Map<'LONG' | 'SHORT', SwitchState>();
    const switchSuppressions = new Map();
    const periodicSwitchPending = new Map();
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder({ signalObjectPool });

    const pendingStatus = Array.from(PENDING_ORDER_STATUSES)[0];
    if (!pendingStatus) {
      throw new Error('PENDING_ORDER_STATUSES must contain at least one status');
    }
    const trader = createTraderDouble({
      getPendingOrders: async () => [
        {
          orderId: 'BUY-1',
          symbol: 'OLD_BULL.HK',
          side: OrderSide.Buy,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: pendingStatus,
          orderType: 'ELO' as never,
        },
        {
          orderId: 'SELL-1',
          symbol: 'OLD_BULL.HK',
          side: OrderSide.Sell,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: pendingStatus,
          orderType: 'ELO' as never,
        },
      ],
      cancelOrder: async (orderId: string) => {
        canceledOrderIds.push(orderId);
        return true;
      },
    });

    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [],
      }),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () => ({ warrantType: 'BULL', distanceToStrikePercent: 0.1 }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending,
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      clearSeat: seatStateManager.clearSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveAutoSearchThresholds,
      resolveAutoSearchThresholdInput: () => ({
        minDistancePct: 0.35,
        minTurnoverPerMinute: 100_000,
      }),
      buildFindBestWarrantInput: async () => ({}) as never,
      findBestWarrant: async () => ({
        symbol: 'NEW_BULL.HK',
        name: 'NEW_BULL.HK',
        callPrice: 21_000,
        distancePct: 0.5,
        turnover: 1_000_000,
        turnoverPerMinute: 100_000,
      }),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      signalObjectPool,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      getTradingMinutesSinceOpen,
    });

    await machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
      openProtectionActive: false,
    });
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();

    await machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: createQuotes({ 'OLD_BULL.HK': 1, 'NEW_BULL.HK': 1 }),
      positions: [],
    });

    expect(canceledOrderIds).toEqual(['BUY-1']);
  });
});
