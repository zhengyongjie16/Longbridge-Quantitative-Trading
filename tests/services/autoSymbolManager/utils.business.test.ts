import { describe, expect, it } from 'bun:test';

import {
  createSymbolRegistry,
  describeSignalSeatValidationFailure,
  validateSignalSeat,
} from '../../../src/services/autoSymbolManager/utils.js';
import { logger } from '../../../src/utils/logger/index.js';
import type { Logger } from '../../../src/utils/logger/types.js';
import {
  createMonitorConfigDouble,
  createSignalDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

describe('autoSymbolManager utils business flow', () => {
  it('atomically updates seat state and version before publishing events', () => {
    const symbolRegistry = createSymbolRegistry([
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    ]);
    const observed: Array<{
      readonly eventKind: 'version' | 'state' | 'truth';
      readonly status: string;
      readonly version: number;
    }> = [];
    symbolRegistry.onSeatVersionChanged(() => {
      observed.push({
        eventKind: 'version',
        status: symbolRegistry.getSeatState('HSI.HK', 'LONG').status,
        version: symbolRegistry.getSeatVersion('HSI.HK', 'LONG'),
      });
    });

    symbolRegistry.onSeatStateChanged(() => {
      observed.push({
        eventKind: 'state',
        status: symbolRegistry.getSeatState('HSI.HK', 'LONG').status,
        version: symbolRegistry.getSeatVersion('HSI.HK', 'LONG'),
      });
    });

    symbolRegistry.onSeatTruthChanged(() => {
      observed.push({
        eventKind: 'truth',
        status: symbolRegistry.getSeatState('HSI.HK', 'LONG').status,
        version: symbolRegistry.getSeatVersion('HSI.HK', 'LONG'),
      });
    });

    const result = symbolRegistry.updateSeatStateWithVersionBump('HSI.HK', 'LONG', {
      symbol: 'NEW_BULL.HK',
      status: 'ACTIVATING',
      lastSwitchAt: 100,
      lastSearchAt: 100,
      lastSeatActivatedAt: null,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    expect(result.seatVersion).toBe(2);
    expect(result.seatState.status).toBe('ACTIVATING');
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
    expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').symbol).toBe('NEW_BULL.HK');
    expect(observed).toEqual([
      { eventKind: 'version', status: 'ACTIVATING', version: 2 },
      { eventKind: 'state', status: 'ACTIVATING', version: 2 },
      { eventKind: 'truth', status: 'ACTIVATING', version: 2 },
    ]);
  });

  it('updates seat state without bumping version or publishing version events', () => {
    const symbolRegistry = createSymbolRegistry([
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    ]);
    const stateEvents: Array<{
      readonly previousVersion: number;
      readonly nextVersion: number;
      readonly observedVersion: number;
      readonly status: string;
    }> = [];
    const versionEvents: Array<unknown> = [];
    const truthEvents: Array<{
      readonly monitorSymbol: string;
      readonly direction: 'LONG' | 'SHORT';
      readonly observedVersion: number;
      readonly status: string;
    }> = [];
    symbolRegistry.onSeatStateChanged((event) => {
      stateEvents.push({
        previousVersion: event.previousVersion,
        nextVersion: event.nextVersion,
        observedVersion: symbolRegistry.getSeatVersion('HSI.HK', 'LONG'),
        status: symbolRegistry.getSeatState('HSI.HK', 'LONG').status,
      });
    });

    symbolRegistry.onSeatVersionChanged((event) => {
      versionEvents.push(event);
    });

    symbolRegistry.onSeatTruthChanged((event) => {
      truthEvents.push({
        monitorSymbol: event.monitorSymbol,
        direction: event.direction,
        observedVersion: symbolRegistry.getSeatVersion('HSI.HK', 'LONG'),
        status: symbolRegistry.getSeatState('HSI.HK', 'LONG').status,
      });
    });

    const nextState = symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVATING',
      lastSwitchAt: 100,
      lastSearchAt: 100,
      lastSeatActivatedAt: null,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    expect(nextState.status).toBe('ACTIVATING');
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(1);
    expect(stateEvents).toEqual([
      {
        previousVersion: 1,
        nextVersion: 1,
        observedVersion: 1,
        status: 'ACTIVATING',
      },
    ]);
    expect(versionEvents).toEqual([]);
    expect(truthEvents).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        observedVersion: 1,
        status: 'ACTIVATING',
      },
    ]);
  });

  it('bumps seat version without publishing state events', () => {
    const symbolRegistry = createSymbolRegistry([
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    ]);
    const stateEvents: Array<unknown> = [];
    const versionEvents: Array<{
      readonly previousVersion: number;
      readonly nextVersion: number;
      readonly observedSymbol: string | null;
      readonly observedStatus: string;
    }> = [];
    const truthEvents: Array<{
      readonly monitorSymbol: string;
      readonly direction: 'LONG' | 'SHORT';
      readonly observedVersion: number;
      readonly observedSymbol: string | null;
      readonly observedStatus: string;
    }> = [];
    symbolRegistry.onSeatStateChanged((event) => {
      stateEvents.push(event);
    });

    symbolRegistry.onSeatVersionChanged((event) => {
      const seatState = symbolRegistry.getSeatState('HSI.HK', 'LONG');
      versionEvents.push({
        previousVersion: event.previousVersion,
        nextVersion: event.nextVersion,
        observedSymbol: seatState.symbol,
        observedStatus: seatState.status,
      });
    });

    symbolRegistry.onSeatTruthChanged((event) => {
      const seatState = symbolRegistry.getSeatState('HSI.HK', 'LONG');
      truthEvents.push({
        monitorSymbol: event.monitorSymbol,
        direction: event.direction,
        observedVersion: symbolRegistry.getSeatVersion('HSI.HK', 'LONG'),
        observedSymbol: seatState.symbol,
        observedStatus: seatState.status,
      });
    });

    const nextVersion = symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');

    expect(nextVersion).toBe(2);
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
    expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').symbol).toBe('OLD_BULL.HK');
    expect(versionEvents).toEqual([
      {
        previousVersion: 1,
        nextVersion: 2,
        observedSymbol: 'OLD_BULL.HK',
        observedStatus: 'ACTIVE',
      },
    ]);
    expect(stateEvents).toEqual([]);
    expect(truthEvents).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        observedVersion: 2,
        observedSymbol: 'OLD_BULL.HK',
        observedStatus: 'ACTIVE',
      },
    ]);
  });

  it('logs listener errors without failing committed seat mutations', () => {
    const originalErrorLogger = logger.error;
    const errorLogs: Array<{ readonly message: string; readonly extra: unknown }> = [];
    logger.error = ((message: string, extra?: unknown) => {
      errorLogs.push({ message, extra });
    }) satisfies Logger['error'];
    const symbolRegistry = createSymbolRegistry([
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    ]);
    const events: string[] = [];
    symbolRegistry.onSeatVersionChanged(() => {
      events.push('version:first');
      throw new Error('version listener failed');
    });

    symbolRegistry.onSeatVersionChanged(() => {
      events.push('version:second');
    });

    symbolRegistry.onSeatStateChanged(() => {
      events.push('state:first');
      throw new Error('state listener failed');
    });

    symbolRegistry.onSeatStateChanged(() => {
      events.push('state:second');
    });

    symbolRegistry.onSeatTruthChanged(() => {
      events.push('truth:first');
      throw new Error('truth listener failed');
    });

    symbolRegistry.onSeatTruthChanged(() => {
      events.push('truth:second');
    });

    try {
      const result = symbolRegistry.updateSeatStateWithVersionBump('HSI.HK', 'LONG', {
        symbol: 'NEW_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: 100,
        lastSearchAt: 100,
        lastSeatActivatedAt: 120,
        callPrice: 20_000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });

      expect(result.seatVersion).toBe(2);
      expect(result.seatState.symbol).toBe('NEW_BULL.HK');
      expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').symbol).toBe('NEW_BULL.HK');
      expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
      expect(events).toEqual([
        'version:first',
        'version:second',
        'state:first',
        'state:second',
        'truth:first',
        'truth:second',
      ]);

      expect(errorLogs).toEqual([
        {
          message: 'SymbolRegistry 席位版本 listener 执行失败',
          extra: 'version listener failed',
        },
        {
          message: 'SymbolRegistry 席位状态 listener 执行失败',
          extra: 'state listener failed',
        },
        {
          message: 'SymbolRegistry 席位 truth listener 执行失败',
          extra: 'truth listener failed',
        },
      ]);
    } finally {
      logger.error = originalErrorLogger;
    }
  });

  it('logs state listener errors without failing non-version seat mutations', () => {
    const originalErrorLogger = logger.error;
    const errorLogs: Array<{ readonly message: string; readonly extra: unknown }> = [];
    logger.error = ((message: string, extra?: unknown) => {
      errorLogs.push({ message, extra });
    }) satisfies Logger['error'];
    const symbolRegistry = createSymbolRegistry([
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    ]);

    symbolRegistry.onSeatStateChanged(() => {
      throw new Error('state listener failed');
    });

    symbolRegistry.onSeatTruthChanged(() => {
      throw new Error('truth listener failed');
    });

    try {
      const result = symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVATING',
        lastSwitchAt: 100,
        lastSearchAt: 100,
        lastSeatActivatedAt: null,
        callPrice: 20_000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });

      expect(result.status).toBe('ACTIVATING');
      expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');
      expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(1);
      expect(errorLogs).toEqual([
        {
          message: 'SymbolRegistry 席位状态 listener 执行失败',
          extra: 'state listener failed',
        },
        {
          message: 'SymbolRegistry 席位 truth listener 执行失败',
          extra: 'truth listener failed',
        },
      ]);
    } finally {
      logger.error = originalErrorLogger;
    }
  });

  it('logs version listener errors without failing version-only mutations', () => {
    const originalErrorLogger = logger.error;
    const errorLogs: Array<{ readonly message: string; readonly extra: unknown }> = [];
    logger.error = ((message: string, extra?: unknown) => {
      errorLogs.push({ message, extra });
    }) satisfies Logger['error'];
    const symbolRegistry = createSymbolRegistry([
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    ]);

    symbolRegistry.onSeatVersionChanged(() => {
      throw new Error('version listener failed');
    });

    symbolRegistry.onSeatTruthChanged(() => {
      throw new Error('truth listener failed');
    });

    try {
      const nextVersion = symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');

      expect(nextVersion).toBe(2);
      expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
      expect(symbolRegistry.getSeatState('HSI.HK', 'LONG').symbol).toBe('OLD_BULL.HK');
      expect(errorLogs).toEqual([
        {
          message: 'SymbolRegistry 席位版本 listener 执行失败',
          extra: 'version listener failed',
        },
        {
          message: 'SymbolRegistry 席位 truth listener 执行失败',
          extra: 'truth listener failed',
        },
      ]);
    } finally {
      logger.error = originalErrorLogger;
    }
  });

  it('accepts signal when current seat version and symbol both match', () => {
    const symbolRegistry = createSymbolRegistryDouble({
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
      longVersion: 2,
    });
    let signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

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
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 1 };

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
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortVersion: 5,
    });
    let signal = createSignalDouble('BUYPUT', 'BEAR_OLD.HK');
    signal = { ...signal, seatVersion: 4 };

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

    signal = { ...signal, seatVersion: 5 };
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

  it('rejects HOLD signal without throwing', () => {
    const symbolRegistry = createSymbolRegistryDouble({
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
      longVersion: 2,
    });
    let signal = createSignalDouble('HOLD', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    const result = validateSignalSeat({
      monitorSymbol: 'HSI.HK',
      signal,
      symbolRegistry,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('INVALID_SIGNAL_ACTION');
      expect(describeSignalSeatValidationFailure(result)).toBe('信号动作不支持席位校验');
    }
  });
});
