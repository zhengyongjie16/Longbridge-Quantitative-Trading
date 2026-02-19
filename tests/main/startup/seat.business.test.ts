/**
 * startup/seat 业务测试
 *
 * 功能：
 * - 验证席位解析与就绪状态的场景与边界。
 */
import { describe, expect, it } from 'bun:test';
import { WarrantStatus, WarrantType, type WarrantInfo } from 'longport';

import { prepareSeatsOnStartup, resolveReadySeatSymbol } from '../../../src/main/startup/seat.js';
import { createQuoteContextMock } from '../../../mock/longport/quoteContextMock.js';
import { toMockDecimal } from '../../../mock/longport/decimal.js';
import {
  createMonitorConfigDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';

function createLoggerStub() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as never;
}

function createWarrantInfo(params: {
  readonly symbol: string;
  readonly warrantType: WarrantType;
  readonly distancePct: number;
  readonly turnover: number;
  readonly callPrice: number;
}): WarrantInfo {
  const warrantType = params.warrantType === WarrantType.Bull ? 'Bull' : 'Bear';
  return {
    symbol: params.symbol,
    name: params.symbol,
    lastDone: toMockDecimal(0.1),
    toCallPrice: toMockDecimal(params.distancePct),
    turnover: toMockDecimal(params.turnover),
    callPrice: toMockDecimal(params.callPrice),
    warrantType,
    status: WarrantStatus.Normal,
  } as unknown as WarrantInfo;
}

describe('startup seat preparation business flow', () => {
  it('returns symbol only when seat is READY', () => {
    const registry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    expect(resolveReadySeatSymbol(registry, 'HSI.HK', 'LONG')).toBe('BULL.HK');
    expect(resolveReadySeatSymbol(registry, 'HSI.HK', 'SHORT')).toBeNull();
  });

  it('restores configured symbols on startup when auto-search is disabled', async () => {
    const monitor = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      autoSearchConfig: {
        autoSearchEnabled: false,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
    });

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitor.monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const quoteCtx = createQuoteContextMock();

    const prepared = await prepareSeatsOnStartup({
      tradingConfig: createTradingConfig({ monitors: [monitor] }),
      symbolRegistry,
      positions: [],
      orders: [],
      marketDataClient: {
        getQuoteContext: async () => quoteCtx as never,
      } as never,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 5,
      isWithinMorningOpenProtection: () => false,
    });

    expect(quoteCtx.getCalls('warrantList')).toHaveLength(0);
    expect(prepared.seatSymbols).toEqual([
      { monitorSymbol: 'HSI.HK', direction: 'LONG', symbol: 'BULL.HK' },
      { monitorSymbol: 'HSI.HK', direction: 'SHORT', symbol: 'BEAR.HK' },
    ]);
  });

  it('tracks failure counts when auto-search cannot find candidates on startup', async () => {
    const monitor = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
      orderOwnershipMapping: ['A'],
    });

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitor.monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const quoteCtx = createQuoteContextMock();

    const prepared = await prepareSeatsOnStartup({
      tradingConfig: createTradingConfig({ monitors: [monitor] }),
      symbolRegistry,
      positions: [],
      orders: [],
      marketDataClient: {
        getQuoteContext: async () => quoteCtx as never,
      } as never,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 10,
      isWithinMorningOpenProtection: () => false,
    });

    const longSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'LONG');
    const shortSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'SHORT');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.searchFailCountToday).toBe(1);
    expect(shortSeat.status).toBe('EMPTY');
    expect(shortSeat.searchFailCountToday).toBe(1);

    expect(prepared.seatSymbols).toEqual([]);
  });

  it('skips startup search during morning open protection window', async () => {
    const monitor = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitor.monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const quoteCtx = createQuoteContextMock();
    quoteCtx.seedWarrantList('HSI.HK', [
      createWarrantInfo({
        symbol: 'AUTO_BULL.HK',
        warrantType: WarrantType.Bull,
        distancePct: 0.55,
        turnover: 2_000_000,
        callPrice: 20_500,
      }),
      createWarrantInfo({
        symbol: 'AUTO_BEAR.HK',
        warrantType: WarrantType.Bear,
        distancePct: -0.55,
        turnover: 2_000_000,
        callPrice: 19_500,
      }),
    ]);

    const prepared = await prepareSeatsOnStartup({
      tradingConfig: createTradingConfig({ monitors: [monitor] }),
      symbolRegistry,
      positions: [],
      orders: [],
      marketDataClient: {
        getQuoteContext: async () => quoteCtx as never,
      } as never,
      now: () => new Date('2026-02-16T01:01:00.000Z'),
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 1,
      isWithinMorningOpenProtection: () => true,
    });

    expect(quoteCtx.getCalls('warrantList')).toHaveLength(0);
    expect(prepared.seatSymbols).toEqual([]);
  });
});
