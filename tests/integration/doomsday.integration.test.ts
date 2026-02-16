import { describe, expect, it } from 'bun:test';
import { OrderSide } from 'longport';

import { createDoomsdayProtection } from '../../src/core/doomsdayProtection/index.js';

import type { LastState, MonitorContext } from '../../src/types/state.js';

import {
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

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
    cachedAccount: createAccountSnapshotDouble(100_000),
    cachedPositions: [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
      createPositionDouble({ symbol: 'BEAR.HK', quantity: 300, availableQuantity: 300 }),
    ],
    positionCache: createPositionCacheDouble([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
      createPositionDouble({ symbol: 'BEAR.HK', quantity: 300, availableQuantity: 300 }),
    ]),
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(['BULL.HK', 'BEAR.HK']),
  };
}

function createMonitorContext(
  config = createMonitorConfigDouble(),
  orderRecorder = createOrderRecorderDouble(),
): MonitorContext {
  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: config.monitorSymbol,
    longSeat: {
      symbol: 'BULL.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });

  return {
    config,
    state: {
      monitorSymbol: config.monitorSymbol,
      monitorPrice: null,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingDelayedSignals: [],
      monitorValues: null,
      lastMonitorSnapshot: null,
      lastCandleFingerprint: null,
    },
    symbolRegistry,
    seatState: {
      long: symbolRegistry.getSeatState(config.monitorSymbol, 'LONG'),
      short: symbolRegistry.getSeatState(config.monitorSymbol, 'SHORT'),
    },
    seatVersion: {
      long: symbolRegistry.getSeatVersion(config.monitorSymbol, 'LONG'),
      short: symbolRegistry.getSeatVersion(config.monitorSymbol, 'SHORT'),
    },
    autoSymbolManager: {
      maybeSearchOnTick: async () => {},
      maybeSwitchOnDistance: async () => {},
      hasPendingSwitch: () => false,
      resetAllState: () => {},
    },
    strategy: {
      generateCloseSignals: () => ({ immediateSignals: [], delayedSignals: [] }),
    },
    orderRecorder,
    dailyLossTracker: {
      resetAll: () => {},
      recalculateFromAllOrders: () => {},
      recordFilledOrder: () => {},
      getLossOffset: () => 0,
    },
    riskChecker: {
      setWarrantInfoFromCallPrice: () => ({ status: 'ok', isWarrant: true }),
      refreshWarrantInfoForSymbol: async () => ({ status: 'ok', isWarrant: true }),
      checkBeforeOrder: () => ({ allowed: true }),
      checkWarrantRisk: () => ({ allowed: true }),
      checkWarrantDistanceLiquidation: () => ({ shouldLiquidate: false }),
      getWarrantDistanceInfo: () => null,
      clearLongWarrantInfo: () => {},
      clearShortWarrantInfo: () => {},
      refreshUnrealizedLossData: async () => null,
      checkUnrealizedLoss: () => ({ shouldLiquidate: false }),
      clearUnrealizedLossData: () => {},
    },
    unrealizedLossMonitor: {
      monitorUnrealizedLoss: async () => {},
    },
    delayedSignalVerifier: {
      addSignal: () => {},
      cancelAllForSymbol: () => {},
      cancelAllForDirection: () => 0,
      cancelAll: () => 0,
      getPendingCount: () => 0,
      onVerified: () => {},
      onRejected: () => {},
      destroy: () => {},
    },
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    monitorSymbolName: config.monitorSymbol,
    normalizedMonitorSymbol: config.monitorSymbol,
    rsiPeriods: [6],
    emaPeriods: [7],
    psyPeriods: [13],
    longQuote: createQuoteDouble('BULL.HK', 1.1, 100),
    shortQuote: createQuoteDouble('BEAR.HK', 0.9, 100),
    monitorQuote: createQuoteDouble(config.monitorSymbol, 20_000),
  } as unknown as MonitorContext;
}

describe('doomsday integration', () => {
  it('cancels pending buy orders once per trading day within close-15 window', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble();

    const trader = createTraderDouble({
      getPendingOrders: async () => [
        {
          orderId: 'B-1',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: 'New' as never,
          orderType: 'ELO' as never,
        },
        {
          orderId: 'S-1',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: 'New' as never,
          orderType: 'ELO' as never,
        },
      ],
      cancelOrder: async () => true,
    });

    const result1 = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:50:00.000Z'),
      isHalfDay: false,
      monitorConfigs: [monitorConfig],
      monitorContexts: new Map([[monitorConfig.monitorSymbol, createMonitorContext(monitorConfig)]]),
      trader,
    });

    const result2 = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:51:00.000Z'),
      isHalfDay: false,
      monitorConfigs: [monitorConfig],
      monitorContexts: new Map([[monitorConfig.monitorSymbol, createMonitorContext(monitorConfig)]]),
      trader,
    });

    expect(result1.executed).toBeTrue();
    expect(result1.cancelledCount).toBe(1);
    expect(result2.executed).toBeFalse();

    expect(trader.getPendingOrders).toBeDefined();
  });

  it('executes close-5 liquidation, clears caches and order records for both sides', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble();

    let executedSignals = 0;
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        executedSignals = signals.length;
        return { submittedCount: signals.length };
      },
    });

    let clearLongCalls = 0;
    let clearShortCalls = 0;
    const orderRecorder = createOrderRecorderDouble({
      clearBuyOrders: (_symbol, isLongSymbol) => {
        if (isLongSymbol) {
          clearLongCalls += 1;
        } else {
          clearShortCalls += 1;
        }
      },
    });

    const monitorContext = createMonitorContext(monitorConfig, orderRecorder);

    const lastState = createLastState();

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      positions: lastState.cachedPositions,
      monitorConfigs: [monitorConfig],
      monitorContexts: new Map([[monitorConfig.monitorSymbol, monitorContext]]),
      trader,
      marketDataClient: {
        _getContext: async () => ({}) as never,
        getQuotes: async () => new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
        ]),
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => [],
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
        resetRuntimeSubscriptionsAndCaches: async () => {},
      },
      lastState,
    });

    expect(result.executed).toBeTrue();
    expect(result.signalCount).toBe(2);
    expect(executedSignals).toBe(2);

    expect(clearLongCalls).toBe(1);
    expect(clearShortCalls).toBe(1);

    expect(lastState.cachedAccount).toBeNull();
    expect(lastState.cachedPositions).toHaveLength(0);
    expect(lastState.positionCache.get('BULL.HK')).toBeNull();
  });
});
