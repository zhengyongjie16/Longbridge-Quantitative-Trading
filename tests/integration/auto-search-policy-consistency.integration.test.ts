/**
 * auto-search-policy-consistency 集成测试
 *
 * 功能：
 * - 验证启动寻标、运行时空席位自动寻标、距回收价换标预寻标三条入口在同一候选集下使用同一策略并得到一致结果。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, WarrantStatus, WarrantType } from 'longbridge';

import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { toMockDecimal } from '../../mock/longbridge/decimal.js';
import { createQuoteContextMock } from '../../mock/longbridge/quoteContextMock.js';
import { prepareSeatsForRuntime } from '../../src/main/recovery/seatPreparation.js';
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
import type { Logger } from '../../src/utils/logger/types.js';
import { getHKDateKey } from '../../src/utils/time/index.js';
import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createQuoteContextDouble,
  createQuoteDouble,
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

async function runDistanceSwitch(
  machine: ReturnType<typeof createSwitchStateMachine>,
  params: Parameters<ReturnType<typeof createSwitchStateMachine>['startSwitchOnDistance']>[0],
): Promise<void> {
  if (machine.hasPendingSwitch(params.direction)) {
    await machine.advancePendingSwitch(params);
    return;
  }

  await machine.startSwitchOnDistance(params);
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
    await prepareSeatsForRuntime({
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
    expect(startupSeat.status).toBe('ACTIVATING');
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
        lastSeatActivatedAt: null,
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
    await runtimeAutoSearch.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime,
      canTradeNow: true,
    });

    const runtimeSeat = runtimeRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
    expect(runtimeSeat.status).toBe('ACTIVATING');
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
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: currentTime.getTime(),
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
    const signalBuilder = createSignalBuilder();
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
      enterSwitchingSeat: switchSeatStateManager.enterSwitchingSeat,
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
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: switchLogger.logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween: () => 0,
      getTradingCalendarSnapshot: () => new Map(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1, 100)])),
      }),
    });
    await runDistanceSwitch(switchStateMachine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    const switchedSeat = switchRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
    expect(switchedSeat.status).toBe('ACTIVATING');
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
    await prepareSeatsForRuntime({
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
    expect(startupSeat.status).toBe('ACTIVATING');
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
        lastSeatActivatedAt: null,
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
    await runtimeAutoSearch.maybeSearchOnEvent({
      direction: 'SHORT',
      currentTime,
      canTradeNow: true,
    });

    const runtimeSeat = runtimeRegistry.getSeatState(monitorConfig.monitorSymbol, 'SHORT');
    expect(runtimeSeat.status).toBe('ACTIVATING');
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
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: currentTime.getTime(),
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
    const signalBuilder = createSignalBuilder();
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
      enterSwitchingSeat: switchSeatStateManager.enterSwitchingSeat,
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
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: switchLogger.logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween: () => 0,
      getTradingCalendarSnapshot: () => new Map(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1, 100)])),
      }),
    });
    await runDistanceSwitch(switchStateMachine, {
      direction: 'SHORT',
      monitorPrice: 20_000,
      positions: [],
    });

    const switchedSeat = switchRegistry.getSeatState(monitorConfig.monitorSymbol, 'SHORT');
    expect(switchedSeat.status).toBe('ACTIVATING');
    expect(switchedSeat.symbol).toBe('BEST_BEAR.HK');
    expect(
      switchLogger.infos.some(
        (message) =>
          message.includes('BEST_BEAR.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);
    expect(quoteContext.getCalls('warrantList')).toHaveLength(4);
  });

  it('keeps candidate selection unchanged when safe/danger trigger semantics differ', async () => {
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

    const runtimeLogger = createLoggerRecorder();
    const runtimeRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
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
    await runtimeAutoSearch.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime,
      canTradeNow: true,
    });
    const runtimeSeat = runtimeRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
    expect(runtimeSeat.symbol).toBe('BEST_BULL.HK');

    const safeLogger = createLoggerRecorder();
    const safeSwitchStates = new Map();
    const safeSwitchSuppressions = new Map();
    const safeRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
      longSeat: {
        symbol: 'BEST_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: currentTime.getTime(),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const safeSeatStateManager = createSeatStateManager({
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: safeRegistry,
      switchStates: safeSwitchStates,
      switchSuppressions: safeSwitchSuppressions,
      now: () => currentTime,
      logger: safeLogger.logger,
      getHKDateKey,
    });
    const safeSignalBuilder = createSignalBuilder();
    const safeSwitchMachine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: safeRegistry,
      trader: createTraderDouble({
        getPendingOrders: async () => [],
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 2,
          }),
      }),
      now: () => currentTime,
      switchStates: safeSwitchStates,
      periodicSwitchPending: new Map(),
      resolveSuppression: safeSeatStateManager.resolveSuppression,
      markSuppression: safeSeatStateManager.markSuppression,
      enterSwitchingSeat: safeSeatStateManager.enterSwitchingSeat,
      buildSeatState: safeSeatStateManager.buildSeatState,
      updateSeatState: safeSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: safeLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: createQuoteContextDouble(quoteContext),
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: safeLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: safeSignalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: safeLogger.logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween: () => 0,
      getTradingCalendarSnapshot: () => new Map(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1, 100)])),
      }),
    });
    await runDistanceSwitch(safeSwitchMachine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    const dangerLogger = createLoggerRecorder();
    const dangerSwitchStates = new Map();
    const dangerSwitchSuppressions = new Map();
    const dangerRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
      longSeat: {
        symbol: 'BEST_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: currentTime.getTime(),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const dangerSeatStateManager = createSeatStateManager({
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: dangerRegistry,
      switchStates: dangerSwitchStates,
      switchSuppressions: dangerSwitchSuppressions,
      now: () => currentTime,
      logger: dangerLogger.logger,
      getHKDateKey,
    });
    const dangerSignalBuilder = createSignalBuilder();
    const dangerSwitchMachine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: dangerRegistry,
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
      switchStates: dangerSwitchStates,
      periodicSwitchPending: new Map(),
      resolveSuppression: dangerSeatStateManager.resolveSuppression,
      markSuppression: dangerSeatStateManager.markSuppression,
      enterSwitchingSeat: dangerSeatStateManager.enterSwitchingSeat,
      buildSeatState: dangerSeatStateManager.buildSeatState,
      updateSeatState: dangerSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: dangerLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: createQuoteContextDouble(quoteContext),
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: dangerLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: dangerSignalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: dangerLogger.logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween: () => 0,
      getTradingCalendarSnapshot: () => new Map(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1, 100)])),
      }),
    });
    await runDistanceSwitch(dangerSwitchMachine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    const safeSeat = safeRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
    const dangerSeat = dangerRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
    expect(safeSeat.status).toBe('ACTIVE');
    expect(dangerSeat.status).toBe('ACTIVE');
    expect(safeSeat.symbol).toBe('BEST_BULL.HK');
    expect(dangerSeat.symbol).toBe('BEST_BULL.HK');
    expect(
      safeLogger.infos.some(
        (message) =>
          message.includes('BEST_BULL.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    expect(
      dangerLogger.infos.some(
        (message) =>
          message.includes('BEST_BULL.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);
    expect(quoteContext.getCalls('warrantList')).toHaveLength(3);
  });
});
