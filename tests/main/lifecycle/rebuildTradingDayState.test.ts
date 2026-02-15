/**
 * 交易日状态重建单元测试
 *
 * 覆盖：成功时依次执行 syncAllMonitorContexts、rebuildOrderRecords、rebuildWarrantRiskCache、
 * rebuildUnrealizedLossCache、_recoverOrderTracking、displayAccountAndPositions；
 * 任一步失败时抛出带 [Lifecycle] 重建交易日状态失败 前缀的错误
 */
import { describe, it, expect } from 'bun:test';
import { createRebuildTradingDayState } from '../../../src/main/lifecycle/rebuildTradingDayState.js';
import type { RebuildTradingDayStateDeps } from '../../../src/main/lifecycle/types.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';
import type { Quote } from '../../../src/types/quote.js';
import type { MarketDataClient, RawOrderFromAPI, Trader } from '../../../src/types/services.js';

const emptyQuotesMap = new Map<string, Quote | null>();
const emptyOrders: ReadonlyArray<RawOrderFromAPI> = [];

const emptySeatState = {
  symbol: null as string | null,
  status: 'EMPTY' as const,
  lastSwitchAt: null as number | null,
  lastSearchAt: null as number | null,
  searchFailCountToday: 0,
  frozenTradingDayKey: null as string | null,
};

const mockSymbolRegistry: SymbolRegistry = {
  getSeatState: () => emptySeatState,
  getSeatVersion: () => 0,
  resolveSeatBySymbol: () => null,
  updateSeatState: () => emptySeatState,
  bumpSeatVersion: () => 0,
};

function createRebuildDeps(overrides?: Partial<RebuildTradingDayStateDeps>): RebuildTradingDayStateDeps {
  const trader: Trader = {
    _recoverOrderTracking: async () => {},
  } as unknown as Trader;

  return {
    marketDataClient: {} as MarketDataClient,
    trader,
    lastState: {} as RebuildTradingDayStateDeps['lastState'],
    symbolRegistry: mockSymbolRegistry,
    monitorContexts: new Map<string, MonitorContext>(),
    dailyLossTracker: {} as RebuildTradingDayStateDeps['dailyLossTracker'],
    displayAccountAndPositions: async () => {},
    ...overrides,
  };
}

describe('createRebuildTradingDayState', () => {
  it('无 READY 席位时仍调用 _recoverOrderTracking 与 displayAccountAndPositions', async () => {
    let recoverCalled = false;
    let displayCalled = false;
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        {
          config: { monitorSymbol: 'HSI.HK' },
          symbolRegistry: mockSymbolRegistry,
          orderRecorder: {
            refreshOrdersFromAllOrdersForLong: async () => {},
            refreshOrdersFromAllOrdersForShort: async () => {},
          },
          riskChecker: {
            setWarrantInfoFromCallPrice: () => ({ status: 'ok' as const }),
            refreshWarrantInfoForSymbol: async () => ({ status: 'ok' as const }),
            refreshUnrealizedLossData: async () => {},
          },
          longQuote: null,
          shortQuote: null,
        } as unknown as MonitorContext,
      ],
    ]);
    const deps = createRebuildDeps({
      symbolRegistry: mockSymbolRegistry,
      trader: {
        _recoverOrderTracking: async () => {
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

  it('rebuildOrderRecords 中抛错时抛出带 [Lifecycle] 重建交易日状态失败 前缀的错误', async () => {
    const readySeatState = {
      ...emptySeatState,
      symbol: '12345.HK' as string | null,
      status: 'READY' as const,
    };
    const registryWithReady: SymbolRegistry = {
      ...mockSymbolRegistry,
      getSeatState: () => readySeatState,
      getSeatVersion: () => 1,
    };
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        {
          config: { monitorSymbol: 'HSI.HK' },
          symbolRegistry: registryWithReady,
          orderRecorder: {
            refreshOrdersFromAllOrdersForLong: async () => {
              throw new Error('order refresh fail');
            },
            refreshOrdersFromAllOrdersForShort: async () => {},
          },
          riskChecker: {
            setWarrantInfoFromCallPrice: () => ({ status: 'ok' as const }),
            refreshWarrantInfoForSymbol: async () => ({ status: 'ok' as const }),
            refreshUnrealizedLossData: async () => {},
          },
          longQuote: null,
          shortQuote: null,
        } as unknown as MonitorContext,
      ],
    ]);
    const deps = createRebuildDeps({
      symbolRegistry: registryWithReady,
      monitorContexts,
    });
    const rebuild = createRebuildTradingDayState(deps);

    await expect(
      rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap }),
    ).rejects.toThrow(/\[Lifecycle\] 重建交易日状态失败/);
  });

  it('displayAccountAndPositions 抛错时同样抛出带前缀的错误', async () => {
    const monitorContexts = new Map<string, MonitorContext>();
    const deps = createRebuildDeps({
      monitorContexts,
      displayAccountAndPositions: async () => {
        throw new Error('display fail');
      },
    });
    const rebuild = createRebuildTradingDayState(deps);

    await expect(
      rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap }),
    ).rejects.toThrow(/\[Lifecycle\] 重建交易日状态失败/);
  });
});
