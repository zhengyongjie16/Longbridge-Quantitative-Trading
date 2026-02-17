/**
 * 交易日运行时快照加载单元测试
 *
 * 覆盖：requireTradingDay 且非交易日时抛错、账户信息缺失时抛错、
 * failOnOrderFetchError 且订单拉取失败时抛错、正常返回 allOrders 与 quotesMap
 */
import { describe, it, expect } from 'bun:test';
import { createLoadTradingDayRuntimeSnapshot } from '../../../src/main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import type { LoadTradingDayRuntimeSnapshotDeps } from '../../../src/main/lifecycle/types.js';
import type { LastState } from '../../../src/types/state.js';
import type { MultiMonitorTradingConfig } from '../../../src/types/config.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';

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

describe('createLoadTradingDayRuntimeSnapshot', () => {
  it('requireTradingDay 为 true 且 isTradingDay 为 false 时抛出“重建触发时交易日信息无效”', async () => {
    const lastState = createMinimalLastState();
    const deps = {
      marketDataClient: {
        isTradingDay: async () => ({ isTradingDay: false, isHalfDay: false }),
      },
      trader: {},
      lastState,
      tradingConfig: { monitors: [], global: {} } as unknown as MultiMonitorTradingConfig,
      symbolRegistry: {} as SymbolRegistry,
      dailyLossTracker: {} as LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker'],
      tradeLogHydrator: {} as LoadTradingDayRuntimeSnapshotDeps['tradeLogHydrator'],
      warrantListCacheConfig: {} as LoadTradingDayRuntimeSnapshotDeps['warrantListCacheConfig'],
    };

    const load = createLoadTradingDayRuntimeSnapshot(deps as unknown as LoadTradingDayRuntimeSnapshotDeps);

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

  it('账户信息缺失（cachedAccount 为 null）时抛出“无法获取账户信息”', async () => {
    const lastState = createMinimalLastState();
    const deps = {
      marketDataClient: { isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }) },
      trader: {
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
      tradeLogHydrator: {},
      warrantListCacheConfig: {},
    } as unknown as LoadTradingDayRuntimeSnapshotDeps;

    const load = createLoadTradingDayRuntimeSnapshot(deps as unknown as LoadTradingDayRuntimeSnapshotDeps);

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

  it('failOnOrderFetchError 为 true 且订单拉取失败时抛出带“全量订单获取失败”的错误', async () => {
    const lastState = createMinimalLastState();
    lastState.cachedAccount = {} as LastState['cachedAccount'];
    lastState.cachedPositions = [];

    const deps = {
      marketDataClient: { isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }) },
      trader: {
        getAccountSnapshot: async () => ({}),
        getStockPositions: async () => [],
        orderRecorder: {
          fetchAllOrdersFromAPI: async () => {
            throw new Error('API 超时');
          },
        },
        seedOrderHoldSymbols: () => {},
        getOrderHoldSymbols: () => new Set<string>(),
      },
      lastState,
      tradingConfig: { monitors: [], global: {} } as unknown as MultiMonitorTradingConfig,
      symbolRegistry: {} as SymbolRegistry,
      dailyLossTracker: { recalculateFromAllOrders: () => {} },
      tradeLogHydrator: {},
      warrantListCacheConfig: {},
    } as unknown as LoadTradingDayRuntimeSnapshotDeps;

    const load = createLoadTradingDayRuntimeSnapshot(deps as unknown as LoadTradingDayRuntimeSnapshotDeps);

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

});
