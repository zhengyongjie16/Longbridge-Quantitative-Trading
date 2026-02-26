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
import { createRebuildTradingDayState } from '../../../src/main/lifecycle/rebuildTradingDayState.js';
import { getHKDateKey, listHKDateKeysBetween } from '../../../src/utils/helpers/tradingTime.js';
import type { RebuildTradingDayStateDeps } from '../../../src/main/lifecycle/types.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';
import type { Quote } from '../../../src/types/quote.js';
import type {
  MarketDataClient,
  OrderRecord,
  RawOrderFromAPI,
  Trader,
  TradingDaysResult,
} from '../../../src/types/services.js';

const emptyQuotesMap = new Map<string, Quote | null>();
const emptyOrders: ReadonlyArray<RawOrderFromAPI> = [];

const emptySeatState = {
  symbol: null as string | null,
  status: 'EMPTY' as const,
  lastSwitchAt: null as number | null,
  lastSearchAt: null as number | null,
  lastSeatReadyAt: null,
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
  seatStatus: 'READY' | 'EMPTY',
  symbol: string = 'BULL.HK',
): SymbolRegistry {
  const readySeatState =
    seatStatus === 'READY'
      ? {
          ...emptySeatState,
          symbol,
          status: 'READY' as const,
        }
      : emptySeatState;

  return {
    getSeatState: () => readySeatState,
    getSeatVersion: () => 1,
    resolveSeatBySymbol: () => null,
    updateSeatState: () => readySeatState,
    bumpSeatVersion: () => 1,
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
  onRefreshLong?: () => Promise<void>;
}): MonitorContext {
  const {
    symbolRegistry,
    monitorSymbol = 'HSI.HK',
    buyOrders = [],
    onRefreshLong = async () => {},
  } = params;

  return {
    config: { monitorSymbol },
    symbolRegistry,
    orderRecorder: {
      refreshOrdersFromAllOrdersForLong: onRefreshLong,
      refreshOrdersFromAllOrdersForShort: async () => {},
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
    recoverOrderTracking: async () => {},
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
    displayAccountAndPositions: async () => {},
    ...overrides,
  };
}

describe('createRebuildTradingDayState', () => {
  it('无 READY 席位时仍调用 recoverOrderTracking 与 displayAccountAndPositions', async () => {
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
        recoverOrderTracking: async () => {
          recoverCalled = true;
        },
      } as unknown as Trader,
      displayAccountAndPositions: async () => {
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
    const registry = createSymbolRegistry('READY');
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
    const earliestRequestedMs = Math.min(...tradingDayCalls.map((call) => call.startDate.getTime()));
    expect(earliestRequestedMs).toBeGreaterThan(oldExecutedTime);
  });

  it('存在仍持仓老单时，预热起点回溯到该老单成交时间', async () => {
    const oldOpenOrderTime = new Date('2025-12-15T03:00:00.000Z').getTime();
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('READY');
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
    const earliestRequestedMs = Math.min(...tradingDayCalls.map((call) => call.startDate.getTime()));
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
    const registry = createSymbolRegistry('READY');
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
      const startMonthKey = getHKDateKey(call.startDate)?.slice(0, 7) ?? null;
      const endMonthKey = getHKDateKey(call.endDate)?.slice(0, 7) ?? null;
      expect(startMonthKey).toBe(endMonthKey);
    }
  });

  it('最近一年边界按毫秒判断，同日更早时刻也应判定为超限', async () => {
    const now = new Date('2026-02-20T12:00:00.000Z');
    const earliestAllowedMs = now.getTime() - 365 * TIME.MILLISECONDS_PER_DAY;
    const openOrderTime = earliestAllowedMs - 60 * 60 * 1000;
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('READY');
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
    const registry = createSymbolRegistry('READY');
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
    const registry = createSymbolRegistry('READY');
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          symbolRegistry: registry,
          buyOrders: [
            createBuyOrder(Date.now() - 2 * TIME.MILLISECONDS_PER_DAY, 'BULL.HK'),
          ],
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
      displayAccountAndPositions: async () => {
        throw new Error('display fail');
      },
    });
    const rebuild = createRebuildTradingDayState(deps);

    expect(rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap })).rejects.toThrow(
      /\[Lifecycle\] 重建交易日状态失败/,
    );
  });
});
