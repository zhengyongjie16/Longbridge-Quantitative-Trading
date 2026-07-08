import { describe, expect, it } from 'bun:test';
import {
  collectBoundSeatSymbols,
  resolveBoundSeatSymbol,
} from '../../../src/utils/seat/symbols.js';
import {
  createMonitorConfigDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

describe('seat symbol helpers', () => {
  it('returns symbol only when seat has a bound symbol', () => {
    const registry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
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
    });

    expect(resolveBoundSeatSymbol(registry, 'HSI.HK', 'LONG')).toBe('BULL.HK');
    expect(resolveBoundSeatSymbol(registry, 'HSI.HK', 'SHORT')).toBeNull();
  });

  it('collects only currently bound seat symbols', () => {
    const registry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVATING',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const monitors = [createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' })];

    expect(collectBoundSeatSymbols({ monitors, symbolRegistry: registry })).toEqual([
      { monitorSymbol: 'HSI.HK', direction: 'LONG', symbol: 'BULL.HK' },
      { monitorSymbol: 'HSI.HK', direction: 'SHORT', symbol: 'BEAR.HK' },
    ]);
  });
});
