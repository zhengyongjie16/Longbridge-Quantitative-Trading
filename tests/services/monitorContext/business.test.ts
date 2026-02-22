/**
 * monitorContext 业务测试
 *
 * 功能：
 * - 验证监控上下文相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createMonitorContext } from '../../../src/services/monitorContext/index.js';
import type { MonitorState } from '../../../src/types/state.js';
import {
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

function createMonitorState(monitorSymbol: string): MonitorState {
  return {
    monitorSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
    lastCandleFingerprint: null,
  };
}

describe('monitorContext business flow', () => {
  it('hydrates ready seats, quote names and default indicator periods into context', () => {
    const config = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      signalConfig: {
        buycall: null,
        sellcall: null,
        buyput: null,
        sellput: null,
      },
      verificationConfig: {
        buy: { delaySeconds: 60, indicators: ['K'] },
        sell: { delaySeconds: 60, indicators: ['K'] },
      },
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'LONG_READY.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'SHORT_READY.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 3,
      shortVersion: 4,
    });

    const longQuote = {
      ...createQuoteDouble('LONG_READY.HK', 1.01),
      name: 'LongReady',
    };
    const shortQuote = {
      ...createQuoteDouble('SHORT_READY.HK', 1.02),
      name: 'ShortReady',
    };
    const monitorQuote = {
      ...createQuoteDouble('HSI.HK', 20_001),
      name: 'HangSeng',
    };

    const context = createMonitorContext({
      config,
      state: createMonitorState(config.monitorSymbol),
      symbolRegistry,
      quotesMap: new Map([
        ['LONG_READY.HK', longQuote],
        ['SHORT_READY.HK', shortQuote],
        ['HSI.HK', monitorQuote],
      ]),
      strategy: {} as never,
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      riskChecker: createRiskCheckerDouble(),
      unrealizedLossMonitor: {} as never,
      delayedSignalVerifier: {} as never,
      autoSymbolManager: {} as never,
    });

    expect(context.longSymbolName).toBe('LongReady');
    expect(context.shortSymbolName).toBe('ShortReady');
    expect(context.monitorSymbolName).toBe('HangSeng');
    expect(context.seatVersion.long).toBe(3);
    expect(context.seatVersion.short).toBe(4);
    expect(context.emaPeriods).toEqual([7]);
    expect(context.rsiPeriods).toEqual([6]);
    expect(context.psyPeriods).toEqual([13]);
  });

  it('keeps quote/name empty when seat is not READY', () => {
    const config = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
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
        symbol: 'SHORT_READY.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const context = createMonitorContext({
      config,
      state: createMonitorState(config.monitorSymbol),
      symbolRegistry,
      quotesMap: new Map([
        ['SHORT_READY.HK', { ...createQuoteDouble('SHORT_READY.HK', 1.02), name: 'ShortReady' }],
        ['HSI.HK', { ...createQuoteDouble('HSI.HK', 20_001), name: 'HangSeng' }],
      ]),
      strategy: {} as never,
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      riskChecker: createRiskCheckerDouble(),
      unrealizedLossMonitor: {} as never,
      delayedSignalVerifier: {} as never,
      autoSymbolManager: {} as never,
    });

    expect(context.longQuote).toBeNull();
    expect(context.longSymbolName).toBe('');
    expect(context.shortSymbolName).toBe('ShortReady');
  });
});
