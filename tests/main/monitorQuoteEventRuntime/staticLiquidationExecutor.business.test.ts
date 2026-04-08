/**
 * staticLiquidationExecutor 业务测试
 *
 * 功能：
 * - 验证 monitor quote 驱动的静态距回收价清仓执行语义
 * - 复用历史清仓执行态的业务契约
 */
import { describe, expect, it } from 'bun:test';

import { createStaticLiquidationExecutor } from '../../../src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.js';
import { createMonitorConfig } from '../../../mock/factories/configFactory.js';
import {
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

function createExecutorHarness(
  params: {
    readonly executeSignalsSubmittedCount?: number;
    readonly shouldLiquidateLong?: boolean;
    readonly longSeatStatus?: 'EMPTY' | 'SEARCHING' | 'SWITCHING' | 'ACTIVATING' | 'ACTIVE';
    readonly bumpLongSeatVersionAfterSignalBuild?: boolean;
    readonly bumpLongSeatVersionAfterSubmission?: boolean;
    readonly longQuoteAvailable?: boolean;
    readonly monitorQuoteAvailable?: boolean;
    readonly executionMonitorPrice?: number;
  } = {},
) {
  const submittedActions: string[] = [];
  const liquidationMonitorPrices: number[] = [];
  let clearedOrders = 0;
  let refreshUnrealizedCalls = 0;

  const orderRecorder = createOrderRecorderDouble({
    clearBuyOrders: () => {
      clearedOrders += 1;
    },
  });

  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: 'HSI.HK',
    longSeat: {
      symbol: 'BULL.HK',
      status: params.longSeatStatus ?? 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });
  let shouldBumpLongSeatVersionOnNextRead = params.bumpLongSeatVersionAfterSignalBuild ?? false;
  const symbolRegistryWithVersionRace = {
    ...symbolRegistry,
    getSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => {
      const version = symbolRegistry.getSeatVersion(monitorSymbol, direction);
      if (direction === 'LONG' && shouldBumpLongSeatVersionOnNextRead) {
        shouldBumpLongSeatVersionOnNextRead = false;
        symbolRegistry.bumpSeatVersion(monitorSymbol, direction);
      }

      return version;
    },
  };

  const monitorContext = createMonitorContextDouble({
    config: createMonitorConfig({
      monitorSymbol: 'HSI.HK',
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
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    }),
    symbolRegistry: symbolRegistryWithVersionRace,
    seatVersion: {
      long: 1,
      short: 1,
    },
    orderRecorder,
    riskChecker: createRiskCheckerDouble({
      checkWarrantDistanceLiquidation: (_symbol, isLongSymbol, monitorCurrentPrice) => {
        liquidationMonitorPrices.push(monitorCurrentPrice);
        if (isLongSymbol ? (params.shouldLiquidateLong ?? true) : false) {
          return {
            shouldLiquidate: true,
            reason: '触发清仓阈值',
          };
        }

        return {
          shouldLiquidate: false,
        };
      },
      refreshUnrealizedLossData: async () => {
        refreshUnrealizedCalls += 1;
        return { r1: 100, n1: 100 };
      },
    }),
  });

  const trader = createTraderDouble({
    executeSignals: async (signals) => {
      for (const signal of signals) {
        submittedActions.push(signal.action);
      }

      if (params.bumpLongSeatVersionAfterSubmission) {
        symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
      }

      return {
        submittedCount: params.executeSignalsSubmittedCount ?? signals.length,
        submittedOrderIds: [],
      };
    },
  });

  const executor = createStaticLiquidationExecutor({
    trader,
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          [
            'HSI.HK',
            params.monitorQuoteAvailable === false
              ? null
              : createQuoteDouble('HSI.HK', params.executionMonitorPrice ?? 20_000, 100),
          ],
          [
            'BULL.HK',
            params.longQuoteAvailable === false ? null : createQuoteDouble('BULL.HK', 1, 100),
          ],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 1, 100)],
        ]),
    }),
    lastState: {
      positionCache: {
        update: () => {},
        get: (symbol) => {
          if (symbol !== 'BULL.HK') {
            return null;
          }

          return createPositionDouble({
            symbol: 'BULL.HK',
            quantity: 200,
            availableQuantity: 200,
          });
        },
      },
    },
  });

  return {
    executor,
    monitorContext,
    submittedActions,
    getLiquidationMonitorPrices: () => [...liquidationMonitorPrices],
    getClearedOrders: () => clearedOrders,
    getRefreshUnrealizedCalls: () => refreshUnrealizedCalls,
  };
}

describe('staticLiquidationExecutor', () => {
  it('executes static liquidation with fresh execution monitor quote instead of event monitor quote', async () => {
    const harness = createExecutorHarness({
      executionMonitorPrice: 19_500,
    });

    const result = await harness.executor({
      monitorContext: harness.monitorContext,
      event: {
        symbol: 'HSI.HK',
        quote: createQuoteDouble('HSI.HK', 20_000, 100),
      },
      retryAttempts: 0,
    });

    expect(result).toEqual({ kind: 'COMPLETED' });
    expect(harness.getLiquidationMonitorPrices()).toEqual([19_500]);
    expect(harness.submittedActions).toEqual(['SELLCALL']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
  });

  it('returns WAIT with monitor and trading wakeup symbols when execution monitor quote is unavailable', async () => {
    const harness = createExecutorHarness({
      monitorQuoteAvailable: false,
    });

    const result = await harness.executor({
      monitorContext: harness.monitorContext,
      event: {
        symbol: 'HSI.HK',
        quote: createQuoteDouble('HSI.HK', 20_000, 100),
      },
      retryAttempts: 0,
    });

    expect(result.kind).toBe('WAIT');
    if (result.kind !== 'WAIT') {
      throw new Error('result should be WAIT');
    }

    expect(result.wakeupSymbols).toEqual(['HSI.HK', 'BULL.HK', 'BEAR.HK']);
    expect(typeof result.retryAtMs).toBe('number');
    expect(harness.submittedActions).toEqual([]);
    expect(harness.getClearedOrders()).toBe(0);
    expect(harness.getRefreshUnrealizedCalls()).toBe(0);
  });

  it('returns WAIT with monitor and trading wakeup symbols when long trading quote is unavailable', async () => {
    const harness = createExecutorHarness({
      longQuoteAvailable: false,
    });

    const result = await harness.executor({
      monitorContext: harness.monitorContext,
      event: {
        symbol: 'HSI.HK',
        quote: createQuoteDouble('HSI.HK', 20_000, 100),
      },
      retryAttempts: 0,
    });

    expect(result.kind).toBe('WAIT');
    if (result.kind !== 'WAIT') {
      throw new Error('result should be WAIT');
    }

    expect(result.wakeupSymbols).toEqual(['HSI.HK', 'BULL.HK', 'BEAR.HK']);
    expect(typeof result.retryAtMs).toBe('number');
    expect(harness.submittedActions).toEqual([]);
    expect(harness.getClearedOrders()).toBe(0);
    expect(harness.getRefreshUnrealizedCalls()).toBe(0);
  });

  it('returns NOOP instead of WAIT when long side has position but liquidation is not triggered', async () => {
    const harness = createExecutorHarness({
      shouldLiquidateLong: false,
    });

    const result = await harness.executor({
      monitorContext: harness.monitorContext,
      event: {
        symbol: 'HSI.HK',
        quote: createQuoteDouble('HSI.HK', 20_000, 100),
      },
      retryAttempts: 0,
    });

    expect(result).toEqual({ kind: 'NOOP' });
    expect(harness.submittedActions).toEqual([]);
    expect(harness.getClearedOrders()).toBe(0);
    expect(harness.getRefreshUnrealizedCalls()).toBe(0);
  });

  it('does not clear caches when long seatVersion changes before submission settles', async () => {
    const harness = createExecutorHarness({
      bumpLongSeatVersionAfterSignalBuild: true,
    });

    await harness.executor({
      monitorContext: harness.monitorContext,
      event: {
        symbol: 'HSI.HK',
        quote: createQuoteDouble('HSI.HK', 20_000, 100),
      },
      retryAttempts: 0,
    });

    expect(harness.submittedActions).toEqual([]);
    expect(harness.getClearedOrders()).toBe(0);
    expect(harness.getRefreshUnrealizedCalls()).toBe(0);
  });

  it('skips cache mutation when long seatVersion changes after submission returns', async () => {
    const harness = createExecutorHarness({
      bumpLongSeatVersionAfterSubmission: true,
    });

    await harness.executor({
      monitorContext: harness.monitorContext,
      event: {
        symbol: 'HSI.HK',
        quote: createQuoteDouble('HSI.HK', 20_000, 100),
      },
      retryAttempts: 0,
    });

    expect(harness.submittedActions).toEqual(['SELLCALL']);
    expect(harness.getClearedOrders()).toBe(0);
    expect(harness.getRefreshUnrealizedCalls()).toBe(0);
  });

  it('skips cache mutation when long seat is no longer active at execution time', async () => {
    const harness = createExecutorHarness({
      longSeatStatus: 'SWITCHING',
    });

    await harness.executor({
      monitorContext: harness.monitorContext,
      event: {
        symbol: 'HSI.HK',
        quote: createQuoteDouble('HSI.HK', 20_000, 100),
      },
      retryAttempts: 0,
    });

    expect(harness.submittedActions).toEqual([]);
    expect(harness.getClearedOrders()).toBe(0);
    expect(harness.getRefreshUnrealizedCalls()).toBe(0);
  });
});
