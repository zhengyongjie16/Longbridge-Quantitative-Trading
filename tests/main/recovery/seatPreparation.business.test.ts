/**
 * recovery/seatPreparation 业务测试
 *
 * 功能：
 * - 验证席位解析与就绪状态的场景与边界。
 */
import { describe, expect, it } from 'bun:test';
import { WarrantStatus, WarrantType } from 'longport';

import {
  prepareSeatsForRuntime,
  resolveReadySeatSymbol,
} from '../../../src/main/recovery/seatPreparation.js';
import { createQuoteContextMock } from '../../../mock/longport/quoteContextMock.js';
import { toMockDecimal } from '../../../mock/longport/decimal.js';
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

describe('recovery seat preparation business flow', () => {
  it('returns symbol only when seat is READY', () => {
    const registry = createSymbolRegistryDouble({
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
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    expect(resolveReadySeatSymbol(registry, 'HSI.HK', 'LONG')).toBe('BULL.HK');
    expect(resolveReadySeatSymbol(registry, 'HSI.HK', 'SHORT')).toBeNull();
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
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
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
      isWithinMorningOpenProtection: () => false,
    });

    expect(quoteCtx.getCalls('warrantList')).toHaveLength(0);
    expect(quoteContextCalls).toBe(0);
    expect(prepared.seatSymbols).toEqual([
      { monitorSymbol: 'HSI.HK', direction: 'LONG', symbol: 'BULL.HK' },
      { monitorSymbol: 'HSI.HK', direction: 'SHORT', symbol: 'BEAR.HK' },
    ]);
    const longSeat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    const shortSeat = symbolRegistry.getSeatState('HSI.HK', 'SHORT');
    expect(longSeat.lastSeatReadyAt).toBe(Date.parse(startupTime));
    expect(shortSeat.lastSeatReadyAt).toBe(Date.parse(startupTime));
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
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
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
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
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
        turnover: 2_000_000,
        callPrice: 20_500,
      }),
      createWarrantInfo({
        symbol: 'AUTO_BEAR.HK',
        warrantType: WarrantType.Bear,
        apiDistanceRatio: toApiDistanceRatio(-0.55),
        turnover: 2_000_000,
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
      isWithinMorningOpenProtection: () => true,
    });

    expect(quoteCtx.getCalls('warrantList')).toHaveLength(0);
    expect(prepared.seatSymbols).toEqual([]);
  });

  it('binds degraded bear candidate for SHORT seat during startup auto-search', async () => {
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
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
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
      isWithinMorningOpenProtection: () => false,
    });

    const shortSeat = symbolRegistry.getSeatState(monitor.monitorSymbol, 'SHORT');
    expect(shortSeat.status).toBe('READY');
    expect(shortSeat.symbol).toBe('AUTO_BEAR_BEST.HK');
    expect(shortSeat.callPrice).toBe(19_500);
    expect(
      prepared.seatSymbols.some(
        (entry) => entry.direction === 'SHORT' && entry.symbol === 'AUTO_BEAR_BEST.HK',
      ),
    ).toBeTrue();
  });
});
