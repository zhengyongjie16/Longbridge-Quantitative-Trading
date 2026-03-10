import { describe, expect, it } from 'bun:test';

import {
  describeSignalSeatValidationFailure,
  validateSignalSeat,
} from '../../../src/services/autoSymbolManager/utils.js';
import { createSignalDouble, createSymbolRegistryDouble } from '../../helpers/testDoubles.js';

describe('autoSymbolManager utils business flow', () => {
  it('accepts signal when current seat version and symbol both match', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 2,
    });
    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal.seatVersion = 2;

    const result = validateSignalSeat({
      monitorSymbol: 'HSI.HK',
      signal,
      symbolRegistry,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.direction).toBe('LONG');
      expect(result.seatState.symbol).toBe('BULL.HK');
    }
  });

  it('reports seat-unavailable reason when seat is not ready', () => {
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
    });
    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal.seatVersion = 1;

    const result = validateSignalSeat({
      monitorSymbol: 'HSI.HK',
      signal,
      symbolRegistry,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('SEAT_UNAVAILABLE');
      expect(describeSignalSeatValidationFailure(result)).toBe('席位为空');
    }
  });

  it('reports version mismatch before symbol mismatch', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      shortSeat: {
        symbol: 'BEAR_NEW.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortVersion: 5,
    });
    const signal = createSignalDouble('BUYPUT', 'BEAR_OLD.HK');
    signal.seatVersion = 4;

    const versionMismatch = validateSignalSeat({
      monitorSymbol: 'HSI.HK',
      signal,
      symbolRegistry,
    });

    expect(versionMismatch.valid).toBe(false);
    if (!versionMismatch.valid) {
      expect(versionMismatch.reason).toBe('SEAT_VERSION_MISMATCH');
      expect(describeSignalSeatValidationFailure(versionMismatch)).toBe('席位版本不匹配');
    }

    signal.seatVersion = 5;
    const symbolMismatch = validateSignalSeat({
      monitorSymbol: 'HSI.HK',
      signal,
      symbolRegistry,
    });

    expect(symbolMismatch.valid).toBe(false);
    if (!symbolMismatch.valid) {
      expect(symbolMismatch.reason).toBe('SEAT_SYMBOL_MISMATCH');
      expect(describeSignalSeatValidationFailure(symbolMismatch)).toBe('标的已切换');
    }
  });
});
