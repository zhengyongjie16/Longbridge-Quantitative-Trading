/**
 * recovery/seatPreparation 业务测试
 *
 * 功能：
 * - 验证席位解析与就绪状态的场景与边界。
 */
import { describe, expect, it } from 'bun:test';
import { WarrantStatus, WarrantType } from 'longbridge';

import {
  prepareSeatsForRuntime,
  resolveBoundSeatSymbol,
} from '../../../src/main/recovery/seatPreparation.js';
import { AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY } from '../../../src/constants/index.js';
import { getHKDateKey } from '../../../src/utils/time/index.js';
import { createQuoteContextMock } from '../../../mock/longbridge/quoteContextMock.js';
import { toMockDecimal } from '../../../mock/longbridge/decimal.js';
import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createQuoteContextDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import type { Logger } from '../../../src/utils/logger/types.js';

function createLoggerStub(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createWarrantInfo(params: {
  readonly symbol: string;
  readonly warrantType: WarrantType;
  readonly apiDistanceRatio: number;
  readonly turnover: number;
  readonly callPrice: number;
}): Parameters<ReturnType<typeof createQuoteContextMock>['seedWarrantList']>[1][number] {
  const warrantType = params.warrantType === WarrantType.Bull ? 'Bull' : 'Bear';
  return {
    symbol: params.symbol,
    name: params.symbol,
    lastDone: toMockDecimal(0.1),
    toCallPrice: toMockDecimal(params.apiDistanceRatio),
    turnover: toMockDecimal(params.turnover),
    callPrice: toMockDecimal(params.callPrice),
    warrantType,
    status: WarrantStatus.Normal,
  };
}

function toApiDistanceRatio(percentValue: number): number {
  return percentValue / 100;
}

function createAutoSearchMonitor() {
  return createMonitorConfigDouble({
    monitorSymbol: 'HSI.HK',
    autoSearchConfig: {
      autoSearchEnabled: true,
      autoSearchMinDistancePctBull: 0.35,
      autoSearchMinDistancePctBear: -0.35,
      autoSearchMinTurnoverPerMinuteBull: 100_000,
      autoSearchMinTurnoverPerMinuteBear: 100_000,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 5,
      switchIntervalMinutes: 0,
      switchDistanceRangeBull: { min: 0.2, max: 1.5 },
      switchDistanceRangeBear: { min: -1.5, max: -0.2 },
    },
  });
}

function createEmptySymbolRegistry(monitorSymbol: string) {
  return createSymbolRegistryDouble({
    monitorSymbol,
    longSeat: {
      symbol: null,
      status: 'EMPTY',
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
}

function seedAutoSearchCandidates(quoteCtx: ReturnType<typeof createQuoteContextMock>): void {
  quoteCtx.seedWarrantList('HSI.HK', [
    createWarrantInfo({
      symbol: 'AUTO_BULL.HK',
      warrantType: WarrantType.Bull,
      apiDistanceRatio: toApiDistanceRatio(0.55),
      turnover: 30_000_000,
      callPrice: 20_500,
    }),
    createWarrantInfo({
      symbol: 'AUTO_BEAR.HK',
      warrantType: WarrantType.Bear,
      apiDistanceRatio: toApiDistanceRatio(-0.55),
      turnover: 30_000_000,
      callPrice: 19_500,
    }),
  ]);
}

describe('recovery seat preparation business flow', () => {
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

  it('restores configured symbols on startup when auto-search is disabled', async () => {
    const startupTime = '2026-02-16T01:00:00.000Z';
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
        switchIntervalMinutes: 0,
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

    const quoteCtx = createQuoteContextMock();

    let quoteContextCalls = 0;
    const prepared = await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitor] }),
      symbolRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => {
          quoteContextCalls += 1;
          return createQuoteContextDouble(quoteCtx);
        },
      }),
      now: () => new Date(startupTime),
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 5,
      resolveCanAutoSearchNow: () => true,
    });

    expect(quoteCtx.getCalls('warrantList')).toHaveLength(0);
    expect(quoteContextCalls).toBe(0);
    expect(prepared.seatSymbols).toEqual([
      { monitorSymbol: 'HSI.HK', direction: 'LONG', symbol: 'BULL.HK' },
      { monitorSymbol: 'HSI.HK', direction: 'SHORT', symbol: 'BEAR.HK' },
    ]);
    const longSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    const shortSeat = symbolRegistry.getSeatState('HSI.HK', 'SHORT');
    expect(longSeat.lastSeatActivatedAt).toBeNull();
    expect(shortSeat.lastSeatActivatedAt).toBeNull();
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
        switchIntervalMinutes: 0,
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

    const quoteCtx = createQuoteContextMock();

    const prepared = await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitor] }),
      symbolRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => createQuoteContextDouble(quoteCtx),
      }),
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 10,
      resolveCanAutoSearchNow: () => true,
    });

    const longSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'LONG');
    const shortSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'SHORT');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.searchFailCountToday).toBe(1);
    expect(shortSeat.status).toBe('EMPTY');
    expect(shortSeat.searchFailCountToday).toBe(1);

    expect(prepared.seatSymbols).toEqual([]);
  });

  it('rethrows ExternalApiRequestError during startup recovery search and preserves prior failure state', async () => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitor.monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 2,
        frozenTradingDayKey: '2026-02-15',
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
    const quoteCtx = createQuoteContextMock();
    quoteCtx.setFailureRule('warrantList', {
      failAtCalls: [1, 2, 3],
      errorMessage: 'network',
    });

    let error: unknown = null;
    try {
      await prepareSeatsForRuntime({
        tradingConfig: createTradingConfig({ monitors: [monitor] }),
        symbolRegistry,
        positions: [],
        orders: [],
        marketDataClient: createMarketDataClientDouble({
          getQuoteContext: async () => createQuoteContextDouble(quoteCtx),
        }),
        now: () => new Date('2026-02-16T01:35:00.000Z'),
        logger: createLoggerStub(),
        getTradingMinutesSinceOpen: () => 5,
        resolveCanAutoSearchNow: () => true,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      name: 'ExternalApiRequestError',
      operation: 'QuoteContext.warrantList',
    });

    const longSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'LONG');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.searchFailCountToday).toBe(2);
    expect(longSeat.frozenTradingDayKey).toBe('2026-02-15');
  });

  it('rethrows TypeError during startup recovery search and preserves prior failure state', async () => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitor.monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 1,
        frozenTradingDayKey: '2026-02-14',
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

    let error: unknown = null;
    try {
      await prepareSeatsForRuntime({
        tradingConfig: createTradingConfig({ monitors: [monitor] }),
        symbolRegistry,
        positions: [],
        orders: [],
        marketDataClient: createMarketDataClientDouble({
          getQuoteContext: async () => ({
            warrantQuote: async () => [],
            warrantList: async () => {
              throw new TypeError('warrant payload contract broken');
            },
          }),
        }),
        now: () => new Date('2026-02-16T01:35:00.000Z'),
        logger: createLoggerStub(),
        getTradingMinutesSinceOpen: () => 5,
        resolveCanAutoSearchNow: () => true,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: 'warrant payload contract broken' });

    const longSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'LONG');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.searchFailCountToday).toBe(1);
    expect(longSeat.frozenTradingDayKey).toBe('2026-02-14');
  });

  it('freezes seat when startup auto-search misses candidate at daily failure threshold', async () => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitor.monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY - 1,
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
    const currentTime = new Date('2026-02-16T01:35:00.000Z');
    const prepared = await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitor] }),
      symbolRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => createQuoteContextDouble(createQuoteContextMock()),
      }),
      now: () => currentTime,
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 5,
      resolveCanAutoSearchNow: () => true,
    });

    const longSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'LONG');
    expect(prepared.seatSymbols).toEqual([]);
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.searchFailCountToday).toBe(AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY);
    expect(longSeat.frozenTradingDayKey).toBe(getHKDateKey(currentTime));
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
        switchIntervalMinutes: 0,
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

    const quoteCtx = createQuoteContextMock();
    quoteCtx.seedWarrantList('HSI.HK', [
      createWarrantInfo({
        symbol: 'AUTO_BULL.HK',
        warrantType: WarrantType.Bull,
        apiDistanceRatio: toApiDistanceRatio(0.55),
        turnover: 30_000_000,
        callPrice: 20_500,
      }),
      createWarrantInfo({
        symbol: 'AUTO_BEAR.HK',
        warrantType: WarrantType.Bear,
        apiDistanceRatio: toApiDistanceRatio(-0.55),
        turnover: 30_000_000,
        callPrice: 19_500,
      }),
    ]);

    const prepared = await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitor] }),
      symbolRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => createQuoteContextDouble(quoteCtx),
      }),
      now: () => new Date('2026-02-16T01:01:00.000Z'),
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 1,
      resolveCanAutoSearchNow: () => false,
    });

    expect(quoteCtx.getCalls('warrantList')).toHaveLength(0);
    expect(prepared.seatSymbols).toEqual([]);
  });

  it.each([
    ['before continuous session starts', '2026-02-16T01:29:00.000Z'],
    ['during morning open delay', '2026-02-16T01:31:00.000Z'],
    ['when trading day info is unknown', '2026-02-16T01:35:00.000Z'],
    ['on non-trading day', '2026-02-16T01:35:00.000Z'],
  ])('skips startup auto-search %s', async (_caseName, currentTime) => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createEmptySymbolRegistry(monitor.monitorSymbol);
    const quoteCtx = createQuoteContextMock();
    seedAutoSearchCandidates(quoteCtx);

    const prepared = await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitor] }),
      symbolRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => createQuoteContextDouble(quoteCtx),
      }),
      now: () => new Date(currentTime),
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 0,
      resolveCanAutoSearchNow: () => false,
    });

    expect(quoteCtx.getCalls('warrantList')).toHaveLength(0);
    expect(symbolRegistry.getSeatState(monitor.monitorSymbol, 'LONG').status).toBe('EMPTY');
    expect(symbolRegistry.getSeatState(monitor.monitorSymbol, 'SHORT').status).toBe('EMPTY');
    expect(prepared.seatSymbols).toEqual([]);
  });

  it('runs startup auto-search after morning open delay ends', async () => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createEmptySymbolRegistry(monitor.monitorSymbol);
    const quoteCtx = createQuoteContextMock();
    seedAutoSearchCandidates(quoteCtx);

    const prepared = await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitor] }),
      symbolRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => createQuoteContextDouble(quoteCtx),
      }),
      now: () => new Date('2026-02-16T01:35:00.000Z'),
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 5,
      resolveCanAutoSearchNow: () => true,
    });

    const longSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'LONG');
    const shortSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'SHORT');
    expect(quoteCtx.getCalls('warrantList')).toHaveLength(2);
    expect(longSeat.status).toBe('ACTIVATING');
    expect(longSeat.symbol).toBe('AUTO_BULL.HK');
    expect(shortSeat.status).toBe('ACTIVATING');
    expect(shortSeat.symbol).toBe('AUTO_BEAR.HK');
    expect(prepared.seatSymbols).toEqual([
      { monitorSymbol: 'HSI.HK', direction: 'LONG', symbol: 'AUTO_BULL.HK' },
      { monitorSymbol: 'HSI.HK', direction: 'SHORT', symbol: 'AUTO_BEAR.HK' },
    ]);
  });

  it('runs startup auto-search in afternoon continuous session', async () => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createEmptySymbolRegistry(monitor.monitorSymbol);
    const quoteCtx = createQuoteContextMock();
    seedAutoSearchCandidates(quoteCtx);

    const prepared = await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitor] }),
      symbolRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => createQuoteContextDouble(quoteCtx),
      }),
      now: () => new Date('2026-02-16T05:00:00.000Z'),
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 150,
      resolveCanAutoSearchNow: () => true,
    });

    const longSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'LONG');
    const shortSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'SHORT');
    expect(quoteCtx.getCalls('warrantList')).toHaveLength(2);
    expect(longSeat.status).toBe('ACTIVATING');
    expect(shortSeat.status).toBe('ACTIVATING');
    expect(prepared.seatSymbols).toHaveLength(2);
  });

  it('binds degraded bear candidate for SHORT seat during startup auto-search and keeps it ACTIVATING', async () => {
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
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
      orderOwnershipMapping: ['HSI'],
    });

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitor.monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
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

    const quoteCtx = createQuoteContextMock();
    quoteCtx.seedWarrantList('HSI.HK', [
      createWarrantInfo({
        symbol: 'AUTO_BEAR_1.HK',
        warrantType: WarrantType.Bear,
        apiDistanceRatio: toApiDistanceRatio(-0.22),
        turnover: 1_500_000,
        callPrice: 19_300,
      }),
      createWarrantInfo({
        symbol: 'AUTO_BEAR_BEST.HK',
        warrantType: WarrantType.Bear,
        apiDistanceRatio: toApiDistanceRatio(-0.3499),
        turnover: 1_800_000,
        callPrice: 19_500,
      }),
    ]);

    const prepared = await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitor] }),
      symbolRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => createQuoteContextDouble(quoteCtx),
      }),
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 10,
      resolveCanAutoSearchNow: () => true,
    });

    const shortSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'SHORT');
    expect(shortSeat.status).toBe('ACTIVATING');
    expect(shortSeat.symbol).toBe('AUTO_BEAR_BEST.HK');
    expect(shortSeat.callPrice).toBe(19_500);
    expect(
      prepared.seatSymbols.some(
        (entry) => entry.direction === 'SHORT' && entry.symbol === 'AUTO_BEAR_BEST.HK',
      ),
    ).toBeTrue();
  });
});
