/**
 * MonitorQuoteEventRuntime 业务测试
 *
 * 功能：
 * - 验证 monitor quote 事件运行时的公开默认工厂与生产行为契约
 */
import { describe, expect, it } from 'bun:test';
import {
  createAutoSymbolManagerDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import { createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createDefaultMonitorQuoteEventRuntime } from '../../../src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import type {
  CreateDefaultMonitorQuoteEventRuntimeDeps,
  MonitorQuoteEventRuntime,
} from '../../../src/main/monitorQuoteEventRuntime/types.js';
import type { StartSwitchOnDistanceResult } from '../../../src/types/monitorContextPorts.js';
import type { QuoteUpdatedEvent } from '../../../src/types/services.js';

type MonitorQuoteFreshnessDeps =
  CreateDefaultMonitorQuoteEventRuntimeDeps['postTradeConsistencyRuntime'];

type RuntimeHarness = Readonly<{
  runtime: MonitorQuoteEventRuntime;
  emitQuoteUpdated: (event: QuoteUpdatedEvent) => void;
}>;

type RetainReleaseCall = Readonly<{
  ownerKey: string;
  reason: string;
}>;

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve,
  };
}

function createQuoteUpdatedEvent(symbol: string, price: number): QuoteUpdatedEvent {
  return {
    symbol,
    quote: createQuoteDouble(symbol, price, 100),
  };
}

function createMonitorQuoteUpdatedEvent(price: number = 20_000): QuoteUpdatedEvent {
  return createQuoteUpdatedEvent('HSI.HK', price);
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createFreshnessRuntimeDouble(): MonitorQuoteFreshnessDeps {
  return {
    waitForFresh: async () => {},
    getStatus: () => ({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    }),
    onFreshReached: () => () => {},
  };
}

function createDefaultStaticLiquidationHarness(): RuntimeHarness &
  Readonly<{
    submittedActions: ReadonlyArray<string>;
    getClearedOrders: () => number;
    getRefreshUnrealizedCalls: () => number;
  }> {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
  const submittedActions: string[] = [];
  let clearedOrders = 0;
  let refreshUnrealizedCalls = 0;
  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: 'HSI.HK',
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
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
    symbolRegistry,
    orderRecorder: createOrderRecorderDouble({
      clearBuyOrders: () => {
        clearedOrders += 1;
      },
    }),
    riskChecker: createRiskCheckerDouble({
      checkWarrantDistanceLiquidation: (_symbol, isLongSymbol) => ({
        shouldLiquidate: isLongSymbol,
        ...(isLongSymbol ? { reason: '触发清仓阈值' } : {}),
      }),
      refreshUnrealizedLossData: async () => {
        refreshUnrealizedCalls += 1;
        return { r1: 100, n1: 100 };
      },
    }),
  });
  const runtime = createDefaultMonitorQuoteEventRuntime({
    marketDataClient: {
      onQuoteUpdated: (listener) => {
        quoteUpdatedListener = listener;
        return () => {
          if (quoteUpdatedListener === listener) {
            quoteUpdatedListener = null;
          }
        };
      },
      getQuotes: async () =>
        new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 100)],
          ['BULL.HK', createQuoteDouble('BULL.HK', 1, 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 1, 100)],
        ]),
    },
    monitorContexts: new Map([['HSI.HK', monitorContext]]),
    trader: createTraderDouble({
      executeSignals: async (signals) => {
        for (const signal of signals) {
          submittedActions.push(signal.action);
        }

        return {
          submittedCount: signals.length,
          submittedOrderIds: [],
        };
      },
    }),
    lastState: {
      positionCache: createPositionCacheDouble([
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 200,
          availableQuantity: 200,
        }),
      ]),
      cachedPositions: [],
      isTradingEnabled: true,
      canTrade: true,
      isHalfDay: false,
    },
    postTradeConsistencyRuntime: createFreshnessRuntimeDouble(),
    doomsdayProtectionEnabled: false,
    now: () => new Date('2026-04-08T10:00:00+08:00'),
  });

  return {
    runtime,
    emitQuoteUpdated(event: QuoteUpdatedEvent): void {
      quoteUpdatedListener?.(event);
    },
    submittedActions,
    getClearedOrders: () => clearedOrders,
    getRefreshUnrealizedCalls: () => refreshUnrealizedCalls,
  };
}

function createDefaultDistanceSwitchHarness(
  params: {
    readonly waitForDistanceResult?: Promise<ReadonlyArray<StartSwitchOnDistanceResult>>;
    readonly canTrade?: boolean | null;
    readonly switchFailure?: Error;
    readonly onFatalError?: (error: unknown) => void;
  } = {},
): RuntimeHarness &
  Readonly<{
    startSwitchDirections: ReadonlyArray<'LONG' | 'SHORT'>;
    switchWakeupHandoffs: ReadonlyArray<{
      readonly monitorSymbol: string;
      readonly direction: 'LONG' | 'SHORT';
      readonly driveResultKind: string;
    }>;
  }> {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
  const startSwitchDirections: Array<'LONG' | 'SHORT'> = [];
  const switchWakeupHandoffs: Array<{
    readonly monitorSymbol: string;
    readonly direction: 'LONG' | 'SHORT';
    readonly driveResultKind: string;
  }> = [];
  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: 'HSI.HK',
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
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
  const monitorContext = createMonitorContextDouble({
    config: createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
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
    symbolRegistry,
    autoSymbolManager: createAutoSymbolManagerDouble({
      startSwitchOnDistance: async ({ direction }) => {
        startSwitchDirections.push(direction);
        if (params.switchFailure) {
          throw params.switchFailure;
        }

        if (params.waitForDistanceResult) {
          const result = await params.waitForDistanceResult;
          return result[0] ?? { started: false, direction, driveResult: { kind: 'NOOP' } };
        }

        return {
          started: true,
          direction,
          driveResult: {
            kind: 'WAIT',
            wakeups: [
              { kind: 'ORDER_EVENT', symbols: [direction === 'LONG' ? 'BULL.HK' : 'BEAR.HK'] },
            ],
          },
        };
      },
    }),
  });
  const runtime = createDefaultMonitorQuoteEventRuntime({
    marketDataClient: {
      onQuoteUpdated: (listener) => {
        quoteUpdatedListener = listener;
        return () => {
          if (quoteUpdatedListener === listener) {
            quoteUpdatedListener = null;
          }
        };
      },
      getQuotes: async () => new Map(),
    },
    monitorContexts: new Map([['HSI.HK', monitorContext]]),
    trader: createTraderDouble(),
    lastState: {
      positionCache: createPositionCacheDouble(),
      cachedPositions: [],
      isTradingEnabled: true,
      canTrade: params.canTrade ?? true,
      isHalfDay: false,
    },
    postTradeConsistencyRuntime: createFreshnessRuntimeDouble(),
    doomsdayProtectionEnabled: false,
    now: () => new Date('2026-04-08T10:00:00+08:00'),
    ...(params.onFatalError ? { onFatalError: params.onFatalError } : {}),
    handoffPendingSwitch: (handoffParams) => {
      switchWakeupHandoffs.push({
        monitorSymbol: handoffParams.monitorSymbol,
        direction: handoffParams.direction,
        driveResultKind: handoffParams.driveResult.kind,
      });
    },
  });

  return {
    runtime,
    emitQuoteUpdated(event: QuoteUpdatedEvent): void {
      quoteUpdatedListener?.(event);
    },
    startSwitchDirections,
    switchWakeupHandoffs,
  };
}

function createDefaultStaticWaitHarness(
  params: {
    readonly retainFailureCount?: number;
  } = {},
): RuntimeHarness &
  Readonly<{
    getQuoteRequestCount: () => number;
    getRetainCalls: () => ReadonlyArray<ReadonlyArray<string>>;
    getReleaseCalls: () => ReadonlyArray<RetainReleaseCall>;
    switchLongSeatToNextSymbol: () => void;
    switchMonitorRouteToDistanceMode: () => void;
  }> {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
  const quoteRequests: string[][] = [];
  const retainCalls: string[][] = [];
  const releaseCalls: RetainReleaseCall[] = [];
  let remainingRetainFailures = params.retainFailureCount ?? 0;
  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: 'HSI.HK',
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
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
  const staticMonitorContext = createMonitorContextDouble({
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
    symbolRegistry,
  });
  const distanceMonitorContext = createMonitorContextDouble({
    config: createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
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
    symbolRegistry,
    autoSymbolManager: createAutoSymbolManagerDouble({
      startSwitchOnDistance: async ({ direction }) => ({
        started: false,
        direction,
        driveResult: { kind: 'NOOP' },
      }),
    }),
  });
  const monitorContexts = new Map([['HSI.HK', staticMonitorContext]]);
  const runtime = createDefaultMonitorQuoteEventRuntime({
    marketDataClient: {
      onQuoteUpdated: (listener) => {
        quoteUpdatedListener = listener;
        return () => {
          if (quoteUpdatedListener === listener) {
            quoteUpdatedListener = null;
          }
        };
      },
      getQuotes: async (symbols) => {
        quoteRequests.push([...symbols]);
        return new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 100)]]);
      },
    },
    monitorContexts,
    trader: createTraderDouble(),
    lastState: {
      positionCache: createPositionCacheDouble([
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 200,
          availableQuantity: 200,
        }),
        createPositionDouble({
          symbol: 'NEXT_BULL.HK',
          quantity: 200,
          availableQuantity: 200,
        }),
      ]),
      cachedPositions: [],
      isTradingEnabled: true,
      canTrade: true,
      isHalfDay: false,
    },
    postTradeConsistencyRuntime: createFreshnessRuntimeDouble(),
    doomsdayProtectionEnabled: false,
    now: () => new Date('2026-04-08T10:00:00+08:00'),
    quoteSubscriptionRuntime: {
      retainSymbols: async ({ symbols }) => {
        retainCalls.push([...symbols]);
        if (remainingRetainFailures > 0) {
          remainingRetainFailures -= 1;
          throw new Error('retain failed');
        }

        return () => {};
      },
      releaseRetain: async ({ ownerKey, reason }) => {
        releaseCalls.push({ ownerKey, reason });
      },
    },
  });

  return {
    runtime,
    emitQuoteUpdated(event: QuoteUpdatedEvent): void {
      quoteUpdatedListener?.(event);
    },
    getQuoteRequestCount: () => quoteRequests.length,
    getRetainCalls: () => retainCalls.map((symbols) => [...symbols]),
    getReleaseCalls: () => releaseCalls.map((call) => ({ ...call })),
    switchLongSeatToNextSymbol(): void {
      symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
        symbol: 'NEXT_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
    },
    switchMonitorRouteToDistanceMode(): void {
      monitorContexts.set('HSI.HK', distanceMonitorContext);
    },
  };
}

describe('monitorQuoteEventRuntime exports', () => {
  it('exports the public default monitor quote runtime factory', async () => {
    const module =
      await import('../../../src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js');

    expect(Object.keys(module)).toEqual(['createDefaultMonitorQuoteEventRuntime']);
  });
});

describe('monitorQuoteEventRuntime contract', () => {
  it('creates default runtime with start and stopAndDrain methods', () => {
    const harness = createDefaultDistanceSwitchHarness();

    expect(harness.runtime).toMatchObject({
      start: expect.any(Function),
      stopAndDrain: expect.any(Function),
    });
  });

  it('subscribes on start and unsubscribes on stopAndDrain', async () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const runtime = createDefaultMonitorQuoteEventRuntime({
      marketDataClient: {
        onQuoteUpdated: () => {
          subscribed += 1;
          return () => {
            unsubscribed += 1;
          };
        },
        getQuotes: async () => new Map(),
      },
      monitorContexts: new Map(),
      trader: createTraderDouble(),
      lastState: {
        positionCache: createPositionCacheDouble(),
        cachedPositions: [],
        isTradingEnabled: true,
        canTrade: true,
        isHalfDay: false,
      },
      postTradeConsistencyRuntime: createFreshnessRuntimeDouble(),
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-08T10:00:00+08:00'),
    });

    runtime.start();
    expect(subscribed).toBe(1);

    await runtime.stopAndDrain();
    expect(unsubscribed).toBe(1);
  });

  it('executes real static liquidation when autoSearch is disabled', async () => {
    const harness = createDefaultStaticLiquidationHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await harness.runtime.stopAndDrain();
    expect(harness.submittedActions).toEqual(['SELLCALL']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
  });

  it('matches only registered static liquidation wakeup symbols', async () => {
    const harness = createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('IGNORED.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(2);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BEAR.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(3);

    await harness.runtime.stopAndDrain();
  });

  it('does not re-retain unchanged static liquidation wakeup symbols', async () => {
    const harness = createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);

    await harness.runtime.stopAndDrain();
  });

  it('retries unchanged static liquidation retain after previous retain failure', async () => {
    const harness = createDefaultStaticWaitHarness({ retainFailureCount: 1 });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([
      ['HSI.HK', 'BULL.HK', 'BEAR.HK'],
      ['HSI.HK', 'BULL.HK', 'BEAR.HK'],
    ]);

    await harness.runtime.stopAndDrain();
  });

  it('releases static liquidation retain owner after failed retain when runtime stops', async () => {
    const harness = createDefaultStaticWaitHarness({ retainFailureCount: 1 });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    await harness.runtime.stopAndDrain();

    expect(harness.getReleaseCalls()).toEqual([
      { ownerKey: 'HSI.HK', reason: 'STATIC_LIQUIDATION_WAIT' },
    ]);
  });

  it('switches static liquidation wakeup membership when WAIT symbols change', async () => {
    const harness = createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.switchLongSeatToNextSymbol();
    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(2);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(2);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('NEXT_BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(3);

    await harness.runtime.stopAndDrain();
  });

  it('clears static liquidation wakeups when route switches to distance mode', async () => {
    const harness = createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.switchMonitorRouteToDistanceMode();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    await harness.runtime.stopAndDrain();
  });

  it('clears static liquidation wakeups after stopAndDrain', async () => {
    const harness = createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    await harness.runtime.stopAndDrain();
    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);
  });

  it('starts distance switch through monitorContext autoSymbolManager when autoSearch is enabled', async () => {
    const harness = createDefaultDistanceSwitchHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.startSwitchDirections).toEqual(['LONG', 'SHORT']);
    expect(harness.switchWakeupHandoffs).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        driveResultKind: 'WAIT',
      },
      {
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        driveResultKind: 'WAIT',
      },
    ]);

    await harness.runtime.stopAndDrain();
  });

  it('skips distance switch when execution gate is closed', async () => {
    const harness = createDefaultDistanceSwitchHarness({ canTrade: false });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.startSwitchDirections).toEqual([]);
    expect(harness.switchWakeupHandoffs).toEqual([]);

    await harness.runtime.stopAndDrain();
  });

  it('does not hand WAIT distance switch result after stopAndDrain', async () => {
    const deferred = createDeferred<ReadonlyArray<StartSwitchOnDistanceResult>>();
    const harness = createDefaultDistanceSwitchHarness({
      waitForDistanceResult: deferred.promise,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    const stopPromise = harness.runtime.stopAndDrain();

    await waitTick();
    deferred.resolve([
      {
        started: true,
        direction: 'LONG',
        driveResult: {
          kind: 'WAIT',
          wakeups: [{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }],
        },
      },
    ]);
    await stopPromise;

    expect(harness.switchWakeupHandoffs).toEqual([]);
  });

  it('sends distance switch route errors to fatal drain', async () => {
    const fatalErrors: unknown[] = [];
    const routeError = createExternalApiRequestError({
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
      cause: new Error('distance switch route broken'),
    });
    const harness = createDefaultDistanceSwitchHarness({
      switchFailure: routeError,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();

    expect(fatalErrors).toEqual([routeError]);
    await harness.runtime.stopAndDrain();
  });
});
