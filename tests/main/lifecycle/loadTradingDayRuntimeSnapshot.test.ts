/**
 * 交易日运行时快照加载单元测试
 *
 * 覆盖：requireTradingDay 且非交易日时抛错、账户信息缺失时抛错、
 * failOnOrderFetchError 且订单拉取失败时抛错、正常返回 allOrders 与 quotesMap
 */
import { describe, it, expect } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createLoadTradingDayRuntimeSnapshot } from '../../../src/main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import type { LoadTradingDayRuntimeSnapshotDeps } from '../../../src/main/lifecycle/types.js';
import type { LastState } from '../../../src/types/state.js';
import type { MultiMonitorTradingConfig } from '../../../src/types/config.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../../src/core/trader/protectiveLiquidationEpisodeTracker/types.js';
import { createMonitorConfigDouble } from '../../helpers/testDoubles.js';

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
    positionCache: { update: () => {}, get: () => null },
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  } as unknown as LastState;
}

function createProtectiveEpisodeTrackerDouble(): ProtectiveLiquidationEpisodeTracker {
  return {
    recordProtectiveFillProgress: () => {},
    completeIfEligible: () => null,
    restoreCompletedBoundary: () => {},
    restoreInProgressEpisode: () => {},
    getLatestProtectionBoundaryByDirection: () => new Map(),
    getInProgressEpisodes: () => [],
    resetAll: () => {},
  };
}

describe('createLoadTradingDayRuntimeSnapshot', () => {
  it('requireTradingDay 为 true 且 isTradingDay 为 false 时抛出"重建触发时交易日信息无效"', async () => {
    const lastState = createMinimalLastState();
    const deps = {
      marketDataClient: {
        isTradingDay: async () => ({ isTradingDay: false, isHalfDay: false }),
      },
      trader: {
        initializeOrderMonitor: async () => {},
      },
      lastState,
      tradingConfig: { monitors: [], global: {} } as unknown as MultiMonitorTradingConfig,
      symbolRegistry: {} as SymbolRegistry,
      dailyLossTracker: {} as LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker'],
      protectiveLiquidationEpisodeTracker: createProtectiveEpisodeTrackerDouble(),
      tradeLogHydrator: {} as LoadTradingDayRuntimeSnapshotDeps['tradeLogHydrator'],
      warrantListCacheConfig: {} as LoadTradingDayRuntimeSnapshotDeps['warrantListCacheConfig'],
    };

    const load = createLoadTradingDayRuntimeSnapshot(
      deps as unknown as LoadTradingDayRuntimeSnapshotDeps,
    );

    expect(
      load({
        now: new Date(),
        requireTradingDay: true,
        failOnOrderFetchError: false,
        resetRuntimeSubscriptions: false,
        hydrateCooldownFromTradeLog: false,
        forceOrderRefresh: false,
      }),
    ).rejects.toThrow('重建触发时交易日信息无效');
  });

  it('账户信息缺失（cachedAccount 为 null）时抛出"无法获取账户信息"', async () => {
    const lastState = createMinimalLastState();
    const deps = {
      marketDataClient: { isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }) },
      trader: {
        initializeOrderMonitor: async () => {},
        getAccountSnapshot: async () => null,
        getStockPositions: async () => [],
        orderRecorder: {},
        seedOrderHoldSymbols: () => {},
        getOrderHoldSymbols: () => new Set<string>(),
      },
      lastState,
      tradingConfig: { monitors: [], global: {} } as unknown as MultiMonitorTradingConfig,
      symbolRegistry: {} as SymbolRegistry,
      dailyLossTracker: { recalculateFromAllOrders: () => {} },
      protectiveLiquidationEpisodeTracker: createProtectiveEpisodeTrackerDouble(),
      tradeLogHydrator: {},
      warrantListCacheConfig: {},
    } as unknown as LoadTradingDayRuntimeSnapshotDeps;

    const load = createLoadTradingDayRuntimeSnapshot(
      deps as unknown as LoadTradingDayRuntimeSnapshotDeps,
    );

    expect(
      load({
        now: new Date(),
        requireTradingDay: false,
        failOnOrderFetchError: false,
        resetRuntimeSubscriptions: false,
        hydrateCooldownFromTradeLog: false,
        forceOrderRefresh: false,
      }),
    ).rejects.toThrow('无法获取账户信息');
  });

  it('failOnOrderFetchError 为 true 且订单拉取失败时抛出带"全量订单获取失败"的错误', async () => {
    const lastState = createMinimalLastState();
    lastState.cachedAccount = {} as LastState['cachedAccount'];
    lastState.cachedPositions = [];

    const deps = {
      marketDataClient: { isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }) },
      trader: {
        initializeOrderMonitor: async () => {},
        getAccountSnapshot: async () => ({}),
        getStockPositions: async () => [],
        fetchAllOrdersFromAPI: async () => {
          throw new Error('API 超时');
        },
        seedOrderHoldSymbols: () => {},
        getOrderHoldSymbols: () => new Set<string>(),
      },
      lastState,
      tradingConfig: { monitors: [], global: {} } as unknown as MultiMonitorTradingConfig,
      symbolRegistry: {} as SymbolRegistry,
      dailyLossTracker: { recalculateFromAllOrders: () => {} },
      protectiveLiquidationEpisodeTracker: createProtectiveEpisodeTrackerDouble(),
      tradeLogHydrator: {},
      warrantListCacheConfig: {},
    } as unknown as LoadTradingDayRuntimeSnapshotDeps;

    const load = createLoadTradingDayRuntimeSnapshot(
      deps as unknown as LoadTradingDayRuntimeSnapshotDeps,
    );

    expect(
      load({
        now: new Date(),
        requireTradingDay: false,
        failOnOrderFetchError: true,
        resetRuntimeSubscriptions: false,
        hydrateCooldownFromTradeLog: false,
        forceOrderRefresh: false,
      }),
    ).rejects.toThrow(/全量订单获取失败/);
  });

  it('load 阶段不再承担交易日历预热职责', async () => {
    const now = new Date('2026-02-25T03:00:00.000Z');
    let getTradingDaysCalls = 0;

    const lastState = createMinimalLastState();
    const deps = {
      marketDataClient: {
        getQuoteContext: async () => ({}),
        getQuotes: async () => new Map<string, null>(),
        subscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        resetRuntimeSubscriptionsAndCaches: async () => {},
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
        getTradingDays: async () => {
          getTradingDaysCalls += 1;
          return {
            tradingDays: [],
            halfTradingDays: [],
          };
        },
      },
      trader: {
        initializeOrderMonitor: async () => {},
        getAccountSnapshot: async () => ({}),
        getStockPositions: async () => [],
        fetchAllOrdersFromAPI: async () => [],
        seedOrderHoldSymbols: () => {},
        getOrderHoldSymbols: () => new Set<string>(),
      },
      lastState,
      tradingConfig: { monitors: [], global: {} } as unknown as MultiMonitorTradingConfig,
      symbolRegistry: {} as SymbolRegistry,
      dailyLossTracker: { recalculateFromAllOrders: () => {} },
      protectiveLiquidationEpisodeTracker: createProtectiveEpisodeTrackerDouble(),
      tradeLogHydrator: { hydrate: () => new Map() },
      warrantListCacheConfig: {},
    } as unknown as LoadTradingDayRuntimeSnapshotDeps;

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    await load({
      now,
      requireTradingDay: true,
      failOnOrderFetchError: false,
      resetRuntimeSubscriptions: false,
      hydrateCooldownFromTradeLog: false,
      forceOrderRefresh: false,
    });

    expect(getTradingDaysCalls).toBe(0);
    expect(lastState.tradingCalendarSnapshot).toBeUndefined();
  });

  it('hydrateCooldownFromTradeLog=true 时先 hydrate 再 recalculate', async () => {
    const now = new Date('2026-02-25T03:00:00.000Z');
    const callOrder: string[] = [];
    const allOrders: never[] = [];

    const lastState = createMinimalLastState();
    const deps = {
      marketDataClient: {
        getQuoteContext: async () => ({}),
        getQuotes: async () => new Map<string, null>(),
        subscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        resetRuntimeSubscriptionsAndCaches: async () => {},
      },
      trader: {
        initializeOrderMonitor: async () => {},
        getAccountSnapshot: async () => ({}),
        getStockPositions: async () => [],
        fetchAllOrdersFromAPI: async () => allOrders,
        seedOrderHoldSymbols: () => {},
        getOrderHoldSymbols: () => new Set<string>(),
      },
      lastState,
      tradingConfig: {
        monitors: [],
        global: {},
      } as unknown as MultiMonitorTradingConfig,
      symbolRegistry: {} as SymbolRegistry,
      dailyLossTracker: {
        recalculateFromAllOrders: (
          receivedOrders: ReadonlyArray<never>,
          _monitors: ReadonlyArray<{
            monitorSymbol: string;
            orderOwnershipMapping: unknown[];
          }>,
          _now: Date,
          receivedSegments?: ReadonlyMap<string, number>,
        ) => {
          callOrder.push('recalculate');
          expect(receivedOrders).toBe(allOrders);
          expect(receivedSegments).toBeInstanceOf(Map);
        },
      },
      protectiveLiquidationEpisodeTracker: createProtectiveEpisodeTrackerDouble(),
      tradeLogHydrator: {
        hydrate: () => {
          callOrder.push('hydrate');
          return new Map();
        },
      },
      warrantListCacheConfig: {},
    } as unknown as LoadTradingDayRuntimeSnapshotDeps;

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load({
      now,
      requireTradingDay: false,
      failOnOrderFetchError: false,
      resetRuntimeSubscriptions: false,
      hydrateCooldownFromTradeLog: true,
      forceOrderRefresh: false,
    });

    expect(callOrder).toEqual(['hydrate', 'recalculate']);
  });

  it('restores protective boundary from canceled protective order with executed quantity', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const executedAtMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      orderOwnershipMapping: ['HSI'],
      autoSearchConfig: {
        autoSearchEnabled: false,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
    });
    const symbolRegistry = createSymbolRegistry([monitor]);
    const lastState = createMinimalLastState();
    const boundaryByDirection = new Map<string, number>();
    const restoreCompletedCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      boundaryExecutedTimeMs: number;
    }> = [];
    const restoreInProgressCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      latestExecutedTimeMs: number;
    }> = [];
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const protectiveTracker: ProtectiveLiquidationEpisodeTracker = {
      recordProtectiveFillProgress: () => {},
      completeIfEligible: () => null,
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
      getInProgressEpisodes: () => [],
      resetAll: () => {
        boundaryByDirection.clear();
      },
    };

    const protectiveOrder = {
      orderId: 'protective-canceled-1',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      side: OrderSide.Sell,
      status: OrderStatus.Canceled,
      orderType: OrderType.MO,
      remark: 'AUTO|PL',
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 10,
      submittedAt: new Date(executedAtMs - 30_000),
      updatedAt: new Date(executedAtMs),
    };

    const deps: LoadTradingDayRuntimeSnapshotDeps = {
      marketDataClient: {
        getQuoteContext: async () => ({}),
        getQuotes: async () => new Map<string, null>(),
        subscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        resetRuntimeSubscriptionsAndCaches: async () => {},
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
      } as unknown as LoadTradingDayRuntimeSnapshotDeps['marketDataClient'],
      trader: {
        initializeOrderMonitor: async () => {},
        getAccountSnapshot: async () => ({}),
        getStockPositions: async () => [],
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
        seedOrderHoldSymbols: () => {},
        getOrderHoldSymbols: () => new Set<string>(),
      } as unknown as LoadTradingDayRuntimeSnapshotDeps['trader'],
      lastState,
      tradingConfig: {
        monitors: [monitor],
        global: {},
      } as unknown as MultiMonitorTradingConfig,
      symbolRegistry,
      dailyLossTracker: {
        recalculateFromAllOrders: (
          _allOrders: ReadonlyArray<unknown>,
          _monitors: ReadonlyArray<{
            monitorSymbol: string;
            orderOwnershipMapping: ReadonlyArray<string>;
          }>,
          _now: Date,
          protectionBoundaryByDirection?: ReadonlyMap<string, number>,
        ): void => {
          receivedBoundaryMap = protectionBoundaryByDirection;
        },
      } as unknown as LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker'],
      protectiveLiquidationEpisodeTracker: protectiveTracker,
      tradeLogHydrator: { hydrate: () => new Map() },
      warrantListCacheConfig:
        {} as unknown as LoadTradingDayRuntimeSnapshotDeps['warrantListCacheConfig'],
    };

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load({
      now,
      requireTradingDay: false,
      failOnOrderFetchError: false,
      resetRuntimeSubscriptions: false,
      hydrateCooldownFromTradeLog: false,
      forceOrderRefresh: false,
    });

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
    const monitor = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      orderOwnershipMapping: ['HSI'],
      autoSearchConfig: {
        autoSearchEnabled: false,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
    });
    const symbolRegistry = createSymbolRegistry([monitor]);
    const lastState = createMinimalLastState();
    const boundaryByDirection = new Map<string, number>();
    const restoreCompletedCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      boundaryExecutedTimeMs: number;
    }> = [];
    const restoreInProgressCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      latestExecutedTimeMs: number;
    }> = [];
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const protectiveTracker: ProtectiveLiquidationEpisodeTracker = {
      recordProtectiveFillProgress: () => {},
      completeIfEligible: () => null,
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
      getInProgressEpisodes: () => [],
      resetAll: () => {
        boundaryByDirection.clear();
      },
    };

    const protectiveOrder = {
      orderId: 'protective-partial-1',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      orderType: OrderType.MO,
      remark: 'AUTO|PL',
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 5,
      submittedAt: new Date(executedAtMs - 30_000),
      updatedAt: new Date(executedAtMs),
    };

    const deps: LoadTradingDayRuntimeSnapshotDeps = {
      marketDataClient: {
        getQuoteContext: async () => ({}),
        getQuotes: async () => new Map<string, null>(),
        subscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        resetRuntimeSubscriptionsAndCaches: async () => {},
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
      } as unknown as LoadTradingDayRuntimeSnapshotDeps['marketDataClient'],
      trader: {
        initializeOrderMonitor: async () => {},
        getAccountSnapshot: async () => ({}),
        getStockPositions: async () => [],
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
        seedOrderHoldSymbols: () => {},
        getOrderHoldSymbols: () => new Set<string>(),
      } as unknown as LoadTradingDayRuntimeSnapshotDeps['trader'],
      lastState,
      tradingConfig: {
        monitors: [monitor],
        global: {},
      } as unknown as MultiMonitorTradingConfig,
      symbolRegistry,
      dailyLossTracker: {
        recalculateFromAllOrders: (
          _allOrders: ReadonlyArray<unknown>,
          _monitors: ReadonlyArray<{
            monitorSymbol: string;
            orderOwnershipMapping: ReadonlyArray<string>;
          }>,
          _now: Date,
          protectionBoundaryByDirection?: ReadonlyMap<string, number>,
        ): void => {
          receivedBoundaryMap = protectionBoundaryByDirection;
        },
      } as unknown as LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker'],
      protectiveLiquidationEpisodeTracker: protectiveTracker,
      tradeLogHydrator: { hydrate: () => new Map() },
      warrantListCacheConfig:
        {} as unknown as LoadTradingDayRuntimeSnapshotDeps['warrantListCacheConfig'],
    };

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load({
      now,
      requireTradingDay: false,
      failOnOrderFetchError: false,
      resetRuntimeSubscriptions: false,
      hydrateCooldownFromTradeLog: false,
      forceOrderRefresh: false,
    });

    expect(restoreCompletedCalls).toHaveLength(0);
    expect(restoreInProgressCalls).toHaveLength(1);
    expect(restoreInProgressCalls[0]).toEqual({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      latestExecutedTimeMs: executedAtMs,
    });
    expect(receivedBoundaryMap?.size).toBe(0);
  });

  it('restores completed boundary and in-progress episode together when both coexist in same direction', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const completedBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const pendingLatestExecutedMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      orderOwnershipMapping: ['HSI'],
      autoSearchConfig: {
        autoSearchEnabled: false,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
    });
    const symbolRegistry = createSymbolRegistry([monitor]);
    const lastState = createMinimalLastState();
    const boundaryByDirection = new Map<string, number>();
    const restoreCompletedCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      boundaryExecutedTimeMs: number;
    }> = [];
    const restoreInProgressCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      latestExecutedTimeMs: number;
    }> = [];
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const protectiveTracker: ProtectiveLiquidationEpisodeTracker = {
      recordProtectiveFillProgress: () => {},
      completeIfEligible: () => null,
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
      getInProgressEpisodes: () => [],
      resetAll: () => {
        boundaryByDirection.clear();
      },
    };

    const completedOrder = {
      orderId: 'protective-completed-1',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      side: OrderSide.Sell,
      status: OrderStatus.Canceled,
      orderType: OrderType.MO,
      remark: 'AUTO|PL',
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 10,
      submittedAt: new Date(completedBoundaryMs - 30_000),
      updatedAt: new Date(completedBoundaryMs),
    };
    const pendingOrder = {
      orderId: 'protective-pending-1',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      orderType: OrderType.MO,
      remark: 'AUTO|PL',
      price: 8.8,
      quantity: 10,
      executedPrice: 8.8,
      executedQuantity: 5,
      submittedAt: new Date(pendingLatestExecutedMs - 30_000),
      updatedAt: new Date(pendingLatestExecutedMs),
    };

    const deps: LoadTradingDayRuntimeSnapshotDeps = {
      marketDataClient: {
        getQuoteContext: async () => ({}),
        getQuotes: async () => new Map<string, null>(),
        subscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        resetRuntimeSubscriptionsAndCaches: async () => {},
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
      } as unknown as LoadTradingDayRuntimeSnapshotDeps['marketDataClient'],
      trader: {
        initializeOrderMonitor: async () => {},
        getAccountSnapshot: async () => ({}),
        getStockPositions: async () => [],
        fetchAllOrdersFromAPI: async () => [completedOrder, pendingOrder],
        seedOrderHoldSymbols: () => {},
        getOrderHoldSymbols: () => new Set<string>(),
      } as unknown as LoadTradingDayRuntimeSnapshotDeps['trader'],
      lastState,
      tradingConfig: {
        monitors: [monitor],
        global: {},
      } as unknown as MultiMonitorTradingConfig,
      symbolRegistry,
      dailyLossTracker: {
        recalculateFromAllOrders: (
          _allOrders: ReadonlyArray<unknown>,
          _monitors: ReadonlyArray<{
            monitorSymbol: string;
            orderOwnershipMapping: ReadonlyArray<string>;
          }>,
          _now: Date,
          protectionBoundaryByDirection?: ReadonlyMap<string, number>,
        ): void => {
          receivedBoundaryMap = protectionBoundaryByDirection;
        },
      } as unknown as LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker'],
      protectiveLiquidationEpisodeTracker: protectiveTracker,
      tradeLogHydrator: {
        hydrate: () => new Map([['HSI.HK:LONG', completedBoundaryMs]]),
      },
      warrantListCacheConfig:
        {} as unknown as LoadTradingDayRuntimeSnapshotDeps['warrantListCacheConfig'],
    };

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load({
      now,
      requireTradingDay: false,
      failOnOrderFetchError: false,
      resetRuntimeSubscriptions: false,
      hydrateCooldownFromTradeLog: true,
      forceOrderRefresh: false,
    });

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
        latestExecutedTimeMs: pendingLatestExecutedMs,
      },
    ]);
    expect(receivedBoundaryMap?.get('HSI.HK:LONG')).toBe(completedBoundaryMs);
  });
});
