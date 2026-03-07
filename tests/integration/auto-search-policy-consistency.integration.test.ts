/**
 * auto-search-policy-consistency 集成测试
 *
 * 功能：
 * - 验证启动寻标、运行时空席位自动寻标、距回收价换标预寻标三条入口在同一候选集下使用同一策略并得到一致结果。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, WarrantStatus, WarrantType } from 'longport';

import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { toMockDecimal } from '../../mock/longport/decimal.js';
import { createQuoteContextMock } from '../../mock/longport/quoteContextMock.js';
import { prepareSeatsOnStartup } from '../../src/main/startup/seat.js';
import { findBestWarrant } from '../../src/services/autoSymbolFinder/index.js';
import {
  buildFindBestWarrantInputFromPolicy,
  resolveDirectionalAutoSearchPolicy,
} from '../../src/services/autoSymbolFinder/policyResolver.js';
import { createAutoSearch } from '../../src/services/autoSymbolManager/autoSearch.js';
import {
  calculateBuyQuantityByNotional,
  createSignalBuilder,
  resolveDirectionSymbols,
} from '../../src/services/autoSymbolManager/signalBuilder.js';
import { createSeatStateManager } from '../../src/services/autoSymbolManager/seatStateManager.js';
import { createSwitchStateMachine } from '../../src/services/autoSymbolManager/switchStateMachine.js';
import { PENDING_ORDER_STATUSES } from '../../src/constants/index.js';
import type { Quote } from '../../src/types/quote.js';
import type { Logger } from '../../src/utils/logger/types.js';
import { signalObjectPool } from '../../src/utils/objectPool/index.js';
import { getHKDateKey } from '../../src/utils/tradingTime/index.js';
import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createQuoteContextDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';

function createLoggerRecorder(): {
  readonly logger: Logger;
  readonly infos: string[];
  readonly warns: string[];
  readonly errors: string[];
} {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];

  return {
    logger: {
      debug: () => {},
      info: (message: string) => {
        infos.push(message);
      },
      warn: (message: string) => {
        warns.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
    },
    infos,
    warns,
    errors,
  };
}

function createWarrantInfo(params: {
  readonly symbol: string;
  readonly warrantType: WarrantType;
  readonly apiDistanceRatio: number;
  readonly turnover: number;
  readonly callPrice: number;
}): Parameters<ReturnType<typeof createQuoteContextMock>['seedWarrantList']>[1][number] {
  return {
    symbol: params.symbol,
    name: params.symbol,
    lastDone: toMockDecimal(0.1),
    toCallPrice: toMockDecimal(params.apiDistanceRatio),
    turnover: toMockDecimal(params.turnover),
    callPrice: toMockDecimal(params.callPrice),
    warrantType: params.warrantType,
    status: WarrantStatus.Normal,
  };
}

function toApiDistanceRatio(percentValue: number): number {
  return percentValue / 100;
}

function createQuotes(prices: Readonly<Record<string, number>>): ReadonlyMap<string, Quote | null> {
  const quotes = new Map<string, Quote | null>();
  for (const [symbol, price] of Object.entries(prices)) {
    quotes.set(symbol, {
      symbol,
      name: symbol,
      price,
      prevClose: price,
      timestamp: Date.now(),
      lotSize: 100,
    });
  }

  return quotes;
}

describe('auto search policy consistency integration', () => {
  it('selects the same degraded candidate across startup search, runtime empty-seat search, and distance-switch presearch', async () => {
    const currentTime = new Date('2026-02-16T01:00:00.000Z');
    const monitorConfig = createMonitorConfigDouble({
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
    const quoteContext = createQuoteContextMock();
    quoteContext.seedWarrantList('HSI.HK', [
      createWarrantInfo({
        symbol: 'LOWER_BULL.HK',
        warrantType: WarrantType.Bull,
        apiDistanceRatio: toApiDistanceRatio(0.22),
        turnover: 1_500_000,
        callPrice: 20_300,
      }),
      createWarrantInfo({
        symbol: 'BEST_BULL.HK',
        warrantType: WarrantType.Bull,
        apiDistanceRatio: toApiDistanceRatio(0.3499),
        turnover: 1_800_000,
        callPrice: 20_500,
      }),
    ]);

    const startupLogger = createLoggerRecorder();
    const startupRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
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
    await prepareSeatsOnStartup({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry: startupRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => createQuoteContextDouble(quoteContext),
      }),
      now: () => currentTime,
      logger: startupLogger.logger,
      getTradingMinutesSinceOpen: () => 10,
      isWithinMorningOpenProtection: () => false,
    });

    const startupSeat = startupRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
    expect(startupSeat.status).toBe('READY');
    expect(startupSeat.symbol).toBe('BEST_BULL.HK');
    expect(
      startupLogger.infos.some(
        (message) =>
          message.includes('BEST_BULL.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    const runtimeLogger = createLoggerRecorder();
    const runtimeRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
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
    const runtimeSeatStateManager = createSeatStateManager({
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: runtimeRegistry,
      switchStates: new Map(),
      switchSuppressions: new Map(),
      now: () => currentTime,
      logger: runtimeLogger.logger,
      getHKDateKey,
    });
    const runtimeAutoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: runtimeRegistry,
      buildSeatState: runtimeSeatStateManager.buildSeatState,
      updateSeatState: runtimeSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: runtimeLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: createQuoteContextDouble(quoteContext),
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: runtimeLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      isWithinMorningOpenProtection: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: runtimeLogger.logger,
    });
    await runtimeAutoSearch.maybeSearchOnTick({
      direction: 'LONG',
      currentTime,
      canTradeNow: true,
    });

    const runtimeSeat = runtimeRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
    expect(runtimeSeat.status).toBe('READY');
    expect(runtimeSeat.symbol).toBe('BEST_BULL.HK');
    expect(
      runtimeLogger.infos.some(
        (message) =>
          message.includes('BEST_BULL.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    const switchLogger = createLoggerRecorder();
    const switchStates = new Map();
    const switchSuppressions = new Map();
    const switchRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: currentTime.getTime(),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchSeatStateManager = createSeatStateManager({
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: switchRegistry,
      switchStates,
      switchSuppressions,
      now: () => currentTime,
      logger: switchLogger.logger,
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder({ signalObjectPool });
    const switchStateMachine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: switchRegistry,
      trader: createTraderDouble({
        getPendingOrders: async () => [],
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => currentTime,
      switchStates,
      periodicSwitchPending: new Map(),
      resolveSuppression: switchSeatStateManager.resolveSuppression,
      markSuppression: switchSeatStateManager.markSuppression,
      clearSeat: switchSeatStateManager.clearSeat,
      buildSeatState: switchSeatStateManager.buildSeatState,
      updateSeatState: switchSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: switchLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: createQuoteContextDouble(quoteContext),
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: switchLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      signalObjectPool,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: switchLogger.logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween: () => 0,
      getTradingCalendarSnapshot: () => new Map(),
    });
    await switchStateMachine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: createQuotes({
        'OLD_BULL.HK': 1,
        'BEST_BULL.HK': 1,
      }),
      positions: [],
    });

    const switchedSeat = switchRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
    expect(switchedSeat.status).toBe('READY');
    expect(switchedSeat.symbol).toBe('BEST_BULL.HK');
    expect(
      switchLogger.infos.some(
        (message) =>
          message.includes('BEST_BULL.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);
    expect(quoteContext.getCalls('warrantList')).toHaveLength(4);
  });

  it('selects the same degraded SHORT candidate across startup search, runtime empty-seat search, and distance-switch presearch', async () => {
    const currentTime = new Date('2026-02-16T01:00:00.000Z');
    const monitorConfig = createMonitorConfigDouble({
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
    const quoteContext = createQuoteContextMock();
    quoteContext.seedWarrantList('HSI.HK', [
      createWarrantInfo({
        symbol: 'UPPER_BEAR.HK',
        warrantType: WarrantType.Bear,
        apiDistanceRatio: toApiDistanceRatio(-0.22),
        turnover: 1_500_000,
        callPrice: 19_300,
      }),
      createWarrantInfo({
        symbol: 'BEST_BEAR.HK',
        warrantType: WarrantType.Bear,
        apiDistanceRatio: toApiDistanceRatio(-0.3499),
        turnover: 1_800_000,
        callPrice: 19_500,
      }),
    ]);

    const startupLogger = createLoggerRecorder();
    const startupRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
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
    await prepareSeatsOnStartup({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry: startupRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => createQuoteContextDouble(quoteContext),
      }),
      now: () => currentTime,
      logger: startupLogger.logger,
      getTradingMinutesSinceOpen: () => 10,
      isWithinMorningOpenProtection: () => false,
    });

    const startupSeat = startupRegistry.getSeatState(monitorConfig.monitorSymbol, 'SHORT');
    expect(startupSeat.status).toBe('READY');
    expect(startupSeat.symbol).toBe('BEST_BEAR.HK');
    expect(
      startupLogger.infos.some(
        (message) =>
          message.includes('BEST_BEAR.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    const runtimeLogger = createLoggerRecorder();
    const runtimeRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
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
    const runtimeSeatStateManager = createSeatStateManager({
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: runtimeRegistry,
      switchStates: new Map(),
      switchSuppressions: new Map(),
      now: () => currentTime,
      logger: runtimeLogger.logger,
      getHKDateKey,
    });
    const runtimeAutoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: runtimeRegistry,
      buildSeatState: runtimeSeatStateManager.buildSeatState,
      updateSeatState: runtimeSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: runtimeLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: createQuoteContextDouble(quoteContext),
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: runtimeLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      isWithinMorningOpenProtection: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: runtimeLogger.logger,
    });
    await runtimeAutoSearch.maybeSearchOnTick({
      direction: 'SHORT',
      currentTime,
      canTradeNow: true,
    });

    const runtimeSeat = runtimeRegistry.getSeatState(monitorConfig.monitorSymbol, 'SHORT');
    expect(runtimeSeat.status).toBe('READY');
    expect(runtimeSeat.symbol).toBe('BEST_BEAR.HK');
    expect(
      runtimeLogger.infos.some(
        (message) =>
          message.includes('BEST_BEAR.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    const switchLogger = createLoggerRecorder();
    const switchStates = new Map();
    const switchSuppressions = new Map();
    const switchRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
      shortSeat: {
        symbol: 'OLD_BEAR.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: currentTime.getTime(),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortVersion: 1,
    });
    const switchSeatStateManager = createSeatStateManager({
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: switchRegistry,
      switchStates,
      switchSuppressions,
      now: () => currentTime,
      logger: switchLogger.logger,
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder({ signalObjectPool });
    const switchStateMachine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: switchRegistry,
      trader: createTraderDouble({
        getPendingOrders: async () => [],
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BEAR',
            distanceToStrikePercent: -0.1,
          }),
      }),
      now: () => currentTime,
      switchStates,
      periodicSwitchPending: new Map(),
      resolveSuppression: switchSeatStateManager.resolveSuppression,
      markSuppression: switchSeatStateManager.markSuppression,
      clearSeat: switchSeatStateManager.clearSeat,
      buildSeatState: switchSeatStateManager.buildSeatState,
      updateSeatState: switchSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: switchLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: createQuoteContextDouble(quoteContext),
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: switchLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      signalObjectPool,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: switchLogger.logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween: () => 0,
      getTradingCalendarSnapshot: () => new Map(),
    });
    await switchStateMachine.maybeSwitchOnDistance({
      direction: 'SHORT',
      monitorPrice: 20_000,
      quotesMap: createQuotes({
        'OLD_BEAR.HK': 1,
        'BEST_BEAR.HK': 1,
      }),
      positions: [],
    });

    const switchedSeat = switchRegistry.getSeatState(monitorConfig.monitorSymbol, 'SHORT');
    expect(switchedSeat.status).toBe('READY');
    expect(switchedSeat.symbol).toBe('BEST_BEAR.HK');
    expect(
      switchLogger.infos.some(
        (message) =>
          message.includes('BEST_BEAR.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);
    expect(quoteContext.getCalls('warrantList')).toHaveLength(4);
  });
});
