/**
 * 交易日运行时快照加载单元测试
 *
 * 覆盖：requireTradingDay 且非交易日时抛错、账户信息缺失时抛错、
 * failOnOrderFetchError 且订单拉取失败时抛错、正常返回 allOrders 与 quotesMap
 */
import { describe, it, expect } from 'bun:test';
import { OrderSide, OrderStatus, OrderType, WarrantStatus, WarrantType } from 'longbridge';
import { createLoadTradingDayRuntimeSnapshot } from '../../../src/main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import { createQuoteContextMock } from '../../../mock/longbridge/quoteContextMock.js';
import { toMockDecimal } from '../../../mock/longbridge/decimal.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import { TRADING } from '../../../src/constants/index.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
} from '../../../src/main/lifecycle/types.js';
import type { LastState, MonitorState } from '../../../src/types/state.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../../src/core/trader/protectiveLiquidationEpisodeTracker/types.js';
import type { ProtectiveOrderParams } from './types.js';
import { createTradingConfig as createTradingConfigFactory } from '../../../mock/factories/configFactory.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createPositionCacheDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteContextDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

function getEntry(_key: string): undefined {
  return;
}

function getInFlight(_key: string): undefined {
  return;
}

function createMinimalLastState(): LastState {
  return {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    currentDayKey: null,
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    monitorStates: new Map<string, MonitorState>(),
    allTradingSymbols: new Set<string>(),
  };
}

function createTradingConfig(
  monitors: LoadTradingDayRuntimeSnapshotDeps['tradingConfig']['monitors'] = [],
): LoadTradingDayRuntimeSnapshotDeps['tradingConfig'] {
  return createTradingConfigFactory({ monitors });
}

function createWarrantListCacheConfig(): LoadTradingDayRuntimeSnapshotDeps['warrantListCacheConfig'] {
  return {
    cache: {
      getEntry,
      setEntry: () => {},
      getInFlight,
      setInFlight: () => {},
      deleteInFlight: () => {},
      clear: () => {},
    },
    ttlMs: 60_000,
    nowMs: () => Date.now(),
  };
}

function createBaseDeps(
  overrides: Partial<LoadTradingDayRuntimeSnapshotDeps> = {},
): LoadTradingDayRuntimeSnapshotDeps {
  const tradingConfig = overrides.tradingConfig ?? createTradingConfig();

  return {
    marketDataClient: overrides.marketDataClient ?? createMarketDataClientDouble(),
    trader: overrides.trader ?? createTraderDouble(),
    lastState: overrides.lastState ?? createMinimalLastState(),
    tradingConfig,
    symbolRegistry: overrides.symbolRegistry ?? createSymbolRegistry(tradingConfig.monitors),
    dailyLossTracker: overrides.dailyLossTracker ?? createDailyLossTrackerDouble(),
    protectiveLiquidationEpisodeTracker:
      overrides.protectiveLiquidationEpisodeTracker ??
      createProtectiveLiquidationEpisodeTrackerDouble(),
    tradeLogHydrator: overrides.tradeLogHydrator ?? { hydrate: () => new Map<string, number>() },
    warrantListCacheConfig: overrides.warrantListCacheConfig ?? createWarrantListCacheConfig(),
  };
}

function createReadyTrader(
  overrides: Partial<LoadTradingDayRuntimeSnapshotDeps['trader']> = {},
): LoadTradingDayRuntimeSnapshotDeps['trader'] {
  return createTraderDouble({
    getAccountSnapshot: async () => createAccountSnapshotDouble(100_000),
    getStockPositions: async () => [],
    fetchAllOrdersFromAPI: async () => [],
    ...overrides,
  });
}

function createLoadParams(
  overrides: Partial<LoadTradingDayRuntimeSnapshotParams> = {},
): LoadTradingDayRuntimeSnapshotParams {
  return {
    requireTradingDay: false,
    failOnOrderFetchError: false,
    resetRuntimeSubscriptions: false,
    hydrateCooldownFromTradeLog: false,
    forceOrderRefresh: false,
    ...overrides,
    now: overrides.now ?? new Date(),
  };
}

function createProtectiveMonitor(): LoadTradingDayRuntimeSnapshotDeps['tradingConfig']['monitors'][number] {
  return createMonitorConfigDouble({
    monitorSymbol: 'HSI.HK',
    orderOwnershipMapping: ['HSI'],
  });
}

function createAutoSearchMonitor(): LoadTradingDayRuntimeSnapshotDeps['tradingConfig']['monitors'][number] {
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

function createProtectiveOrder(params: ProtectiveOrderParams): RawOrderFromAPI {
  return {
    orderId: params.orderId,
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    side: OrderSide.Sell,
    status: params.status,
    orderType: OrderType.MO,
    remark: 'AUTO|PL',
    price: params.price,
    quantity: params.quantity,
    executedPrice: params.executedPrice,
    executedQuantity: params.executedQuantity,
    submittedAt: new Date(params.updatedAtMs - 30_000),
    updatedAt: new Date(params.updatedAtMs),
  };
}

function createBoundaryCaptureDailyLossTracker(
  onCapture: (
    protectionBoundaryByDirection: NonNullable<
      Parameters<
        LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker']['recalculateFromAllOrders']
      >[3]
    >,
  ) => void,
): LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker'] {
  return createDailyLossTrackerDouble({
    recalculateFromAllOrders: (_allOrders, _monitors, _now, protectionBoundaryByDirection) => {
      if (protectionBoundaryByDirection === undefined) {
        return;
      }

      onCapture(protectionBoundaryByDirection);
    },
  });
}

function createProtectiveTrackerRecorder(): {
  readonly tracker: ProtectiveLiquidationEpisodeTracker;
  readonly restoreCompletedCalls: Array<
    Parameters<ProtectiveLiquidationEpisodeTracker['restoreCompletedBoundary']>[0]
  >;
  readonly restoreInProgressCalls: Array<
    Parameters<ProtectiveLiquidationEpisodeTracker['restoreInProgressEpisode']>[0]
  >;
} {
  const boundaryByDirection = new Map<string, number>();
  const restoreCompletedCalls: Array<
    Parameters<ProtectiveLiquidationEpisodeTracker['restoreCompletedBoundary']>[0]
  > = [];
  const restoreInProgressCalls: Array<
    Parameters<ProtectiveLiquidationEpisodeTracker['restoreInProgressEpisode']>[0]
  > = [];

  return {
    tracker: createProtectiveLiquidationEpisodeTrackerDouble({
      restoreCompletedBoundary: (params) => {
        restoreCompletedCalls.push(params);
        boundaryByDirection.set(
          `${params.monitorSymbol}:${params.direction}`,
          params.boundaryExecutedTimeMs,
        );
      },
      restoreInProgressEpisode: (params) => {
        restoreInProgressCalls.push(params);
      },
      getLatestProtectionBoundaryByDirection: () => new Map(boundaryByDirection),
      resetAll: () => {
        boundaryByDirection.clear();
      },
    }),
    restoreCompletedCalls,
    restoreInProgressCalls,
  };
}

describe('createLoadTradingDayRuntimeSnapshot', () => {
  it('requireTradingDay 为 true 且 isTradingDay 为 false 时抛出"重建触发时交易日信息无效"', async () => {
    const deps = createBaseDeps({
      marketDataClient: createMarketDataClientDouble({
        isTradingDay: async () => ({ isTradingDay: false, isHalfDay: false }),
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    expect(load(createLoadParams({ requireTradingDay: true }))).rejects.toThrow(
      '重建触发时交易日信息无效',
    );
  });

  it('账户信息缺失（cachedAccount 为 null）时抛出"无法获取账户信息"', async () => {
    const deps = createBaseDeps({
      trader: createTraderDouble({
        getAccountSnapshot: async () => null,
        getStockPositions: async () => [],
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    expect(load(createLoadParams())).rejects.toThrow('无法获取账户信息');
  });

  it('持仓快照拉取失败时 fail-fast，不能按空持仓继续重建', async () => {
    let fetchAllOrdersCalled = false;
    const deps = createBaseDeps({
      trader: createReadyTrader({
        getStockPositions: async () => {
          throw new Error('positions unavailable');
        },
        fetchAllOrdersFromAPI: async () => {
          fetchAllOrdersCalled = true;
          return [];
        },
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    let caughtError: unknown = null;
    try {
      await load(createLoadParams());
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toMatch(/无法刷新账户和持仓信息/);
    expect(fetchAllOrdersCalled).toBe(false);
  });

  it('failOnOrderFetchError 为 true 且订单拉取失败时抛出带"全量订单获取失败"的错误', async () => {
    const deps = createBaseDeps({
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => {
          throw new Error('API 超时');
        },
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    expect(load(createLoadParams({ failOnOrderFetchError: true }))).rejects.toThrow(
      /全量订单获取失败/,
    );
  });

  it('only runs startup auto-search after continuous session and morning delay are both satisfied', async () => {
    const monitor = createAutoSearchMonitor();
    const tradingConfig = createTradingConfig([monitor]);
    const quoteContext = createQuoteContextMock();
    quoteContext.seedWarrantList('HSI.HK', [
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

    let isTradingDayCalls = 0;
    const marketDataClient = createMarketDataClientDouble({
      getQuoteContext: async () => createQuoteContextDouble(quoteContext),
      isTradingDay: async () => {
        isTradingDayCalls += 1;
        return { isTradingDay: true, isHalfDay: false };
      },
    });
    const blockedLastState = createMinimalLastState();
    blockedLastState.cachedTradingDayInfo = {
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    };
    const blockedDeps = createBaseDeps({
      lastState: blockedLastState,
      tradingConfig,
      marketDataClient,
      trader: createReadyTrader(),
      symbolRegistry: createSymbolRegistry(tradingConfig.monitors),
    });
    const blockedLoad = createLoadTradingDayRuntimeSnapshot(blockedDeps);
    await blockedLoad(
      createLoadParams({
        now: new Date('2026-02-16T01:31:00.000Z'),
        requireTradingDay: false,
      }),
    );

    expect(isTradingDayCalls).toBe(0);
    expect(quoteContext.getCalls('warrantList')).toHaveLength(0);

    const allowedLastState = createMinimalLastState();
    allowedLastState.cachedTradingDayInfo = {
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    };
    const allowedDeps = createBaseDeps({
      lastState: allowedLastState,
      tradingConfig,
      marketDataClient,
      trader: createReadyTrader(),
      symbolRegistry: createSymbolRegistry(tradingConfig.monitors),
    });
    const allowedLoad = createLoadTradingDayRuntimeSnapshot(allowedDeps);
    await allowedLoad(
      createLoadParams({
        now: new Date('2026-02-16T01:35:00.000Z'),
        requireTradingDay: false,
      }),
    );

    expect(isTradingDayCalls).toBe(0);
    expect(quoteContext.getCalls('warrantList')).toHaveLength(2);
    expect(allowedDeps.symbolRegistry.getSeatState('HSI.HK', 'LONG').status).toBe('ACTIVATING');
    expect(allowedDeps.symbolRegistry.getSeatState('HSI.HK', 'SHORT').status).toBe('ACTIVATING');
  });

  it('load 阶段不再承担交易日历预热职责', async () => {
    const now = new Date('2026-02-25T03:00:00.000Z');
    let getTradingDaysCalls = 0;
    const lastState = createMinimalLastState();

    const deps = createBaseDeps({
      lastState,
      marketDataClient: createMarketDataClientDouble({
        getTradingDays: async () => {
          getTradingDaysCalls += 1;
          return {
            tradingDays: [],
            halfTradingDays: [],
          };
        },
      }),
      trader: createReadyTrader(),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    await load(
      createLoadParams({
        now,
        requireTradingDay: true,
      }),
    );

    expect(getTradingDaysCalls).toBe(0);
    expect(lastState.tradingCalendarSnapshot).toBeUndefined();
  });

  it('subscribes candlesticks and leaves seeded local cache snapshots observable', async () => {
    const monitors = [
      createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' }),
      createMonitorConfigDouble({ monitorSymbol: 'HHI.HK' }),
    ];
    const subscribedSymbols: string[] = [];
    const seededBySymbol = new Set<string>();
    const marketDataClient = createMarketDataClientDouble({
      subscribeCandlesticks: async (symbol) => {
        subscribedSymbols.push(symbol);
        seededBySymbol.add(symbol);
        return [
          {
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1000,
            timestamp: new Date('2026-02-25T01:00:00.000Z'),
          },
        ] as never;
      },
      getCandlestickSnapshot: (symbol, period) => {
        if (!seededBySymbol.has(symbol)) {
          return null;
        }

        return {
          symbol,
          period,
          version: 1,
          candles: [
            {
              open: 100,
              high: 101,
              low: 99,
              close: 100,
              volume: 1000,
              timestamp: Date.parse('2026-02-25T01:00:00.000Z'),
            },
          ],
          lastBarTimestamp: Date.parse('2026-02-25T01:00:00.000Z'),
          lastBarConfirmed: null,
          initialized: true,
        };
      },
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitors),
      marketDataClient,
      trader: createReadyTrader(),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(createLoadParams({ requireTradingDay: true }));

    expect(subscribedSymbols).toEqual(['HSI.HK', 'HHI.HK']);
    expect(
      marketDataClient.getCandlestickSnapshot('HSI.HK', TRADING.CANDLE_PERIOD)?.initialized,
    ).toBe(true);

    expect(
      marketDataClient.getCandlestickSnapshot('HHI.HK', TRADING.CANDLE_PERIOD)?.initialized,
    ).toBe(true);
  });

  it('hydrateCooldownFromTradeLog=true 时先 hydrate 再 recalculate', async () => {
    const now = new Date('2026-02-25T03:00:00.000Z');
    const callOrder: string[] = [];
    const allOrders: ReadonlyArray<RawOrderFromAPI> = [];

    const deps = createBaseDeps({
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => allOrders,
      }),
      dailyLossTracker: createDailyLossTrackerDouble({
        recalculateFromAllOrders: (receivedOrders, _monitors, _now, receivedSegments) => {
          callOrder.push('recalculate');
          expect(receivedOrders).toBe(allOrders);
          expect(receivedSegments).toBeInstanceOf(Map);
        },
      }),
      tradeLogHydrator: {
        hydrate: () => {
          callOrder.push('hydrate');
          return new Map();
        },
      },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(
      createLoadParams({
        now,
        hydrateCooldownFromTradeLog: true,
      }),
    );

    expect(callOrder).toEqual(['hydrate', 'recalculate']);
  });

  it('restores protective boundary from canceled protective order with executed quantity', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const executedAtMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const protectiveOrder = createProtectiveOrder({
      orderId: 'protective-canceled-1',
      status: OrderStatus.Canceled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 10,
      updatedAtMs: executedAtMs,
    });

    const deps = createBaseDeps({
      lastState,
      tradingConfig: createTradingConfig([monitor]),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
      }),
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: { hydrate: () => new Map() },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(createLoadParams({ now }));

    expect(restoreCompletedCalls).toHaveLength(1);
    expect(restoreCompletedCalls[0]).toEqual({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      boundaryExecutedTimeMs: executedAtMs,
    });
    expect(restoreInProgressCalls).toHaveLength(0);
    expect(receivedBoundaryMap?.get('HSI.HK:LONG')).toBe(executedAtMs);
  });

  it('restores in-progress protective episode for partial-filled pending order', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const executedAtMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const protectiveOrder = createProtectiveOrder({
      orderId: 'protective-partial-1',
      status: OrderStatus.PartialFilled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 5,
      updatedAtMs: executedAtMs,
    });

    const deps = createBaseDeps({
      lastState,
      tradingConfig: createTradingConfig([monitor]),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
      }),
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: { hydrate: () => new Map() },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(createLoadParams({ now }));

    expect(restoreCompletedCalls).toHaveLength(0);
    expect(restoreInProgressCalls).toHaveLength(1);
    expect(restoreInProgressCalls[0]).toEqual({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      symbol: 'BULL.HK',
      latestExecutedTimeMs: executedAtMs,
    });
    expect(receivedBoundaryMap?.size).toBe(0);
  });

  it('restores completed boundary and in-progress episode together when both coexist in same direction', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const completedBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const pendingLatestExecutedMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const completedOrder = createProtectiveOrder({
      orderId: 'protective-completed-1',
      status: OrderStatus.Canceled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 10,
      updatedAtMs: completedBoundaryMs,
    });
    const pendingOrder = createProtectiveOrder({
      orderId: 'protective-pending-1',
      status: OrderStatus.PartialFilled,
      price: 8.8,
      quantity: 10,
      executedPrice: 8.8,
      executedQuantity: 5,
      updatedAtMs: pendingLatestExecutedMs,
    });

    const deps = createBaseDeps({
      lastState,
      tradingConfig: createTradingConfig([monitor]),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [completedOrder, pendingOrder],
      }),
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => new Map([['HSI.HK:LONG', completedBoundaryMs]]),
      },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(
      createLoadParams({
        now,
        hydrateCooldownFromTradeLog: true,
      }),
    );

    expect(restoreCompletedCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        boundaryExecutedTimeMs: completedBoundaryMs,
      },
    ]);

    expect(restoreInProgressCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.HK',
        latestExecutedTimeMs: pendingLatestExecutedMs,
      },
    ]);
    expect(receivedBoundaryMap?.get('HSI.HK:LONG')).toBe(completedBoundaryMs);
  });

  it('advances restored completed boundary when a newer completed protective fill exists and direction is flat', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const hydratedBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const newerCompletedFillMs = Date.parse('2026-03-13T02:35:00.000Z');
    const monitor = createProtectiveMonitor();
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls } = createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const completedOrder = createProtectiveOrder({
      orderId: 'protective-completed-newer-1',
      status: OrderStatus.Canceled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 10,
      updatedAtMs: newerCompletedFillMs,
    });

    const deps = createBaseDeps({
      lastState,
      tradingConfig: createTradingConfig([monitor]),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [completedOrder],
      }),
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => new Map([['HSI.HK:LONG', hydratedBoundaryMs]]),
      },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(
      createLoadParams({
        now,
        hydrateCooldownFromTradeLog: true,
      }),
    );

    expect(restoreCompletedCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        boundaryExecutedTimeMs: hydratedBoundaryMs,
      },
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        boundaryExecutedTimeMs: newerCompletedFillMs,
      },
    ]);
    expect(receivedBoundaryMap?.get('HSI.HK:LONG')).toBe(newerCompletedFillMs);
  });
});
