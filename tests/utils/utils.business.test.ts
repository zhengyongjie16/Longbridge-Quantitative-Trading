import { describe, expect, it } from 'bun:test';

import {
  resolveMonitorContextRuntimeSnapshot,
  resolveMonitorContextSeatSnapshot,
} from '../../src/utils/utils.js';
import { createQuoteDouble, createSymbolRegistryDouble } from '../helpers/testDoubles.js';

describe('shared utils business flow', () => {
  it('resolves monitor runtime snapshot from ready seats and quotes', () => {
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

    const snapshot = resolveMonitorContextRuntimeSnapshot(
      'HSI.HK',
      symbolRegistry,
      new Map([
        ['LONG_READY.HK', { ...createQuoteDouble('LONG_READY.HK', 1.1), name: 'LongReady' }],
        ['SHORT_READY.HK', { ...createQuoteDouble('SHORT_READY.HK', 0.9), name: 'ShortReady' }],
        ['HSI.HK', { ...createQuoteDouble('HSI.HK', 20_100), name: 'HangSeng' }],
      ]),
    );

    expect(snapshot.seatVersion).toEqual({ long: 3, short: 4 });
    expect(snapshot.longSymbol).toBe('LONG_READY.HK');
    expect(snapshot.shortSymbol).toBe('SHORT_READY.HK');
    expect(snapshot.longSymbolName).toBe('LongReady');
    expect(snapshot.shortSymbolName).toBe('ShortReady');
    expect(snapshot.monitorSymbolName).toBe('HangSeng');
  });

  it('returns empty seat symbols when seats are not ready', () => {
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

    const seatSnapshot = resolveMonitorContextSeatSnapshot('HSI.HK', symbolRegistry);
    const runtimeSnapshot = resolveMonitorContextRuntimeSnapshot(
      'HSI.HK',
      symbolRegistry,
      new Map([
        ['SHORT_READY.HK', { ...createQuoteDouble('SHORT_READY.HK', 0.9), name: 'ShortReady' }],
      ]),
    );

    expect(seatSnapshot.longSymbol).toBeNull();
    expect(runtimeSnapshot.longQuote).toBeNull();
    expect(runtimeSnapshot.longSymbolName).toBe('');
    expect(runtimeSnapshot.shortSymbolName).toBe('ShortReady');
    expect(runtimeSnapshot.monitorSymbolName).toBe('HSI.HK');
  });
});
