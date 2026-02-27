/**
 * switchStateMachine 业务测试
 *
 * 功能：
 * - 验证换标状态机相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide } from 'longport';

import { createSwitchStateMachine } from '../../../src/services/autoSymbolManager/switchStateMachine.js';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import {
  createSignalBuilder,
  calculateBuyQuantityByNotional,
  resolveDirectionSymbols,
} from '../../../src/services/autoSymbolManager/signalBuilder.js';
import { resolveAutoSearchThresholds } from '../../../src/services/autoSymbolManager/thresholdResolver.js';
import { signalObjectPool } from '../../../src/utils/objectPool/index.js';
import {
  calculateTradingDurationMsBetween,
  getHKDateKey,
} from '../../../src/utils/helpers/tradingTime.js';
import { PENDING_ORDER_STATUSES } from '../../../src/constants/index.js';

import type { Quote } from '../../../src/types/quote.js';

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

function createTradingCalendarSnapshot() {
  return new Map([
    ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
    ['2026-02-17', { isTradingDay: true, isHalfDay: false }],
  ]);
}

describe('autoSymbolManager switchStateMachine business flow', () => {
  it('marks suppression when presearch returns the same symbol and skips switching', async () => {
    const monitorConfig = createMonitorConfigDouble({
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

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const switchStates = new Map();
    const switchSuppressions = new Map();

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

    const signalBuilder = createSignalBuilder({ signalObjectPool });

    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () => ({ warrantType: 'BULL', distanceToStrikePercent: 0.1 }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: new Map(),
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
        symbol: 'OLD_BULL.HK',
        name: 'OLD_BULL.HK',
        callPrice: 20_000,
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
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
    });

    await machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: createQuotes({ 'OLD_BULL.HK': 1 }),
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('READY');
    expect(seat.symbol).toBe('OLD_BULL.HK');

    const suppression = seatStateManager.resolveSuppression('LONG', 'OLD_BULL.HK');
    expect(suppression?.symbol).toBe('OLD_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('switches to new symbol directly when no position exists', async () => {
    const monitorConfig = createMonitorConfigDouble({
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

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });

    const switchStates = new Map();
    const switchSuppressions = new Map();
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

    const signalBuilder = createSignalBuilder({ signalObjectPool });

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
        getWarrantDistanceInfo: () => ({ warrantType: 'BULL', distanceToStrikePercent: 0.1 }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: new Map(),
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
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
    });

    await machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: createQuotes({ 'OLD_BULL.HK': 1, 'NEW_BULL.HK': 1 }),
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('READY');
    expect(seat.symbol).toBe('NEW_BULL.HK');
    expect(seat.callPrice).toBe(21_000);
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
    expect(executeCalls).toBe(0);
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('executes sell then rebuy in pending-switch flow when position exists', async () => {
    const monitorConfig = createMonitorConfigDouble({
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

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });

    const switchStates = new Map();
    const switchSuppressions = new Map();
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

    const signalBuilder = createSignalBuilder({ signalObjectPool });

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
        getWarrantDistanceInfo: () => ({ warrantType: 'BULL', distanceToStrikePercent: 0.1 }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: new Map(),
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
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
    });

    await machine.maybeSwitchOnDistance({
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

    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0]).toEqual({
      action: 'SELLCALL',
      symbol: 'OLD_BULL.HK',
      quantity: 100,
    });

    nowMs += 1_000;

    await machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: createQuotes({ 'OLD_BULL.HK': 1, 'NEW_BULL.HK': 1 }),
      positions: [],
    });

    expect(executedActions).toHaveLength(2);
    expect(executedActions[1]?.action).toBe('BUYCALL');
    expect(executedActions[1]?.symbol).toBe('NEW_BULL.HK');
    expect(executedActions[1]?.quantity).toBe(200);

    const finalSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(finalSeat.status).toBe('READY');
    expect(finalSeat.symbol).toBe('NEW_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('marks seat EMPTY when canceling pending buy orders fails during switch', async () => {
    const monitorConfig = createMonitorConfigDouble({
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

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });

    const switchStates = new Map();
    const switchSuppressions = new Map();
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
    const signalBuilder = createSignalBuilder({ signalObjectPool });

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
          status: [...PENDING_ORDER_STATUSES][0] as never,
          orderType: 'ELO' as never,
        },
      ],
      cancelOrder: async () => false,
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
        getWarrantDistanceInfo: () => ({ warrantType: 'BULL', distanceToStrikePercent: 0.1 }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: new Map(),
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
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
    });

    await machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: createQuotes({ 'OLD_BULL.HK': 1, 'NEW_BULL.HK': 1 }),
      positions: [],
    });

    const longSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.symbol).toBeNull();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(executeCalls).toBe(0);
  });

  it('keeps pending switch state when rebuy quote is not ready', async () => {
    const monitorConfig = createMonitorConfigDouble({
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

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });

    const switchStates = new Map();
    const switchSuppressions = new Map();
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
    const signalBuilder = createSignalBuilder({ signalObjectPool });

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
        getWarrantDistanceInfo: () => ({ warrantType: 'BULL', distanceToStrikePercent: 0.1 }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: new Map(),
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
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
    });

    await machine.maybeSwitchOnDistance({
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

    expect(executedActions).toEqual(['SELLCALL']);
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();

    nowMs += 1_000;
    await machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: createQuotes({ 'OLD_BULL.HK': 1 }),
      positions: [],
    });

    expect(executedActions).toEqual(['SELLCALL']);
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
  });

  it('fails and clears seat when rebuy sell-notional is unavailable', async () => {
    const monitorConfig = createMonitorConfigDouble({
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

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });

    const switchStates = new Map();
    const switchSuppressions = new Map();
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
    const signalBuilder = createSignalBuilder({ signalObjectPool });

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
        getWarrantDistanceInfo: () => ({ warrantType: 'BULL', distanceToStrikePercent: 0.1 }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: new Map(),
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
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
    });

    await machine.maybeSwitchOnDistance({
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

    nowMs += 1_000;
    await machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: createQuotes({ 'OLD_BULL.HK': 1, 'NEW_BULL.HK': 1 }),
      positions: [],
    });

    expect(executedActions).toEqual(['SELLCALL']);
    const longSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.symbol).toBeNull();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });
});
