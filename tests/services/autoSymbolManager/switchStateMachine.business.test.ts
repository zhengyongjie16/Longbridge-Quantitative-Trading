/**
 * switchStateMachine 业务测试
 *
 * 功能：
 * - 验证换标状态机相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderType } from 'longbridge';
import { toMockDecimal } from '../../../mock/longbridge/decimal.js';
import { createSwitchStateMachine } from '../../../src/services/autoSymbolManager/switchStateMachine.js';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import {
  createSignalBuilder,
  calculateBuyQuantityByNotional,
  resolveDirectionSymbols,
} from '../../../src/services/autoSymbolManager/signalBuilder.js';
import { calculateTradingDurationMsBetween, getHKDateKey } from '../../../src/utils/time/index.js';
import { PENDING_ORDER_STATUSES } from '../../../src/constants/index.js';
import type {
  PeriodicSwitchPendingState,
  SwitchState,
  SwitchSuppression,
} from '../../../src/services/autoSymbolManager/types.js';
import type { Quote } from '../../../src/types/quote.js';
import {
  createWarrantDistanceInfoDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import {
  createDirectionalAutoSearchPolicy,
  createFindBestWarrantInputDouble,
  createLoggerStub,
  createWarrantCandidate,
  createWarrantCandidateWithOverrides,
  getDefaultAutoSearchConfig,
} from './utils.js';

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

function createTradingCalendarSnapshot() {
  return new Map([
    ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
    ['2026-02-17', { isTradingDay: true, isHalfDay: false }],
  ]);
}

function createSwitchStatesMap(): Map<'LONG' | 'SHORT', SwitchState> {
  return new Map<'LONG' | 'SHORT', SwitchState>();
}

function createSwitchSuppressionsMap(): Map<'LONG' | 'SHORT', SwitchSuppression> {
  return new Map<'LONG' | 'SHORT', SwitchSuppression>();
}

function createPeriodicSwitchPendingMap(): Map<'LONG' | 'SHORT', PeriodicSwitchPendingState> {
  return new Map<'LONG' | 'SHORT', PeriodicSwitchPendingState>();
}

async function runDistanceSwitch(
  machine: ReturnType<typeof createSwitchStateMachine>,
  params: Parameters<ReturnType<typeof createSwitchStateMachine>['startSwitchOnDistance']>[0],
): Promise<void> {
  if (machine.hasPendingSwitch(params.direction)) {
    await machine.advancePendingSwitch(params);
    return;
  }

  await machine.startSwitchOnDistance(params);
}

describe('autoSymbolManager switchStateMachine business flow', () => {
  it('treats periodic no-candidate as business closeout instead of state-machine failure', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: {
        ...getDefaultAutoSearchConfig(),
        switchIntervalMinutes: 1,
      },
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: Date.parse('2026-02-16T01:00:00.000Z'),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const periodicSwitchPending = createPeriodicSwitchPendingMap();
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const infoMessages: string[] = [];
    const errorMessages: string[] = [];
    const logger = {
      ...createLoggerStub(),
      info: (message: string) => {
        infoMessages.push(message);
      },
      error: (message: string) => {
        errorMessages.push(message);
      },
    };
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger,
      getHKDateKey,
    });
    periodicSwitchPending.set('LONG', {
      pending: true,
      pendingSinceMs: nowMs - 5_000,
      blockedBy: 'ORDER_RECORDER',
    });
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending,
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => null,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
      openProtectionActive: false,
    });

    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('EMPTY');
    expect(seat.symbol).toBeNull();
    expect(seat.searchFailCountToday).toBe(1);
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
    expect(periodicSwitchPending.has('LONG')).toBeFalse();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(infoMessages.some((message) => message.includes('周期换标无候选，清空席位'))).toBeTrue();
    expect(errorMessages.some((message) => message.includes('状态机失败并清席位'))).toBeFalse();
    expect(
      errorMessages.some((message) => message.includes('MISSING_NEXT_SYMBOL_ON_BIND')),
    ).toBeFalse();
  });

  it('marks suppression only for safe-side distance same-symbol and skips switching', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 2,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => ({
        ...createWarrantCandidate('OLD_BULL.HK'),
        callPrice: 20_000,
      }),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    const suppression = seatStateManager.resolveSuppression(
      'LONG',
      'OLD_BULL.HK',
      'DISTANCE_SAFE_SIDE',
    );
    expect(suppression?.symbol).toBe('OLD_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('does not mark suppression for danger-side distance same-symbol and skips switching', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => ({
        ...createWarrantCandidate('OLD_BULL.HK'),
        callPrice: 20_000,
      }),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(
      seatStateManager.resolveSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE'),
    ).toBeNull();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('does not let periodic suppression block safe-side distance presearch on same symbol and day', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    seatStateManager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');

    let findBestCalls = 0;
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 2,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        findBestCalls += 1;
        return {
          ...createWarrantCandidate('OLD_BULL.HK'),
          callPrice: 20_000,
        };
      },
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(findBestCalls).toBe(1);
    expect(seatStateManager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC')).not.toBeNull();
    expect(
      seatStateManager.resolveSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE'),
    ).not.toBeNull();
  });

  it('ignores presearch result when seat changes during candidate lookup', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let resolveCandidate!: (value: ReturnType<typeof createWarrantCandidate> | null) => void;
    const pendingCandidate = new Promise<ReturnType<typeof createWarrantCandidate> | null>(
      (resolve) => {
        resolveCandidate = resolve;
      },
    );
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => await pendingCandidate,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    const switchPromise = runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    const latestSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
    symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
      ...latestSeat,
      symbol: 'MANUAL_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: Date.now(),
    });
    resolveCandidate(createWarrantCandidate('NEW_BULL.HK'));
    await switchPromise;

    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('MANUAL_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('switches to new symbol directly when no position exists', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
      getPendingOrders: async () => [],
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVATING');
    expect(seat.symbol).toBe('NEW_BULL.HK');
    expect(seat.callPrice).toBe(21_000);
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
    expect(executeCalls).toBe(0);
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('returns explicit wakeup requirements across distance switch start and advance', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: Array<{
      action: string | null;
      symbol: string | null;
      quantity: number | null;
    }> = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const signal = signals[0];
        executedActions.push({
          action: signal?.action ?? null,
          symbol: signal?.symbol ?? null,
          quantity: signal?.quantity ?? null,
        });

        if (signal?.action === 'SELLCALL') {
          return { submittedCount: 1, submittedOrderIds: ['SELL-ORDER-1'] };
        }

        return { submittedCount: 1, submittedOrderIds: ['BUY-ORDER-1'] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    const startResult = await machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
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
    expect(startResult).toMatchObject({
      started: true,
      direction: 'LONG',
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'ORDER_EVENT', symbols: ['OLD_BULL.HK'] }, { kind: 'FRESHNESS' }],
      },
    });
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0]).toEqual({
      action: 'SELLCALL',
      symbol: 'OLD_BULL.HK',
      quantity: 100,
    });
    nowMs += 1_000;
    const advanceResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });
    expect(advanceResult).toMatchObject({
      advanced: true,
      direction: 'LONG',
      stillPending: false,
      driveResult: {
        kind: 'COMPLETED',
      },
    });
    expect(executedActions).toHaveLength(2);
    expect(executedActions[1]?.action).toBe('BUYCALL');
    expect(executedActions[1]?.symbol).toBe('NEW_BULL.HK');
    expect(executedActions[1]?.quantity).toBe(200);
    const finalSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(finalSeat.status).toBe('ACTIVATING');
    expect(finalSeat.symbol).toBe('NEW_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('allows SELL_OUT with execution-time price-only quote even when lotSize is missing', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: string[] = [];
    const quoteRequests: string[][] = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const signal = signals[0];
        if (signal?.action) {
          executedActions.push(signal.action);
        }

        return { submittedCount: 1, submittedOrderIds: ['SELL-ORDER-1'] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        const requestedSymbols = [...symbols];
        quoteRequests.push(requestedSymbols);
        return new Map([
          [
            'OLD_BULL.HK',
            {
              symbol: 'OLD_BULL.HK',
              name: 'OLD_BULL.HK',
              price: 1,
              prevClose: 1,
              timestamp: Date.now(),
            },
          ],
        ]);
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient,
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
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

    expect(quoteRequests).toEqual([['OLD_BULL.HK']]);
    expect(executedActions).toContain('SELLCALL');
  });

  it('fails switch flow after WAIT_QUOTE/REBUY execution-time quote retries exhaust without lotSize', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const quoteRequests: string[][] = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const signal = signals[0];
        if (signal?.action === 'SELLCALL') {
          return { submittedCount: 1, submittedOrderIds: ['SELL-ORDER-1'] };
        }

        return { submittedCount: 0, submittedOrderIds: [] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        const requestedSymbols = [...symbols];
        quoteRequests.push(requestedSymbols);
        if (requestedSymbols[0] === 'OLD_BULL.HK') {
          return new Map([
            ['OLD_BULL.HK', createQuotes({ 'OLD_BULL.HK': 1 }).get('OLD_BULL.HK') ?? null],
          ]);
        }

        return new Map([
          [
            'NEW_BULL.HK',
            {
              symbol: 'NEW_BULL.HK',
              name: 'NEW_BULL.HK',
              price: 1,
              prevClose: 1,
              timestamp: Date.now(),
            },
          ],
        ]);
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient,
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
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

    for (let attempts = 0; attempts < 6; attempts += 1) {
      nowMs += 2_000;
      await runDistanceSwitch(machine, {
        direction: 'LONG',
        monitorPrice: 20_000,
        positions: [],
      });
    }

    expect(quoteRequests[0]).toEqual(['OLD_BULL.HK']);
    expect(quoteRequests.slice(1).every((symbols) => symbols[0] === 'NEW_BULL.HK')).toBeTrue();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    const finalSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(finalSeat.status).toBe('EMPTY');
  });

  it('marks seat EMPTY when canceling pending buy orders fails during switch', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const pendingStatus = [...PENDING_ORDER_STATUSES][0];
    if (!pendingStatus) {
      throw new Error('PENDING_ORDER_STATUSES must contain at least one status');
    }

    let executeCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => [
        {
          orderId: 'BUY-PENDING-1',
          symbol: 'OLD_BULL.HK',
          side: OrderSide.Buy,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: pendingStatus,
          orderType: OrderType.ELO,
        },
      ],
      cancelOrder: async () => ({
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
        message: 'simulated cancel failure',
      }),
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    const longSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.symbol).toBeNull();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(executeCalls).toBe(0);
  });

  it('waits for pending buy order to disappear after cancel request is accepted', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const pendingStatus = [...PENDING_ORDER_STATUSES][0];
    if (!pendingStatus) {
      throw new Error('PENDING_ORDER_STATUSES must contain at least one status');
    }

    let pendingOrdersCall = 0;
    let executeCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        pendingOrdersCall += 1;
        if (pendingOrdersCall === 1) {
          return [
            {
              orderId: 'BUY-PENDING-ACCEPTED',
              symbol: 'OLD_BULL.HK',
              side: OrderSide.Buy,
              submittedPrice: 1,
              quantity: 100,
              executedQuantity: 0,
              status: pendingStatus,
              orderType: OrderType.ELO,
            },
          ];
        }

        return [];
      },
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    const startResult = await machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(startResult).toMatchObject({
      started: true,
      direction: 'LONG',
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'ORDER_EVENT', symbols: ['OLD_BULL.HK'] }, { kind: 'FRESHNESS' }],
      },
    });
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('SWITCHING');
    expect(executeCalls).toBe(0);

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');
    expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').symbol).toBe('NEW_BULL.HK');
    expect(executeCalls).toBe(0);
  });

  it('keeps periodic switch pending when canceled buy order is already filled and exposure remains', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: Date.parse('2026-02-16T01:00:00.000Z'),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const pendingStatus = [...PENDING_ORDER_STATUSES][0];
    if (!pendingStatus) {
      throw new Error('PENDING_ORDER_STATUSES must contain at least one status');
    }

    let pendingOrdersCall = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        pendingOrdersCall += 1;
        if (pendingOrdersCall === 1) {
          return [
            {
              orderId: 'BUY-PENDING-FILLED',
              symbol: 'OLD_BULL.HK',
              side: OrderSide.Buy,
              submittedPrice: 1,
              quantity: 100,
              executedQuantity: 0,
              status: pendingStatus,
              orderType: OrderType.ELO,
            },
          ];
        }

        return [];
      },
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'FILLED',
        source: 'API_ERROR',
        relatedBuyOrderIds: null,
      }),
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          {
            orderId: 'BUY-PENDING-FILLED',
            symbol: 'OLD_BULL.HK',
            executedPrice: 1,
            executedQuantity: 100,
            executedTime: nowMs,
            submittedAt: undefined,
            updatedAt: undefined,
          },
        ],
      }),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
      openProtectionActive: false,
    });

    expect(machine.hasPendingSwitch('LONG')).toBeFalse();

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('SWITCHING');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
  });

  it('completes distance switch when filled cancel has no open exposure snapshot yet', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:40:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const pendingStatus = [...PENDING_ORDER_STATUSES][0];
    if (!pendingStatus) {
      throw new Error('PENDING_ORDER_STATUSES must contain at least one status');
    }

    let pendingOrdersCall = 0;
    let executeCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        pendingOrdersCall += 1;
        if (pendingOrdersCall === 1) {
          return [
            {
              orderId: 'BUY-PENDING-FILLED-NO-EXPOSURE',
              symbol: 'OLD_BULL.HK',
              side: OrderSide.Buy,
              submittedPrice: 1,
              quantity: 100,
              executedQuantity: 0,
              status: pendingStatus,
              orderType: OrderType.ELO,
            },
          ];
        }

        return [];
      },
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'FILLED',
        source: 'API_ERROR',
        relatedBuyOrderIds: null,
      }),
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('SWITCHING');

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');
    expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').symbol).toBe('NEW_BULL.HK');
    expect(executeCalls).toBe(0);
  });

  it('promotes unexpected filled pending buy into distance sell-and-rebuy flow', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const pendingStatus = [...PENDING_ORDER_STATUSES][0];
    if (!pendingStatus) {
      throw new Error('PENDING_ORDER_STATUSES must contain at least one status');
    }

    let pendingOrdersCall = 0;
    const executedActions: Array<string | null> = [];
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        pendingOrdersCall += 1;
        if (pendingOrdersCall === 1) {
          return [
            {
              orderId: 'BUY-PENDING-FILLED-DISTANCE',
              symbol: 'OLD_BULL.HK',
              side: OrderSide.Buy,
              submittedPrice: 1,
              quantity: 100,
              executedQuantity: 0,
              status: pendingStatus,
              orderType: OrderType.ELO,
            },
          ];
        }

        return [];
      },
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'FILLED',
        source: 'API_ERROR',
        relatedBuyOrderIds: null,
      }),
      executeSignals: async (signals) => {
        executedActions.push(signals[0]?.action ?? null);
        if (signals[0]?.action === 'SELLCALL') {
          return { submittedCount: 1, submittedOrderIds: ['SELL-ORDER-FILLED-PENDING'] };
        }

        return { submittedCount: 1, submittedOrderIds: ['BUY-ORDER-FILLED-PENDING'] };
      },
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-FILLED-PENDING'
          ? {
              orderId: 'SELL-ORDER-FILLED-PENDING',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: nowMs,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(executedActions).toHaveLength(0);

    nowMs += 1_000;
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
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
    expect(executedActions).toEqual(['SELLCALL']);

    nowMs += 1_000;
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(executedActions).toEqual(['SELLCALL', 'BUYCALL']);
    expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');
    expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').symbol).toBe('NEW_BULL.HK');
  });

  it('stops pending distance switch when seat version changes during SELL_OUT quote fetch', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let executeCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => [],
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: ['SELL-ORDER-SHOULD-NOT-HAPPEN'] };
      },
    });
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        const currentSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
        symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
        symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
          ...currentSeat,
          symbol: 'MANUAL_BULL.HK',
          status: 'ACTIVE',
          lastSwitchAt: nowMs + 1_000,
        });

        return new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1]))));
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient,
    });

    const startResult = await machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
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

    expect(startResult).toMatchObject({
      started: false,
      direction: 'LONG',
      driveResult: {
        kind: 'NOOP',
      },
    });
    expect(executeCalls).toBe(0);
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('MANUAL_BULL.HK');
  });

  it('stops pending distance switch when seat version changes during pending order fetch', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let pendingOrderFetchCount = 0;
    let executeCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        pendingOrderFetchCount += 1;
        if (pendingOrderFetchCount === 1) {
          return [];
        }

        const currentSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
        symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
        symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
          ...currentSeat,
          symbol: 'MANUAL_BULL.HK',
          status: 'ACTIVE',
          lastSwitchAt: nowMs + 1_000,
        });

        return [];
      },
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: ['SELL-ORDER-SHOULD-NOT-HAPPEN'] };
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    const startResult = await machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 0,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
          market: 'HK',
        },
      ],
    });
    expect(startResult).toMatchObject({
      started: true,
      direction: 'LONG',
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'ORDER_EVENT', symbols: ['OLD_BULL.HK'] }, { kind: 'FRESHNESS' }],
      },
    });
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();

    const advanceResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });

    expect(advanceResult).toMatchObject({
      advanced: true,
      direction: 'LONG',
      stillPending: false,
      driveResult: {
        kind: 'NOOP',
      },
    });
    expect(executeCalls).toBe(0);
    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('MANUAL_BULL.HK');
  });

  it('returns quote wakeup requirement when rebuy quote is not ready', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: string[] = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        executedActions.push(signals[0]?.action ?? 'UNKNOWN');
        return { submittedCount: 1, submittedOrderIds: ['SELL-ORDER-1'] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) => {
          const requestedSymbols = [...symbols];
          if (requestedSymbols[0] === 'OLD_BULL.HK') {
            return new Map(createQuotes({ 'OLD_BULL.HK': 1 }));
          }

          return new Map([
            [
              'NEW_BULL.HK',
              {
                symbol: 'NEW_BULL.HK',
                name: 'NEW_BULL.HK',
                price: 1,
                prevClose: 1,
                timestamp: Date.now(),
              },
            ],
          ]);
        },
      }),
    });
    const startResult = await machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
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
    expect(startResult.started).toBeTrue();
    expect(executedActions).toEqual(['SELLCALL']);
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    nowMs += 1_000;
    const advanceResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });
    expect(advanceResult).toMatchObject({
      advanced: true,
      direction: 'LONG',
      stillPending: true,
      driveResult: {
        kind: 'WAIT',
        wakeups: [
          { kind: 'SYMBOL_QUOTE', symbol: 'NEW_BULL.HK' },
          { kind: 'RETRY_TIMER', atMs: nowMs + 2_000 },
        ],
      },
    });
    expect(executedActions).toEqual(['SELLCALL']);
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
  });

  it('keeps pending switch state when rebuy submission is rejected', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: Array<string | null> = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const action = signals[0]?.action ?? null;
        executedActions.push(action);
        if (action === 'SELLCALL') {
          return { submittedCount: 1, submittedOrderIds: ['SELL-ORDER-1'] };
        }

        return { submittedCount: 0, submittedOrderIds: [] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
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
    expect(executedActions).toEqual(['SELLCALL']);
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();

    nowMs += 1_000;
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(executedActions).toEqual(['SELLCALL', 'BUYCALL']);
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('SWITCHING');
    expect(seat.symbol).toBe('NEW_BULL.HK');
  });

  it('propagates rebuy execution error after sell stage succeeds', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: Array<string | null> = [];

    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const action = signals[0]?.action ?? null;
        executedActions.push(action);
        if (action === 'SELLCALL') {
          return { submittedCount: 1, submittedOrderIds: ['SELL-ORDER-REBUY-THROW'] };
        }

        throw new Error('rebuy submit failed');
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-REBUY-THROW'
          ? {
              orderId: 'SELL-ORDER-REBUY-THROW',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
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

    nowMs += 1_000;
    let caught: unknown = null;
    try {
      await runDistanceSwitch(machine, {
        direction: 'LONG',
        monitorPrice: 20_000,
        positions: [],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ message: 'rebuy submit failed' });
    expect(executedActions).toEqual(['SELLCALL', 'BUYCALL']);
  });

  it('fails and clears seat when rebuy sell-notional is unavailable', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: string[] = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        executedActions.push(signals[0]?.action ?? 'UNKNOWN');
        return { submittedCount: 1, submittedOrderIds: ['SELL-ORDER-NOTIONAL-MISS'] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: () => null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
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
    nowMs += 1_000;
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(executedActions).toEqual(['SELLCALL']);
    const longSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.symbol).toBeNull();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('does not trigger distance switch when Decimal distance is slightly above the lower bound', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let findCalls = 0;
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () => ({
          warrantType: 'BULL',
          distanceToStrikePercent: toMockDecimal('0.20000000000000000001'),
        }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        findCalls += 1;
        return createWarrantCandidate('NEW_BULL.HK');
      },
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(findCalls).toBe(0);
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('switches SHORT seat when bear distance is outside the upper bound', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      shortSeat: {
        symbol: 'OLD_BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let executeCalls = 0;
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { submittedCount: 1, submittedOrderIds: [] };
        },
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BEAR',
            distanceToStrikePercent: -0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('SHORT'),
      buildFindBestWarrantInput: async () =>
        createFindBestWarrantInputDouble(createDirectionalAutoSearchPolicy('SHORT')),
      findBestWarrant: async () =>
        createWarrantCandidateWithOverrides('NEW_BEAR.HK', {
          callPrice: 19_500,
          distancePct: -0.3499,
          selectionStage: 'DEGRADED',
          distanceDeltaToThreshold: 0.0001,
        }),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'SHORT',
      monitorPrice: 20_000,
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('HSI.HK', 'SHORT');
    expect(seat.status).toBe('ACTIVATING');
    expect(seat.symbol).toBe('NEW_BEAR.HK');
    expect(seat.callPrice).toBe(19_500);
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'SHORT')).toBe(2);
    expect(executeCalls).toBe(0);
    expect(machine.hasPendingSwitch('SHORT')).toBeFalse();
  });

  it('marks suppression for SHORT safe-side same-symbol and skips switching', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      shortSeat: {
        symbol: 'OLD_BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BEAR',
            distanceToStrikePercent: -2,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('SHORT'),
      buildFindBestWarrantInput: async () =>
        createFindBestWarrantInputDouble(createDirectionalAutoSearchPolicy('SHORT')),
      findBestWarrant: async () => ({
        ...createWarrantCandidate('OLD_BEAR.HK'),
        callPrice: 19_500,
      }),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'SHORT',
      monitorPrice: 20_000,
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('HSI.HK', 'SHORT');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BEAR.HK');
    expect(
      seatStateManager.resolveSuppression('SHORT', 'OLD_BEAR.HK', 'DISTANCE_SAFE_SIDE'),
    ).not.toBeNull();
    expect(machine.hasPendingSwitch('SHORT')).toBeFalse();
  });

  it('does not mark suppression for SHORT danger-side same-symbol and skips switching', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      shortSeat: {
        symbol: 'OLD_BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BEAR',
            distanceToStrikePercent: -0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      buildSeatState: seatStateManager.buildSeatState,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('SHORT'),
      buildFindBestWarrantInput: async () =>
        createFindBestWarrantInputDouble(createDirectionalAutoSearchPolicy('SHORT')),
      findBestWarrant: async () => ({
        ...createWarrantCandidate('OLD_BEAR.HK'),
        callPrice: 19_500,
      }),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'SHORT',
      monitorPrice: 20_000,
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('HSI.HK', 'SHORT');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BEAR.HK');
    expect(
      seatStateManager.resolveSuppression('SHORT', 'OLD_BEAR.HK', 'DISTANCE_SAFE_SIDE'),
    ).toBeNull();
    expect(machine.hasPendingSwitch('SHORT')).toBeFalse();
  });
});
