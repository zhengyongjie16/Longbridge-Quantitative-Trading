/**
 * autoSearch 业务测试
 *
 * 功能：
 * - 验证自动寻标相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { createAutoSearch } from '../../../src/services/autoSymbolManager/autoSearch.js';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import { getHKDateKey } from '../../../src/utils/time/index.js';
import {
  createMonitorConfigDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import {
  createDirectionalAutoSearchPolicy,
  createFindBestWarrantInputDouble,
  createLoggerStub,
  createWarrantCandidate,
  createWarrantCandidateWithOverrides,
  getDefaultAutoSearchConfig,
} from './utils.js';

describe('autoSymbolManager autoSearch business flow', () => {
  it('fills EMPTY seat to READY and resets failure counters when a candidate is found', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 1,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = new Map();
    const switchSuppressions = new Map();
    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    let findCalls = 0;
    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      buildSeatState: manager.buildSeatState,
      updateSeatState: manager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        findCalls += 1;
        return {
          ...createWarrantCandidate('NEW_BULL.HK'),
          callPrice: 20_500,
        };
      },
      isWithinMorningOpenProtection: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: createLoggerStub(),
    });
    await autoSearch.maybeSearchOnTick({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:00:00.000Z'),
      canTradeNow: true,
    });
    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(findCalls).toBe(1);
    expect(seat.status).toBe('READY');
    expect(seat.symbol).toBe('NEW_BULL.HK');
    expect(seat.callPrice).toBe(20_500);
    expect(seat.searchFailCountToday).toBe(0);
    expect(seat.frozenTradingDayKey).toBeNull();
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
  });

  it('freezes seat for the day after reaching max search failures', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 2,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = new Map();
    const switchSuppressions = new Map();
    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    let findCalls = 0;
    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      buildSeatState: manager.buildSeatState,
      updateSeatState: manager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        findCalls += 1;
        return null;
      },
      isWithinMorningOpenProtection: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: createLoggerStub(),
    });
    await autoSearch.maybeSearchOnTick({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:00:00.000Z'),
      canTradeNow: true,
    });
    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(findCalls).toBe(1);
    expect(seat.status).toBe('EMPTY');
    expect(seat.searchFailCountToday).toBe(3);
    expect(seat.frozenTradingDayKey).toBe('2026-02-16');
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(1);
  });

  it('honors search cooldown and skips finder call within cooldown window', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const now = new Date('2026-02-16T01:00:00.000Z');
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: now.getTime() - 5_000,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = new Map();
    const switchSuppressions = new Map();
    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });
    let findCalls = 0;
    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      buildSeatState: manager.buildSeatState,
      updateSeatState: manager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        findCalls += 1;
        return null;
      },
      isWithinMorningOpenProtection: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: createLoggerStub(),
    });
    await autoSearch.maybeSearchOnTick({
      direction: 'LONG',
      currentTime: now,
      canTradeNow: true,
    });
    expect(findCalls).toBe(0);
  });

  it('fills EMPTY SHORT seat to READY when bear candidate is found', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 1,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = new Map();
    const switchSuppressions = new Map();
    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    let findCalls = 0;
    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      buildSeatState: manager.buildSeatState,
      updateSeatState: manager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('SHORT'),
      buildFindBestWarrantInput: async () =>
        createFindBestWarrantInputDouble(createDirectionalAutoSearchPolicy('SHORT')),
      findBestWarrant: async () => {
        findCalls += 1;
        return createWarrantCandidateWithOverrides('NEW_BEAR.HK', {
          callPrice: 19_500,
          distancePct: -0.3499,
          selectionStage: 'DEGRADED',
          distanceDeltaToThreshold: 0.0001,
        });
      },
      isWithinMorningOpenProtection: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: createLoggerStub(),
    });
    await autoSearch.maybeSearchOnTick({
      direction: 'SHORT',
      currentTime: new Date('2026-02-16T01:00:00.000Z'),
      canTradeNow: true,
    });
    const seat = symbolRegistry.getSeatState('HSI.HK', 'SHORT');
    expect(findCalls).toBe(1);
    expect(seat.status).toBe('READY');
    expect(seat.symbol).toBe('NEW_BEAR.HK');
    expect(seat.callPrice).toBe(19_500);
    expect(seat.searchFailCountToday).toBe(0);
    expect(seat.frozenTradingDayKey).toBeNull();
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'SHORT')).toBe(2);
  });
});
