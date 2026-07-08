/**
 * staticLiquidationExecutor 业务测试
 *
 * 功能：
 * - 验证 monitor quote 驱动的静态距回收价清仓执行语义
 * - 复用历史清仓执行态的业务契约
 */
import { describe, expect, it } from 'bun:test';

import { ORDER_QUOTE_RETRY } from '../../../src/constants/index.js';
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

const EXECUTION_TIME_ISO = '2026-04-08T10:00:00+08:00';
const EXECUTION_TIME_MS = new Date(EXECUTION_TIME_ISO).getTime();
const WAIT_RESOLVED_TIME_MS = EXECUTION_TIME_MS + 750;
const EXPECTED_RETRY_AT_MS = EXECUTION_TIME_MS + ORDER_QUOTE_RETRY.INTERVAL_MS;
const EXPECTED_WAIT_RESOLVED_RETRY_AT_MS = WAIT_RESOLVED_TIME_MS + ORDER_QUOTE_RETRY.INTERVAL_MS;

function createExecutorHarness(
  params: {
    readonly executeSignalsSubmittedCount?: number;
    readonly executeSignalsSubmittedCounts?: ReadonlyArray<number>;
    readonly shouldLiquidateLong?: boolean;
    readonly shouldLiquidateShort?: boolean;
    readonly longSeatStatus?: 'EMPTY' | 'SEARCHING' | 'SWITCHING' | 'ACTIVATING' | 'ACTIVE';
    readonly bumpLongSeatVersionAfterSignalBuild?: boolean;
    readonly bumpLongSeatVersionAfterSubmission?: boolean;
    readonly longQuoteAvailable?: boolean;
    readonly shortQuoteAvailable?: boolean;
    readonly monitorQuoteAvailable?: boolean;
    readonly executionMonitorPrice?: number;
    readonly waitResolvedTimeMs?: number;
  } = {},
) {
  const submittedActions: string[] = [];
  const submittedTriggerTimes: number[] = [];
  const liquidationMonitorPrices: number[] = [];
  const clearedOrderSymbols: string[] = [];
  const refreshedSymbols: string[] = [];
  let clearedOrders = 0;
  let refreshUnrealizedCalls = 0;
  let currentNowMs = EXECUTION_TIME_MS;
  let executeSignalsCallIndex = 0;
  let longQuoteAvailable = params.longQuoteAvailable !== false;
  const shortQuoteAvailable = params.shortQuoteAvailable !== false;

  const orderRecorder = createOrderRecorderDouble({
    clearBuyOrders: (symbol) => {
      clearedOrders += 1;
      clearedOrderSymbols.push(symbol);
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
        const shouldLiquidate = isLongSymbol
          ? (params.shouldLiquidateLong ?? true)
          : (params.shouldLiquidateShort ?? false);
        if (shouldLiquidate) {
          return {
            shouldLiquidate: true,
            reason: '触发清仓阈值',
          };
        }

        return {
          shouldLiquidate: false,
        };
      },
      refreshUnrealizedLossData: async (_orderRecorder, symbol) => {
        refreshUnrealizedCalls += 1;
        refreshedSymbols.push(symbol);
        return { r1: 100, n1: 100 };
      },
    }),
  });

  const trader = createTraderDouble({
    executeSignals: async (signals) => {
      for (const signal of signals) {
        submittedActions.push(signal.action);
        if (signal.triggerTime instanceof Date) {
          submittedTriggerTimes.push(signal.triggerTime.getTime());
        }
      }

      if (params.bumpLongSeatVersionAfterSubmission) {
        symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
      }

      return {
        submittedCount:
          params.executeSignalsSubmittedCounts?.[executeSignalsCallIndex++] ??
          params.executeSignalsSubmittedCount ??
          signals.length,
        submittedOrderIds: [],
      };
    },
  });

  const executor = createStaticLiquidationExecutor({
    trader,
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => {
        if (params.waitResolvedTimeMs !== undefined) {
          currentNowMs = params.waitResolvedTimeMs;
        }

        return new Map([
          [
            'HSI.HK',
            params.monitorQuoteAvailable === false
              ? null
              : createQuoteDouble('HSI.HK', params.executionMonitorPrice ?? 20_000, 100),
          ],
          ['BULL.HK', longQuoteAvailable ? createQuoteDouble('BULL.HK', 1, 100) : null],
          ['BEAR.HK', shortQuoteAvailable ? createQuoteDouble('BEAR.HK', 1, 100) : null],
        ]);
      },
    }),
    lastState: {
      positionCache: {
        update: () => {},
        get: (symbol) => {
          if (symbol === 'BULL.HK') {
            return createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 200,
              availableQuantity: 200,
            });
          }

          if (symbol === 'BEAR.HK' && params.shouldLiquidateShort) {
            return createPositionDouble({
              symbol: 'BEAR.HK',
              quantity: 300,
              availableQuantity: 300,
            });
          }

          return null;
        },
      },
    },
    now: () => new Date(currentNowMs),
  });

  return {
    executor,
    monitorContext,
    submittedActions,
    getSubmittedTriggerTimes: () => [...submittedTriggerTimes],
    getLiquidationMonitorPrices: () => [...liquidationMonitorPrices],
    getClearedOrderSymbols: () => [...clearedOrderSymbols],
    getRefreshedSymbols: () => [...refreshedSymbols],
    getClearedOrders: () => clearedOrders,
    getRefreshUnrealizedCalls: () => refreshUnrealizedCalls,
    setLongQuoteAvailable: (available: boolean) => {
      longQuoteAvailable = available;
    },
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
    expect(harness.getSubmittedTriggerTimes()).toEqual([EXECUTION_TIME_MS]);
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
    expect(result.retryAtMs).toBe(EXPECTED_RETRY_AT_MS);
    expect(harness.submittedActions).toEqual([]);
    expect(harness.getClearedOrders()).toBe(0);
    expect(harness.getRefreshUnrealizedCalls()).toBe(0);
  });

  it('anchors WAIT retry time to when the wait decision finishes instead of execution start', async () => {
    const harness = createExecutorHarness({
      monitorQuoteAvailable: false,
      waitResolvedTimeMs: WAIT_RESOLVED_TIME_MS,
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

    expect(result.retryAtMs).toBe(EXPECTED_WAIT_RESOLVED_RETRY_AT_MS);
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
    expect(result.retryAtMs).toBe(EXPECTED_RETRY_AT_MS);
    expect(harness.submittedActions).toEqual([]);
    expect(harness.getClearedOrders()).toBe(0);
    expect(harness.getRefreshUnrealizedCalls()).toBe(0);
  });

  it('still executes the short-side liquidation candidate when long trading quote is unavailable', async () => {
    const harness = createExecutorHarness({
      longQuoteAvailable: false,
      shouldLiquidateLong: false,
      shouldLiquidateShort: true,
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
    expect(harness.submittedActions).toEqual(['SELLPUT']);
    expect(harness.getClearedOrderSymbols()).toEqual(['BEAR.HK']);
    expect(harness.getRefreshedSymbols()).toEqual(['BEAR.HK']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
  });

  it('keeps WAIT ownership after submitting short-side liquidation when long side still needs a quote', async () => {
    const harness = createExecutorHarness({
      longQuoteAvailable: false,
      shouldLiquidateLong: true,
      shouldLiquidateShort: true,
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
    expect(result.retryAtMs).toBe(EXPECTED_RETRY_AT_MS);
    expect(harness.submittedActions).toEqual(['SELLPUT']);
    expect(harness.getClearedOrderSymbols()).toEqual(['BEAR.HK']);
    expect(harness.getRefreshedSymbols()).toEqual(['BEAR.HK']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
  });

  it('keeps WAIT ownership after submitting long-side liquidation when short side still needs a quote', async () => {
    const harness = createExecutorHarness({
      shortQuoteAvailable: false,
      shouldLiquidateLong: true,
      shouldLiquidateShort: true,
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
    expect(result.retryAtMs).toBe(EXPECTED_RETRY_AT_MS);
    expect(harness.submittedActions).toEqual(['SELLCALL']);
    expect(harness.getClearedOrderSymbols()).toEqual(['BULL.HK']);
    expect(harness.getRefreshedSymbols()).toEqual(['BULL.HK']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
  });

  it('retries only the unresolved direction after a mixed submit and WAIT result', async () => {
    const harness = createExecutorHarness({
      longQuoteAvailable: false,
      shouldLiquidateLong: true,
      shouldLiquidateShort: true,
    });
    const submittedDirections = new Set<'LONG' | 'SHORT'>();

    const firstResult = await harness.executor({
      monitorContext: harness.monitorContext,
      event: {
        symbol: 'HSI.HK',
        quote: createQuoteDouble('HSI.HK', 20_000, 100),
      },
      retryAttempts: 0,
      onDirectionSubmitted: (direction) => {
        submittedDirections.add(direction);
      },
    });
    expect(firstResult.kind).toBe('WAIT');
    if (firstResult.kind !== 'WAIT') {
      throw new Error('first result should be WAIT');
    }

    harness.setLongQuoteAvailable(true);
    const secondResult = await harness.executor({
      monitorContext: harness.monitorContext,
      event: {
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', 1, 100),
      },
      retryAttempts: 1,
      excludedDirections: submittedDirections,
      onDirectionSubmitted: (direction) => {
        submittedDirections.add(direction);
      },
    });

    expect(secondResult).toEqual({ kind: 'COMPLETED' });
    expect(harness.submittedActions).toEqual(['SELLPUT', 'SELLCALL']);
    expect(harness.getClearedOrderSymbols()).toEqual(['BEAR.HK', 'BULL.HK']);
    expect(harness.getRefreshedSymbols()).toEqual(['BEAR.HK', 'BULL.HK']);
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

  it('keeps clearing the successfully submitted candidate when later candidate only partially submits', async () => {
    const harness = createExecutorHarness({
      executeSignalsSubmittedCounts: [1, 0],
      shouldLiquidateShort: true,
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
    expect(harness.submittedActions).toEqual(['SELLCALL', 'SELLPUT']);
    expect(harness.getClearedOrderSymbols()).toEqual(['BULL.HK']);
    expect(harness.getRefreshedSymbols()).toEqual(['BULL.HK']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
  });

  it('keeps evaluating later candidates when earlier candidate is not submitted', async () => {
    const harness = createExecutorHarness({
      executeSignalsSubmittedCounts: [0, 1],
      shouldLiquidateShort: true,
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
    expect(harness.submittedActions).toEqual(['SELLCALL', 'SELLPUT']);
    expect(harness.getClearedOrderSymbols()).toEqual(['BEAR.HK']);
    expect(harness.getRefreshedSymbols()).toEqual(['BEAR.HK']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
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

  it('still clears local state when long seatVersion changes after submission returns', async () => {
    const harness = createExecutorHarness({
      bumpLongSeatVersionAfterSubmission: true,
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
    expect(harness.submittedActions).toEqual(['SELLCALL']);
    expect(harness.getClearedOrderSymbols()).toEqual(['BULL.HK']);
    expect(harness.getRefreshedSymbols()).toEqual(['BULL.HK']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
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
