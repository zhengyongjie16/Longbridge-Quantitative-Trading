/**
 * 交易日状态重建单元测试
 *
 * 覆盖：
 * - 重建主链路（订单重建 → 日历预热 → 风险缓存 → 恢复追踪 → 展示）
 * - 交易日历预热按“仍持仓买单”确定起点，并按自然月分块查询
 * - 预热失败时重建 fail-fast
 */
import { describe, it, expect } from 'bun:test';
import { TIME } from '../../../src/constants/index.js';
import {
  captureSeatActivationCarryover,
  clearSeatActivationCarryover,
} from '../../../src/main/lifecycle/seatActivationCarryover.js';
import { createRebuildTradingDayState } from '../../../src/main/lifecycle/rebuildTradingDayState.js';
import { listHKDateKeysBetween } from '../../../src/main/lifecycle/utils.js';
import type { RebuildTradingDayStateDeps } from '../../../src/main/lifecycle/types.js';
import type { MultiMonitorTradingConfig } from '../../../src/types/config.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { SeatState, SymbolRegistry } from '../../../src/types/seat.js';
import type { Quote } from '../../../src/types/quote.js';
import { getHKDateKey, getRequiredHKDateKey } from '../../../src/utils/time/index.js';
import type {
  MarketDataClient,
  OrderRecord,
  RawOrderFromAPI,
  Trader,
  TradingDaysResult,
} from '../../../src/types/services.js';
import { createSymbolRegistryDouble } from '../../helpers/testDoubles.js';

const emptyQuotesMap = new Map<string, Quote | null>();
const emptyOrders: ReadonlyArray<RawOrderFromAPI> = [];
const emptySeatState = {
  symbol: null as string | null,
  status: 'EMPTY' as const,
  lastSwitchAt: null as number | null,
  lastSearchAt: null as number | null,
  lastSeatActivatedAt: null,
  searchFailCountToday: 0,
  frozenTradingDayKey: null as string | null,
};
function createMinimalLastState(): RebuildTradingDayStateDeps['lastState'] {
  return {
    tradingCalendarSnapshot: new Map(),
    cachedTradingDayInfo: null,
  } as unknown as RebuildTradingDayStateDeps['lastState'];
}

function createSymbolRegistry(
  seatStatus: 'ACTIVE' | 'EMPTY',
  symbol: string = 'BULL.HK',
): SymbolRegistry {
  let readySeatState: SeatState =
    seatStatus === 'ACTIVE'
      ? {
          ...emptySeatState,
          symbol,
          status: 'ACTIVE' as const,
        }
      : emptySeatState;
  return {
    getSeatState: () => readySeatState,
    getSeatVersion: () => 1,
    resolveSeatBySymbol: () => null,
    updateSeatState: (
      _monitorSymbol: string,
      _direction: 'LONG' | 'SHORT',
      nextState: SeatState,
    ) => {
      readySeatState = nextState;
      return readySeatState;
    },
    updateSeatStateWithVersionBump: (
      _monitorSymbol: string,
      _direction: 'LONG' | 'SHORT',
      nextState: SeatState,
    ) => {
      readySeatState = nextState;
      return { seatState: readySeatState, seatVersion: 2 };
    },
    bumpSeatVersion: () => 1,
    onSeatStateChanged: () => () => {},
    onSeatVersionChanged: () => () => {},
    onSeatTruthChanged: () => {
      throw new Error('rebuildTradingDayState test must not subscribe to seat truth events');
    },
  };
}

function createBuyOrder(executedTime: number, symbol: string): OrderRecord {
  return {
    orderId: `BUY-${executedTime}`,
    symbol,
    executedPrice: 1,
    executedQuantity: 100,
    executedTime,
    submittedAt: new Date(executedTime),
    updatedAt: new Date(executedTime),
  };
}

function createMonitorContext(params: {
  symbolRegistry: SymbolRegistry;
  monitorSymbol?: string;
  buyOrders?: ReadonlyArray<OrderRecord>;
  onRefreshLong?: (
    symbol: string,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    quote?: Quote | null,
  ) => Promise<ReadonlyArray<OrderRecord>>;
}): MonitorContext {
  const {
    symbolRegistry,
    monitorSymbol = 'HSI.HK',
    buyOrders = [],
    onRefreshLong = async () => [],
  } = params;
  return {
    config: { monitorSymbol },
    symbolRegistry,
    orderRecorder: {
      refreshOrdersFromAllOrdersForLong: onRefreshLong,
      refreshOrdersFromAllOrdersForShort: async () => [],
      getBuyOrdersForSymbol: () => buyOrders,
    },
    riskChecker: {
      setWarrantInfoFromCallPrice: () => ({ status: 'ok' as const }),
      refreshWarrantInfoForSymbol: async () => ({ status: 'ok' as const }),
      refreshUnrealizedLossData: async () => {},
    },
    longQuote: null,
    shortQuote: null,
    monitorQuote: null,
  } as unknown as MonitorContext;
}

function createCarryoverTradingConfig(): MultiMonitorTradingConfig {
  return {
    monitors: [{ monitorSymbol: 'HSI.HK' } as unknown as MultiMonitorTradingConfig['monitors'][0]],
    global: {} as MultiMonitorTradingConfig['global'],
  };
}

function createDefaultMarketDataClient(
  tradingDayCalls: Array<{ startDate: Date; endDate: Date }>,
): MarketDataClient {
  return {
    getTradingDays: async (startDate: Date, endDate: Date): Promise<TradingDaysResult> => {
      tradingDayCalls.push({ startDate, endDate });
      return {
        tradingDays: listHKDateKeysBetween(startDate.getTime(), endDate.getTime()),
        halfTradingDays: [],
      };
    },
    isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
  } as unknown as MarketDataClient;
}

function createRebuildDeps(
  overrides?: Partial<RebuildTradingDayStateDeps>,
): RebuildTradingDayStateDeps {
  const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
  const trader: Trader = {
    recoverOrderTrackingFromSnapshot: async () => {},
  } as unknown as Trader;
  return {
    marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
    trader,
    lastState: createMinimalLastState(),
    symbolRegistry: createSymbolRegistry('EMPTY'),
    monitorContexts: new Map<string, MonitorContext>(),
    dailyLossTracker: {
      getLossOffset: () => 0,
    } as unknown as RebuildTradingDayStateDeps['dailyLossTracker'],
    displayAccountAndPositions: () => {},
    ...overrides,
  };
}
describe('createRebuildTradingDayState', () => {
  it('无 ACTIVE 席位时仍调用 recoverOrderTrackingFromSnapshot 与 displayAccountAndPositions', async () => {
    let recoverCalled = false;
    let displayCalled = false;
    const registry = createSymbolRegistry('EMPTY');
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          symbolRegistry: registry,
        }),
      ],
    ]);
    const deps = createRebuildDeps({
      symbolRegistry: registry,
      trader: {
        recoverOrderTrackingFromSnapshot: async () => {
          recoverCalled = true;
        },
      } as unknown as Trader,
      displayAccountAndPositions: () => {
        displayCalled = true;
      },
      monitorContexts,
    });
    const rebuild = createRebuildTradingDayState(deps);
    await rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap });
    expect(recoverCalled).toBe(true);
    expect(displayCalled).toBe(true);
  });

  it('仅存在已平仓历史订单时，预热起点不会回溯到历史订单时间', async () => {
    const oldExecutedTime = new Date('2024-01-05T03:00:00.000Z').getTime();
    const now = new Date('2026-02-20T03:00:00.000Z');
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          symbolRegistry: registry,
          buyOrders: [],
        }),
      ],
    ]);
    const deps = createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContexts,
    });
    const rebuild = createRebuildTradingDayState(deps);
    await rebuild({
      allOrders: [
        {
          orderId: 'HISTORY-001',
          symbol: 'BULL.HK',
          stockName: 'Bull',
          side: 'Buy',
          status: 'Filled',
          orderType: 'LO',
          price: 1,
          quantity: 100,
          executedPrice: 1,
          executedQuantity: 100,
          submittedAt: new Date(oldExecutedTime),
          updatedAt: new Date(oldExecutedTime),
        } as unknown as RawOrderFromAPI,
      ],
      quotesMap: emptyQuotesMap,
      now,
    });
    expect(tradingDayCalls.length).toBeGreaterThan(0);
    const earliestRequestedMs = Math.min(
      ...tradingDayCalls.map((call) => call.startDate.getTime()),
    );
    expect(earliestRequestedMs).toBeGreaterThan(oldExecutedTime);
  });

  it('存在仍持仓老单时，预热起点回溯到该老单成交时间', async () => {
    const oldOpenOrderTime = new Date('2025-12-15T03:00:00.000Z').getTime();
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          symbolRegistry: registry,
          buyOrders: [createBuyOrder(oldOpenOrderTime, 'BULL.HK')],
        }),
      ],
    ]);
    const lastState = createMinimalLastState();
    const deps = createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContexts,
      lastState,
    });
    const rebuild = createRebuildTradingDayState(deps);
    await rebuild({
      allOrders: emptyOrders,
      quotesMap: emptyQuotesMap,
      now: new Date('2026-02-20T03:00:00.000Z'),
    });
    expect(tradingDayCalls.length).toBeGreaterThan(0);
    const earliestRequestedMs = Math.min(
      ...tradingDayCalls.map((call) => call.startDate.getTime()),
    );
    expect(earliestRequestedMs).toBeLessThanOrEqual(oldOpenOrderTime);
    const oldOrderDateKey = getHKDateKey(new Date(oldOpenOrderTime));
    expect(oldOrderDateKey).not.toBeNull();
    if (oldOrderDateKey) {
      expect(lastState.tradingCalendarSnapshot?.has(oldOrderDateKey)).toBe(true);
    }
  });

  it('交易日历查询会按自然月分块，不跨月请求', async () => {
    const openOrderTime = new Date('2025-11-15T03:00:00.000Z').getTime();
    const now = new Date('2026-02-20T03:00:00.000Z');
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          symbolRegistry: registry,
          buyOrders: [createBuyOrder(openOrderTime, 'BULL.HK')],
        }),
      ],
    ]);
    const deps = createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContexts,
    });
    const rebuild = createRebuildTradingDayState(deps);
    await rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap, now });
    expect(tradingDayCalls.length).toBeGreaterThan(1);
    for (const call of tradingDayCalls) {
      const startMonthKey = getRequiredHKDateKey(call.startDate).slice(0, 7);
      const endMonthKey = getRequiredHKDateKey(call.endDate).slice(0, 7);
      expect(startMonthKey).toBe(endMonthKey);
    }
  });

  it('最近一年边界按毫秒判断，同日更早时刻也应判定为超限', async () => {
    const now = new Date('2026-02-20T12:00:00.000Z');
    const earliestAllowedMs = now.getTime() - 365 * TIME.MILLISECONDS_PER_DAY;
    const openOrderTime = earliestAllowedMs - 60 * 60 * 1000;
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          symbolRegistry: registry,
          buyOrders: [createBuyOrder(openOrderTime, 'BULL.HK')],
        }),
      ],
    ]);
    const deps = createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContexts,
    });
    const rebuild = createRebuildTradingDayState(deps);
    let caughtError: unknown = null;
    try {
      await rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap, now });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toMatch(/\[Lifecycle\] 重建交易日状态失败/);
    expect(tradingDayCalls.length).toBe(0);
  });

  it('rebuildOrderRecords 中抛错时抛出带 [Lifecycle] 重建交易日状态失败 前缀的错误', async () => {
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          symbolRegistry: registry,
          onRefreshLong: async () => {
            throw new Error('order refresh fail');
          },
        }),
      ],
    ]);
    const deps = createRebuildDeps({
      symbolRegistry: registry,
      monitorContexts,
    });
    const rebuild = createRebuildTradingDayState(deps);
    expect(rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap })).rejects.toThrow(
      /\[Lifecycle\] 重建交易日状态失败/,
    );
  });

  it('交易日历预热失败时，rebuildTradingDayState 会抛错', async () => {
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          symbolRegistry: registry,
          buyOrders: [createBuyOrder(Date.now() - 2 * TIME.MILLISECONDS_PER_DAY, 'BULL.HK')],
        }),
      ],
    ]);
    const deps = createRebuildDeps({
      marketDataClient: {
        getTradingDays: async () => {
          throw new Error('calendar api fail');
        },
      } as unknown as MarketDataClient,
      symbolRegistry: registry,
      monitorContexts,
    });
    const rebuild = createRebuildTradingDayState(deps);
    expect(rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap })).rejects.toThrow(
      /\[Lifecycle\] 重建交易日状态失败/,
    );
  });

  it('displayAccountAndPositions 抛错时同样抛出带前缀的错误', async () => {
    const deps = createRebuildDeps({
      displayAccountAndPositions: () => {
        throw new Error('display fail');
      },
    });
    const rebuild = createRebuildTradingDayState(deps);
    expect(rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap })).rejects.toThrow(
      /\[Lifecycle\] 重建交易日状态失败/,
    );
  });

  it('open rebuild 恢复出同一 symbol 时保留前一交易日的 lastSeatActivatedAt', async () => {
    const carriedActivatedAt = Date.parse('2026-02-16T07:59:00.000Z');
    const rebuildNow = new Date('2026-02-17T01:31:00.000Z');
    const registry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        ...emptySeatState,
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSeatActivatedAt: carriedActivatedAt,
      },
      shortSeat: emptySeatState,
    });
    captureSeatActivationCarryover({
      tradingConfig: createCarryoverTradingConfig(),
      symbolRegistry: registry,
    });

    registry.updateSeatState('HSI.HK', 'LONG', {
      ...emptySeatState,
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVATING',
      lastSeatActivatedAt: null,
    });

    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          symbolRegistry: registry,
        }),
      ],
    ]);
    const rebuild = createRebuildTradingDayState(
      createRebuildDeps({
        symbolRegistry: registry,
        monitorContexts,
      }),
    );

    await rebuild({
      allOrders: emptyOrders,
      quotesMap: emptyQuotesMap,
      now: rebuildNow,
    });

    expect(registry.getSeatState('HSI.HK', 'LONG').lastSeatActivatedAt).toBe(carriedActivatedAt);
    clearSeatActivationCarryover(registry);
  });

  it('open rebuild 恢复出新 symbol 时重置为本次重建激活时间', async () => {
    const carriedActivatedAt = Date.parse('2026-02-16T07:59:00.000Z');
    const rebuildNow = new Date('2026-02-17T01:31:00.000Z');
    const registry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        ...emptySeatState,
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSeatActivatedAt: carriedActivatedAt,
      },
      shortSeat: emptySeatState,
    });
    captureSeatActivationCarryover({
      tradingConfig: createCarryoverTradingConfig(),
      symbolRegistry: registry,
    });

    registry.updateSeatState('HSI.HK', 'LONG', {
      ...emptySeatState,
      symbol: 'NEW_BULL.HK',
      status: 'ACTIVATING',
      lastSeatActivatedAt: null,
    });

    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          symbolRegistry: registry,
        }),
      ],
    ]);
    const rebuild = createRebuildTradingDayState(
      createRebuildDeps({
        symbolRegistry: registry,
        monitorContexts,
      }),
    );

    await rebuild({
      allOrders: emptyOrders,
      quotesMap: emptyQuotesMap,
      now: rebuildNow,
    });

    expect(registry.getSeatState('HSI.HK', 'LONG').lastSeatActivatedAt).toBe(rebuildNow.getTime());
    expect(registry.getSeatState('HSI.HK', 'LONG').lastSeatActivatedAt).not.toBe(
      carriedActivatedAt,
    );

    clearSeatActivationCarryover(registry);
  });

  it('跨多个非交易日等待 open rebuild 时仍保留旧 carryover，后续同 symbol rebuild 继续使用原激活时间', async () => {
    const carriedActivatedAt = Date.parse('2026-02-16T07:59:00.000Z');
    const rebuildNow = new Date('2026-02-18T01:31:00.000Z');
    const registry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        ...emptySeatState,
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSeatActivatedAt: carriedActivatedAt,
      },
      shortSeat: emptySeatState,
    });
    const tradingConfig = createCarryoverTradingConfig();
    captureSeatActivationCarryover({
      tradingConfig,
      symbolRegistry: registry,
    });

    registry.updateSeatState('HSI.HK', 'LONG', {
      ...emptySeatState,
      status: 'EMPTY',
      symbol: null,
      lastSeatActivatedAt: null,
    });

    captureSeatActivationCarryover({
      tradingConfig,
      symbolRegistry: registry,
    });

    captureSeatActivationCarryover({
      tradingConfig,
      symbolRegistry: registry,
    });

    registry.updateSeatState('HSI.HK', 'LONG', {
      ...emptySeatState,
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVATING',
      lastSeatActivatedAt: null,
    });

    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          symbolRegistry: registry,
        }),
      ],
    ]);
    const rebuild = createRebuildTradingDayState(
      createRebuildDeps({
        symbolRegistry: registry,
        monitorContexts,
      }),
    );

    await rebuild({
      allOrders: emptyOrders,
      quotesMap: emptyQuotesMap,
      now: rebuildNow,
    });

    expect(registry.getSeatState('HSI.HK', 'LONG').lastSeatActivatedAt).toBe(carriedActivatedAt);
    clearSeatActivationCarryover(registry);
  });
});
