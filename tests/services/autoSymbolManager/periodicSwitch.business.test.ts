/**
 * periodicSwitch 业务回归测试
 *
 * 功能：
 * - 按方案文档验证周期换标新增能力与关键边界行为。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderType } from 'longbridge';

import { createSwitchStateMachine } from '../../../src/services/autoSymbolManager/switchStateMachine.js';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import {
  calculateBuyQuantityByNotional,
  createSignalBuilder,
  resolveDirectionSymbols,
} from '../../../src/services/autoSymbolManager/signalBuilder.js';
import { calculateTradingDurationMsBetween, getHKDateKey } from '../../../src/utils/time/index.js';
import { PENDING_ORDER_STATUSES } from '../../../src/constants/index.js';
import type { Logger } from '../../../src/utils/logger/types.js';
import type { PeriodicSwitchPendingState } from '../../../src/types/monitorContextPorts.js';
import type {
  SwitchState,
  SwitchStateMachine,
  SwitchSuppression,
} from '../../../src/services/autoSymbolManager/types.js';
import {
  createWarrantDistanceInfoDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import {
  createDirectionalAutoSearchPolicy,
  createFindBestWarrantInputDouble,
  createLoggerStub,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from './utils.js';

function createTradingCalendarSnapshot() {
  return new Map([
    ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
    ['2026-02-17', { isTradingDay: true, isHalfDay: false }],
  ]);
}
type HarnessParams = {
  readonly switchIntervalMinutes: number;
  readonly nowMs: number;
  readonly lastSeatActivatedAt: number | null;
  readonly findBestSymbol: string | null;
  readonly distanceToStrikePercent?: number;
  readonly tradingCalendarSnapshot?: ReadonlyMap<
    string,
    { readonly isTradingDay: boolean; readonly isHalfDay: boolean }
  >;
  readonly getBuyOrdersCount?: () => number;
  readonly getOrderHoldSymbols?: () => ReadonlySet<string>;
  readonly findBestWarrantHook?: () => void;
  readonly executeSignalsHook?: () => void;
  readonly logger?: Logger;
};
function createPeriodicHarness(params: HarnessParams): {
  machine: SwitchStateMachine;
  symbolRegistry: ReturnType<typeof createSymbolRegistryDouble>;
  seatStateManager: ReturnType<typeof createSeatStateManager>;
  periodicSwitchPending: Map<'LONG' | 'SHORT', PeriodicSwitchPendingState>;
  setNowMs: (nextNowMs: number) => void;
} {
  let currentNowMs = params.nowMs;
  const testLogger = params.logger ?? createLoggerStub();
  const monitorConfig = createMonitorConfigDouble({
    autoSearchConfig: {
      ...getDefaultAutoSearchConfig(),
      switchIntervalMinutes: params.switchIntervalMinutes,
    },
  });
  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: 'HSI.HK',
    longSeat: {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: params.lastSeatActivatedAt,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longVersion: 1,
  });
  const switchStates = new Map<'LONG' | 'SHORT', SwitchState>();
  const switchSuppressions = new Map<'LONG' | 'SHORT', SwitchSuppression>();
  const periodicSwitchPending = new Map<'LONG' | 'SHORT', PeriodicSwitchPendingState>();
  const seatStateManager = createSeatStateManager({
    monitorSymbol: 'HSI.HK',
    symbolRegistry,
    switchStates,
    switchSuppressions,
    now: () => new Date(currentNowMs),
    logger: testLogger,
    getHKDateKey,
  });
  const signalBuilder = createSignalBuilder();
  const trader = createTraderDouble({
    executeSignals: async () => {
      params.executeSignalsHook?.();
      return { submittedCount: 1, submittedOrderIds: [] };
    },
    getPendingOrders: async () => [],
    getOrderHoldSymbols: () => params.getOrderHoldSymbols?.() ?? new Set<string>(),
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
    monitorSymbol: 'HSI.HK',
    symbolRegistry,
    trader,
    orderRecorder,
    riskChecker: createRiskCheckerDouble({
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceToStrikePercent: params.distanceToStrikePercent ?? 0.1,
        }),
    }),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async (symbols) =>
        new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1, 100)])),
    }),
    now: () => new Date(currentNowMs),
    switchStates,
    periodicSwitchPending,
    resolveSuppression: seatStateManager.resolveSuppression,
    markSuppression: seatStateManager.markSuppression,
    enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
    buildSeatState: seatStateManager.buildSeatState,
    updateSeatState: seatStateManager.updateSeatState,
    resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
    buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
    findBestWarrant: async () => {
      params.findBestWarrantHook?.();
      if (params.findBestSymbol === null) {
        return null;
      }

      return createWarrantCandidate(params.findBestSymbol);
    },
    resolveDirectionSymbols,
    calculateBuyQuantityByNotional,
    buildOrderSignal: signalBuilder.buildOrderSignal,
    pendingOrderStatuses: PENDING_ORDER_STATUSES,
    buySide: OrderSide.Buy,
    logger: testLogger,
    maxSearchFailuresPerDay: 3,
    getHKDateKey,
    calculateTradingDurationMsBetween,
    getTradingCalendarSnapshot: () =>
      params.tradingCalendarSnapshot ?? createTradingCalendarSnapshot(),
  });
  return {
    machine,
    symbolRegistry,
    seatStateManager,
    periodicSwitchPending,
    setNowMs: (nextNowMs: number) => {
      currentNowMs = nextNowMs;
    },
  };
}

async function runDistanceSwitch(
  machine: SwitchStateMachine,
  params: Parameters<SwitchStateMachine['startSwitchOnDistance']>[0],
): Promise<void> {
  if (machine.hasPendingSwitch(params.direction)) {
    await machine.advancePendingSwitch(params);
    return;
  }

  await machine.startSwitchOnDistance(params);
}

describe('periodic auto-switch regression', () => {
  it('case1: switchIntervalMinutes=0 does not trigger periodic switch', async () => {
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 0,
      nowMs,
      lastSeatActivatedAt: nowMs - 60 * 60 * 1000,
      findBestSymbol: 'NEW_BULL.HK',
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('case2: periodic trigger starts switch when no buy orders', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z'); // 09:00 HK
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z'); // 09:31 HK
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVATING');
    expect(seat.symbol).toBe('NEW_BULL.HK');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('case2-3: periodic trigger ignores opening protection when trading session gate is open', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
    });

    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });

    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVATING');
    expect(seat.symbol).toBe('NEW_BULL.HK');
  });

  it('case2-1: periodic trigger with no candidate should close at entry without entering SWITCHING', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: null,
    });
    harness.periodicSwitchPending.set('LONG', {
      pending: true,
      pendingSinceMs: nowMs - 5000,
      blockedBy: 'ORDER_RECORDER',
    });
    const previousVersion = harness.symbolRegistry.getSeatVersion('HSI.HK', 'LONG');

    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });

    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    const currentVersion = harness.symbolRegistry.getSeatVersion('HSI.HK', 'LONG');
    expect(seat.status).not.toBe('SWITCHING');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(seat.status).toBe('EMPTY');
    expect(seat.symbol).toBeNull();
    expect(seat.searchFailCountToday).toBe(1);
    expect(currentVersion).toBe(previousVersion + 1);
    expect(seat.lastSwitchAt).toBe(nowMs);
    expect(seat.lastSearchAt).toBe(nowMs);
    expect(harness.periodicSwitchPending.has('LONG')).toBeFalse();
  });

  it('case2-2: periodic no-candidate freezes seat when fail count reaches limit', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: null,
    });
    harness.symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
      ...harness.symbolRegistry.getSeatState('HSI.HK', 'LONG'),
      searchFailCountToday: 2,
      frozenTradingDayKey: null,
    });

    harness.periodicSwitchPending.set('LONG', {
      pending: true,
      pendingSinceMs: nowMs - 5000,
      blockedBy: 'ORDER_RECORDER',
    });

    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });

    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('EMPTY');
    expect(seat.symbol).toBeNull();
    expect(seat.searchFailCountToday).toBe(3);
    expect(seat.frozenTradingDayKey).toBe('2026-02-16');
    expect(seat.lastSwitchAt).toBe(nowMs);
    expect(seat.lastSearchAt).toBe(nowMs);
    expect(harness.periodicSwitchPending.has('LONG')).toBeFalse();
  });

  it('case3: periodic trigger enters pending on position and switches after cleared', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    let buyOrdersCount = 1;
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      getBuyOrdersCount: () => buyOrdersCount,
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
    buyOrdersCount = 0;
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs + 1000),
      canTradeNow: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('case3-1: periodic trigger enters pending when local pending order exists without buy orders', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      getOrderHoldSymbols: () => new Set(['OLD_BULL.HK']),
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(harness.periodicSwitchPending.get('LONG')?.pending).toBeTrue();
  });

  it('case3-2: periodic trigger keeps pending when block source changes from order recorder to local pending order', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    let buyOrdersCount = 1;
    let holdSymbols = new Set<string>();
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      getBuyOrdersCount: () => buyOrdersCount,
      getOrderHoldSymbols: () => holdSymbols,
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    expect(harness.periodicSwitchPending.get('LONG')?.pending).toBeTrue();
    buyOrdersCount = 0;
    holdSymbols = new Set(['OLD_BULL.HK']);
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs + 1000),
      canTradeNow: true,
    });
    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(harness.periodicSwitchPending.get('LONG')?.pending).toBeTrue();
  });

  it('case3-3: periodic trigger keeps waiting during sell exit when order recorder is empty but local pending sell remains', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      getBuyOrdersCount: () => 0,
      getOrderHoldSymbols: () => new Set(['OLD_BULL.HK']),
    });
    harness.periodicSwitchPending.set('LONG', {
      pending: true,
      pendingSinceMs: nowMs - 5000,
      blockedBy: 'ORDER_RECORDER',
    });

    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(harness.periodicSwitchPending.get('LONG')?.pending).toBeTrue();
  });

  it('case3-4: periodic trigger starts switch only after local pending order is cleared', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    let holdSymbols = new Set(['OLD_BULL.HK']);
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      getOrderHoldSymbols: () => holdSymbols,
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    expect(harness.periodicSwitchPending.get('LONG')?.blockedBy).toBe('LOCAL_PENDING_ORDER');

    holdSymbols = new Set<string>();
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs + 1000),
      canTradeNow: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('case3-5: periodic pending logs when block source changes from order recorder to local pending order', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    let buyOrdersCount = 1;
    let holdSymbols = new Set<string>();
    const warnMessages: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => {
        warnMessages.push(msg);
      },
      error: () => {},
    };
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      getBuyOrdersCount: () => buyOrdersCount,
      getOrderHoldSymbols: () => holdSymbols,
      logger,
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    buyOrdersCount = 0;
    holdSymbols = new Set(['OLD_BULL.HK']);
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs + 1000),
      canTradeNow: true,
    });
    expect(harness.periodicSwitchPending.get('LONG')?.blockedBy).toBe('LOCAL_PENDING_ORDER');
    expect(
      warnMessages.some((message) => message.includes('blockedBy=LOCAL_PENDING_ORDER')),
    ).toBeTrue();
  });

  it('case3-6: periodic switch rechecks local pending before enterSwitchingSeat after async candidate lookup', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    let holdSymbols = new Set<string>();
    let findBestWarrantCallCount = 0;
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      getOrderHoldSymbols: () => holdSymbols,
      findBestWarrantHook: () => {
        findBestWarrantCallCount += 1;
        if (findBestWarrantCallCount === 1) {
          holdSymbols = new Set(['OLD_BULL.HK']);
        }
      },
    });

    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });

    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(harness.periodicSwitchPending.get('LONG')?.pending).toBeTrue();
    expect(harness.periodicSwitchPending.get('LONG')?.blockedBy).toBe('LOCAL_PENDING_ORDER');
  });

  it('case4: distance switch takes priority while periodic pending', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      getBuyOrdersCount: () => 1,
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    await runDistanceSwitch(harness.machine, {
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
    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('SWITCHING');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(harness.periodicSwitchPending.has('LONG')).toBeFalse();
    expect(harness.machine.hasPendingSwitch('LONG')).toBeTrue();
  });

  it('case4-1-safe-side: periodic pending is retained and safe suppression is written on distance same-symbol', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'OLD_BULL.HK',
      getBuyOrdersCount: () => 1,
      distanceToStrikePercent: 2,
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    expect(harness.periodicSwitchPending.get('LONG')?.pending).toBeTrue();
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');

    await runDistanceSwitch(harness.machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    expect(harness.periodicSwitchPending.get('LONG')?.pending).toBeTrue();
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(
      harness.seatStateManager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC'),
    ).toBeNull();

    expect(
      harness.seatStateManager.resolveSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE'),
    ).not.toBeNull();
  });

  it('case4-1-danger-side: periodic pending is retained and suppression is not written on distance same-symbol', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'OLD_BULL.HK',
      getBuyOrdersCount: () => 1,
      distanceToStrikePercent: 0.1,
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    expect(harness.periodicSwitchPending.get('LONG')?.pending).toBeTrue();
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');

    await runDistanceSwitch(harness.machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    expect(harness.periodicSwitchPending.get('LONG')?.pending).toBeTrue();
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(
      harness.seatStateManager.resolveSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE'),
    ).toBeNull();
  });

  it('case5: same candidate marks suppression and skips periodic switch', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'OLD_BULL.HK',
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    const suppression = harness.seatStateManager.resolveSuppression(
      'LONG',
      'OLD_BULL.HK',
      'PERIODIC',
    );
    expect(suppression?.symbol).toBe('OLD_BULL.HK');
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('case6: no trigger in non-trading session, triggers after session resumes', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: false,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs + 1000),
      canTradeNow: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');
  });

  it('case7: trading-minute timer pauses at lunch break', async () => {
    const readyMs = Date.parse('2026-02-16T03:59:00.000Z'); // 11:59 HK
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 2,
      nowMs: Date.parse('2026-02-16T04:30:00.000Z'), // 12:30 HK
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(Date.parse('2026-02-16T04:30:00.000Z')), // 午休
      canTradeNow: false,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(Date.parse('2026-02-16T05:00:00.000Z')), // 13:00 HK
      canTradeNow: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(Date.parse('2026-02-16T05:01:00.000Z')), // 13:01 HK
      canTradeNow: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');
  });

  it('case8: cross-day trigger uses accumulated trading minutes instead of wall-clock', async () => {
    const readyMs = Date.parse('2026-02-16T07:59:00.000Z'); // Day1 15:59 HK
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 2,
      nowMs: Date.parse('2026-02-17T01:30:00.000Z'), // Day2 09:30 HK
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      tradingCalendarSnapshot: new Map([
        ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
        ['2026-02-17', { isTradingDay: true, isHalfDay: false }],
      ]),
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(Date.parse('2026-02-17T01:30:00.000Z')),
      canTradeNow: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVE');
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(Date.parse('2026-02-17T01:31:00.000Z')),
      canTradeNow: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');
  });

  it('case9: periodic switch starts when trading session gate is open', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    expect(harness.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');
  });

  it('case10: periodic switch never submits sell/rebuy orders', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    let executeCalls = 0;
    const harness = createPeriodicHarness({
      switchIntervalMinutes: 1,
      nowMs,
      lastSeatActivatedAt: readyMs,
      findBestSymbol: 'NEW_BULL.HK',
      executeSignalsHook: () => {
        executeCalls += 1;
      },
    });
    await harness.machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    const seat = harness.symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('ACTIVATING');
    expect(seat.symbol).toBe('NEW_BULL.HK');
    expect(executeCalls).toBe(0);
    expect(harness.machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('case11: periodic switch cancel stage only cancels pending buy orders', async () => {
    const readyMs = Date.parse('2026-02-16T01:00:00.000Z');
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const canceledOrderIds: string[] = [];
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
        lastSeatActivatedAt: readyMs,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = new Map<'LONG' | 'SHORT', SwitchState>();
    const switchSuppressions = new Map<'LONG' | 'SHORT', SwitchSuppression>();
    const periodicSwitchPending = new Map<'LONG' | 'SHORT', PeriodicSwitchPendingState>();
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
          orderType: OrderType.ELO,
        },
        {
          orderId: 'SELL-1',
          symbol: 'OLD_BULL.HK',
          side: OrderSide.Sell,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: pendingStatus,
          orderType: OrderType.ELO,
        },
      ],
      cancelOrder: async (orderId: string) => {
        canceledOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED' as const,
          closedReason: 'CANCELED' as const,
          source: 'API' as const,
          relatedBuyOrderIds: null,
        };
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [],
      }),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols: Iterable<string>) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1, 100)])),
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
    });
    await machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canTradeNow: true,
    });
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(canceledOrderIds).toEqual(['BUY-1']);
  });
});
