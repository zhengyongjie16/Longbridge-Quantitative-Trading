/**
 * MonitorQuoteEventRuntime 业务测试
 *
 * 功能：
 * - 验证 monitor quote 事件运行时的导出与最小行为契约
 */
import { describe, expect, it } from 'bun:test';
import {
  createAutoSymbolManagerDouble,
  createMarketDataClientDouble,
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
import {
  createDefaultMonitorQuoteEventRuntime,
  createMonitorQuoteEventRuntime,
} from '../../../src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createStaticLiquidationExecutor } from '../../../src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.js';
import type { StaticLiquidationRuntimeResult } from '../../../src/main/monitorQuoteEventRuntime/types.js';
import type { StartSwitchOnDistanceResult } from '../../../src/types/monitorContextPorts.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { QuoteUpdatedEvent } from '../../../src/types/services.js';

type RuntimeHarnessParams = {
  readonly autoSearchEnabled?: boolean;
  readonly executeStaticLiquidationOverride?: (params: {
    readonly event: QuoteUpdatedEvent;
    readonly retryAttempts: number;
  }) => Promise<StaticLiquidationRuntimeResult>;
  readonly startDistanceSwitchOverride?: (params: {
    readonly event: QuoteUpdatedEvent;
  }) => Promise<ReadonlyArray<StartSwitchOnDistanceResult>>;
  readonly lastState?: Readonly<{
    isTradingEnabled: boolean;
    canTrade: boolean | null;
    isHalfDay: boolean | null;
  }>;
  readonly postTradeConsistencyRuntime?: Readonly<{
    waitForFresh: () => Promise<void>;
    getStatus: () => Readonly<{
      started: boolean;
      currentVersion: number;
      staleVersion: number;
    }>;
    onFreshReached?: (
      listener: (event: {
        readonly currentVersion: number;
        readonly staleVersion: number;
        readonly trigger: 'REFRESH' | 'REBUILD_BASELINE';
      }) => void,
    ) => () => void;
  }>;
  readonly doomsdayProtectionEnabled?: boolean;
  readonly now?: () => Date;
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

type RuntimeHarness = {
  readonly emitQuoteUpdated: (event: QuoteUpdatedEvent) => void;
  readonly runtime: ReturnType<typeof createMonitorQuoteEventRuntime>;
  readonly staticLiquidationEvents: QuoteUpdatedEvent[];
  readonly staticLiquidationMonitorContexts: MonitorContext[];
  readonly distanceSwitchStartEvents: QuoteUpdatedEvent[];
  readonly switchWakeupHandoffs: Array<{
    readonly monitorSymbol: string;
    readonly direction: 'LONG' | 'SHORT';
    readonly driveResultKind: string;
  }>;
};

function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};
function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};
function createDeferred<T>(): {
  readonly promise: Promise<T | void>;
  readonly resolve: (value?: T) => void;
} {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T | void>((innerResolve) => {
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

function createFreshnessRuntimeDouble(): Readonly<{
  waitForFresh: () => Promise<void>;
  getStatus: () => Readonly<{
    started: boolean;
    currentVersion: number;
    staleVersion: number;
  }>;
  onFreshReached: (
    listener: (event: {
      readonly currentVersion: number;
      readonly staleVersion: number;
      readonly trigger: 'REFRESH' | 'REBUILD_BASELINE';
    }) => void,
  ) => () => void;
  emitFreshReached: (event?: {
    readonly currentVersion: number;
    readonly staleVersion: number;
    readonly trigger: 'REFRESH' | 'REBUILD_BASELINE';
  }) => void;
}> {
  let freshReachedListener:
    | ((event: {
        readonly currentVersion: number;
        readonly staleVersion: number;
        readonly trigger: 'REFRESH' | 'REBUILD_BASELINE';
      }) => void)
    | null = null;

  return {
    waitForFresh: async () => {},
    getStatus: () => ({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    }),
    onFreshReached: (listener) => {
      freshReachedListener = listener;
      return () => {
        if (freshReachedListener === listener) {
          freshReachedListener = null;
        }
      };
    },
    emitFreshReached: (event) => {
      freshReachedListener?.(
        event ?? {
          currentVersion: 1,
          staleVersion: 1,
          trigger: 'REFRESH',
        },
      );
    },
  };
}

function createControlledTimerDouble(): Readonly<{
  scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  runScheduledTimer: () => void;
  getScheduledDelayMs: () => number | null;
}> {
  let scheduledHandle: ReturnType<typeof setTimeout> | null = null;
  let scheduledCallback: (() => void) | null = null;
  let scheduledDelayMs: number | null = null;

  return {
    scheduleTimer: (callback, delayMs) => {
      const handle = setTimeout(() => {}, 60_000);
      scheduledHandle = handle;
      scheduledCallback = callback;
      scheduledDelayMs = delayMs;
      return handle;
    },
    clearTimer: (handle) => {
      clearTimeout(handle);
      if (scheduledHandle === handle) {
        scheduledHandle = null;
        scheduledCallback = null;
        scheduledDelayMs = null;
      }
    },
    runScheduledTimer: () => {
      if (scheduledHandle === null || scheduledCallback === null) {
        throw new Error('scheduled timer should exist before running');
      }

      const callback = scheduledCallback;
      clearTimeout(scheduledHandle);
      scheduledHandle = null;
      scheduledCallback = null;
      scheduledDelayMs = null;
      callback();
    },
    getScheduledDelayMs: () => scheduledDelayMs,
  };
}

function createRuntimeHarness(params: RuntimeHarnessParams = {}): RuntimeHarness {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
  const monitorContext = createMonitorContextDouble({
    config: createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: params.autoSearchEnabled ?? false,
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
    }),
  });
  const staticLiquidationEvents: QuoteUpdatedEvent[] = [];
  const staticLiquidationMonitorContexts: MonitorContext[] = [];
  const distanceSwitchStartEvents: QuoteUpdatedEvent[] = [];
  const switchWakeupHandoffs: Array<{
    readonly monitorSymbol: string;
    readonly direction: 'LONG' | 'SHORT';
    readonly driveResultKind: string;
  }> = [];

  const runtime = createMonitorQuoteEventRuntime({
    marketDataClient: {
      onQuoteUpdated: (listener) => {
        quoteUpdatedListener = listener;
        return () => {
          if (quoteUpdatedListener === listener) {
            quoteUpdatedListener = null;
          }
        };
      },
    },
    monitorContexts: new Map([['HSI.HK', monitorContext]]),
    executeStaticLiquidation: async ({
      monitorContext: receivedMonitorContext,
      event,
      retryAttempts,
    }) => {
      staticLiquidationEvents.push(event);
      staticLiquidationMonitorContexts.push(receivedMonitorContext);

      if (params.executeStaticLiquidationOverride) {
        return params.executeStaticLiquidationOverride({ event, retryAttempts });
      }

      return {
        kind: 'COMPLETED',
      };
    },
    startDistanceSwitch: async ({ event }) => {
      distanceSwitchStartEvents.push(event);

      if (params.startDistanceSwitchOverride) {
        return params.startDistanceSwitchOverride({ event });
      }

      return [
        {
          started: true,
          direction: 'LONG',
          driveResult: {
            kind: 'WAIT',
            wakeups: [{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }],
          },
        },
      ];
    },
    ...(params.lastState ? { lastState: params.lastState } : {}),
    ...(params.postTradeConsistencyRuntime
      ? { postTradeConsistencyRuntime: params.postTradeConsistencyRuntime }
      : {}),
    ...(params.doomsdayProtectionEnabled === undefined
      ? {}
      : { doomsdayProtectionEnabled: params.doomsdayProtectionEnabled }),
    ...(params.now ? { now: params.now } : {}),
    ...(params.scheduleTimer ? { scheduleTimer: params.scheduleTimer } : {}),
    ...(params.clearTimer ? { clearTimer: params.clearTimer } : {}),
    handoffPendingSwitch: (handoffParams) => {
      switchWakeupHandoffs.push({
        monitorSymbol: handoffParams.monitorSymbol,
        direction: handoffParams.direction,
        driveResultKind: handoffParams.driveResult.kind,
      });
    },
  });

  return {
    emitQuoteUpdated(event: QuoteUpdatedEvent): void {
      quoteUpdatedListener?.(event);
    },
    runtime,
    staticLiquidationEvents,
    staticLiquidationMonitorContexts,
    distanceSwitchStartEvents,
    switchWakeupHandoffs,
  };
}

describe('monitorQuoteEventRuntime exports', () => {
  it('exports monitor quote runtime factories', async () => {
    const module =
      await import('../../../src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js');

    expect(module).toMatchObject({
      createMonitorQuoteEventRuntime: expect.any(Function),
      createDefaultMonitorQuoteEventRuntime: expect.any(Function),
    });
  });
});

function createRuntimeWithRealStaticLiquidationHarness(): {
  readonly runtime: ReturnType<typeof createMonitorQuoteEventRuntime>;
  readonly emitQuoteUpdated: (event: QuoteUpdatedEvent) => void;
  readonly submittedActions: string[];
  readonly getClearedOrders: () => number;
  readonly getRefreshUnrealizedCalls: () => number;
} {
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
  const orderRecorder = createOrderRecorderDouble({
    clearBuyOrders: () => {
      clearedOrders += 1;
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
    orderRecorder,
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
  const trader = createTraderDouble({
    executeSignals: async (signals) => {
      for (const signal of signals) {
        submittedActions.push(signal.action);
      }

      return {
        submittedCount: signals.length,
        submittedOrderIds: [],
      };
    },
  });
  const executeStaticLiquidation = createStaticLiquidationExecutor({
    trader,
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 100)],
          ['BULL.HK', createQuoteDouble('BULL.HK', 1, 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 1, 100)],
        ]),
    }),
    lastState: {
      positionCache: createPositionCacheDouble([
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 200,
          availableQuantity: 200,
        }),
      ]),
    },
  });
  const runtime = createMonitorQuoteEventRuntime({
    marketDataClient: {
      onQuoteUpdated: (listener) => {
        quoteUpdatedListener = listener;
        return () => {
          if (quoteUpdatedListener === listener) {
            quoteUpdatedListener = null;
          }
        };
      },
    },
    monitorContexts: new Map([['HSI.HK', monitorContext]]),
    executeStaticLiquidation,
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

function createRuntimeWithDefaultStaticLiquidationHarness(): {
  readonly runtime: ReturnType<typeof createMonitorQuoteEventRuntime>;
  readonly emitQuoteUpdated: (event: QuoteUpdatedEvent) => void;
  readonly submittedActions: string[];
  readonly getClearedOrders: () => number;
  readonly getRefreshUnrealizedCalls: () => number;
} {
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

function createRuntimeWithDefaultFactoryHarness(): {
  readonly runtime: ReturnType<typeof createMonitorQuoteEventRuntime>;
  readonly emitQuoteUpdated: (event: QuoteUpdatedEvent) => void;
  readonly submittedActions: string[];
  readonly startSwitchDirections: Array<'LONG' | 'SHORT'>;
  readonly switchWakeupHandoffs: Array<{
    readonly monitorSymbol: string;
    readonly direction: 'LONG' | 'SHORT';
    readonly driveResultKind: string;
  }>;
} {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
  const submittedActions: string[] = [];
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
    submittedActions,
    startSwitchDirections,
    switchWakeupHandoffs,
  };
}

describe('monitorQuoteEventRuntime contract', () => {
  it('creates runtime with start and stopAndDrain methods', () => {
    const runtime = createMonitorQuoteEventRuntime({
      marketDataClient: {
        onQuoteUpdated: () => () => {},
      },
    });

    expect(runtime).toMatchObject({
      start: expect.any(Function),
      stopAndDrain: expect.any(Function),
    });
  });

  it('subscribes on start and unsubscribes on stopAndDrain', async () => {
    let subscribed = 0;
    let unsubscribed = 0;

    const runtime = createMonitorQuoteEventRuntime({
      marketDataClient: {
        onQuoteUpdated: () => {
          subscribed += 1;
          return () => {
            unsubscribed += 1;
          };
        },
      },
    });

    runtime.start();
    expect(subscribed).toBe(1);

    await runtime.stopAndDrain();
    expect(unsubscribed).toBe(1);
  });

  it('routes monitorSymbol quote to static liquidation after start', async () => {
    const harness = createRuntimeHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await Promise.resolve();
    expect(harness.staticLiquidationEvents).toHaveLength(1);
    expect(harness.staticLiquidationEvents[0]?.symbol).toBe('HSI.HK');
  });

  it('routes monitorSymbol quote into real static liquidation executor after start', async () => {
    const harness = createRuntimeWithRealStaticLiquidationHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await harness.runtime.stopAndDrain();
    expect(harness.submittedActions).toEqual(['SELLCALL']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
  });

  it('creates default runtime that executes real static liquidation when autoSearch is disabled', async () => {
    const harness = createRuntimeWithDefaultStaticLiquidationHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await harness.runtime.stopAndDrain();
    expect(harness.submittedActions).toEqual(['SELLCALL']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
  });

  it('creates default runtime that starts distance switch through monitorContext autoSymbolManager when autoSearch is enabled', async () => {
    const harness = createRuntimeWithDefaultFactoryHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.submittedActions).toEqual([]);
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

  it('does not hand WAIT distance switch result from default factory after stopAndDrain', async () => {
    const deferred = createDeferred<ReadonlyArray<StartSwitchOnDistanceResult>>();
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
    const switchWakeupHandoffs: Array<{
      readonly monitorSymbol: string;
      readonly direction: 'LONG' | 'SHORT';
      readonly driveResultKind: string;
    }> = [];
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
      symbolRegistry: createSymbolRegistryDouble({
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
          status: 'EMPTY',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
      }),
      autoSymbolManager: createAutoSymbolManagerDouble({
        startSwitchOnDistance: async () => {
          const result = await deferred.promise;
          return result[0] ?? { started: false, direction: 'LONG', driveResult: { kind: 'NOOP' } };
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
        canTrade: true,
        isHalfDay: false,
      },
      postTradeConsistencyRuntime: createFreshnessRuntimeDouble(),
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-08T10:00:00+08:00'),
      handoffPendingSwitch: (handoffParams) => {
        switchWakeupHandoffs.push({
          monitorSymbol: handoffParams.monitorSymbol,
          direction: handoffParams.direction,
          driveResultKind: handoffParams.driveResult.kind,
        });
      },
    });

    const emitQuoteUpdated = (event: QuoteUpdatedEvent): void => {
      quoteUpdatedListener?.(event);
    };

    runtime.start();
    emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    const stopPromise = runtime.stopAndDrain();

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

    expect(switchWakeupHandoffs).toEqual([]);
  });

  it('wakes latest monitor context only after static liquidation WAIT result', async () => {
    const firstDeferred = createDeferred<StaticLiquidationRuntimeResult>();
    const secondDeferred = createDeferred<StaticLiquidationRuntimeResult>();
    const firstMonitorContext = createMonitorContextDouble({
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
      }),
    });
    const secondMonitorContext = createMonitorContextDouble({
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
      }),
    });
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
    const emitQuoteUpdated = (event: QuoteUpdatedEvent): void => {
      if (quoteUpdatedListener === null) {
        throw new Error('quoteUpdatedListener should be registered after start');
      }

      quoteUpdatedListener(event);
    };
    let executionCount = 0;
    const monitorContexts = new Map<string, MonitorContext>([['HSI.HK', firstMonitorContext]]);
    const runtime = createMonitorQuoteEventRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = null;
            }
          };
        },
      },
      monitorContexts,
      executeStaticLiquidation: async ({ monitorContext, event }) => {
        executionCount += 1;
        if (executionCount === 1) {
          expect(monitorContext).toBe(firstMonitorContext);
          expect(event.quote.price).toBe(20_000);
          return firstDeferred.promise;
        }

        expect(monitorContext).toBe(secondMonitorContext);
        expect(event.quote.price).toBe(20_100);
        return secondDeferred.promise;
      },
    });

    runtime.start();
    emitQuoteUpdated(createMonitorQuoteUpdatedEvent(20_000));
    monitorContexts.set('HSI.HK', secondMonitorContext);
    emitQuoteUpdated(createMonitorQuoteUpdatedEvent(20_100));

    await waitTick();
    expect(executionCount).toBe(1);

    firstDeferred.resolve({ kind: 'WAIT', wakeupSymbols: ['HSI.HK'], retryAtMs: null });
    await waitTick();
    expect(executionCount).toBe(2);

    secondDeferred.resolve({ kind: 'COMPLETED' });
    await runtime.stopAndDrain();
  });

  it('waits for in-flight static liquidation execution before stopAndDrain resolves', async () => {
    const deferred = createDeferred<StaticLiquidationRuntimeResult>();
    const harness = createRuntimeHarness({
      executeStaticLiquidationOverride: async () => {
        await waitTick();
        return deferred.promise;
      },
    });
    let stopped = false;

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    const stopPromise = harness.runtime.stopAndDrain().then(() => {
      stopped = true;
    });

    await waitTick();
    expect(stopped).toBe(false);

    deferred.resolve({ kind: 'COMPLETED' });
    await stopPromise;

    expect(stopped).toBe(true);
  });

  it('routes monitorSymbol quote to distance switch start when autoSearch is enabled', async () => {
    const harness = createRuntimeHarness({ autoSearchEnabled: true });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await Promise.resolve();
    expect(harness.distanceSwitchStartEvents).toHaveLength(1);
    expect(harness.distanceSwitchStartEvents[0]?.symbol).toBe('HSI.HK');
  });

  it('hands all WAIT distance switch results to SwitchWakeupRuntime when autoSearch is enabled', async () => {
    const harness = createRuntimeHarness({
      autoSearchEnabled: true,
      startDistanceSwitchOverride: async () => [
        {
          started: true,
          direction: 'LONG',
          driveResult: {
            kind: 'WAIT',
            wakeups: [{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }],
          },
        },
        {
          started: true,
          direction: 'SHORT',
          driveResult: {
            kind: 'WAIT',
            wakeups: [{ kind: 'ORDER_EVENT', symbols: ['BEAR.HK'] }],
          },
        },
      ],
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
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
  });

  it('does not hand WAIT distance switch result to SwitchWakeupRuntime after stopAndDrain', async () => {
    const deferred = createDeferred<ReadonlyArray<StartSwitchOnDistanceResult>>();
    const harness = createRuntimeHarness({
      autoSearchEnabled: true,
      startDistanceSwitchOverride: async () => {
        await waitTick();
        return deferred.promise;
      },
    });
    let stopped = false;

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    const stopPromise = harness.runtime.stopAndDrain().then(() => {
      stopped = true;
    });

    await waitTick();
    expect(stopped).toBe(false);

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

    expect(stopped).toBe(true);
    expect(harness.switchWakeupHandoffs).toEqual([]);
  });

  it('waits for in-flight distance switch start before stopAndDrain resolves', async () => {
    const deferred = createDeferred<ReadonlyArray<StartSwitchOnDistanceResult>>();
    const harness = createRuntimeHarness({
      autoSearchEnabled: true,
      startDistanceSwitchOverride: async () => {
        await waitTick();
        return deferred.promise;
      },
    });
    let stopped = false;

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    const stopPromise = harness.runtime.stopAndDrain().then(() => {
      stopped = true;
    });

    await waitTick();
    expect(stopped).toBe(false);

    deferred.resolve([
      {
        started: false,
        direction: 'LONG',
        driveResult: {
          kind: 'NOOP',
        },
      },
    ]);
    await stopPromise;

    expect(stopped).toBe(true);
  });

  it('does not start distance switch when execution gate is closed before dispatch', async () => {
    const harness = createRuntimeHarness({
      autoSearchEnabled: true,
      lastState: {
        isTradingEnabled: false,
        canTrade: true,
        isHalfDay: false,
      },
      postTradeConsistencyRuntime: {
        waitForFresh: async () => {},
        getStatus: () => ({
          started: true,
          currentVersion: 1,
          staleVersion: 1,
        }),
        onFreshReached: () => () => {},
      },
      doomsdayProtectionEnabled: true,
      now: () => new Date('2026-04-08T15:56:00+08:00'),
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await Promise.resolve();
    expect(harness.distanceSwitchStartEvents).toEqual([]);
    expect(harness.switchWakeupHandoffs).toEqual([]);
  });

  it('does not re-run static liquidation from freshness reached without a new quote event', async () => {
    const freshnessRuntime = createFreshnessRuntimeDouble();
    let executionCount = 0;
    const harness = createRuntimeHarness({
      executeStaticLiquidationOverride: async () => {
        executionCount += 1;
        return {
          kind: 'WAIT',
          wakeupSymbols: ['HSI.HK', 'BULL.HK'],
          retryAtMs: null,
        };
      },
      postTradeConsistencyRuntime: freshnessRuntime,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    expect(executionCount).toBe(1);

    freshnessRuntime.emitFreshReached();
    await waitTick();
    expect(executionCount).toBe(1);
  });

  it('collapses concurrent monitor quote events to latest-only static liquidation execution', async () => {
    const firstDeferred = createDeferred<StaticLiquidationRuntimeResult>();
    const secondDeferred = createDeferred<StaticLiquidationRuntimeResult>();
    let executionCount = 0;
    const harness = createRuntimeHarness({
      executeStaticLiquidationOverride: async ({ event }) => {
        executionCount += 1;
        if (executionCount === 1) {
          return firstDeferred.promise;
        }

        expect(event.quote.price).toBe(20_100);
        return secondDeferred.promise;
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent(20_000));
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent(20_050));
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent(20_100));

    await waitTick();
    expect(executionCount).toBe(1);

    firstDeferred.resolve({ kind: 'WAIT', wakeupSymbols: ['HSI.HK', 'BULL.HK'], retryAtMs: null });
    await waitTick();
    expect(executionCount).toBe(2);

    secondDeferred.resolve({ kind: 'COMPLETED' });
    await harness.runtime.stopAndDrain();

    expect(harness.staticLiquidationEvents.map((event) => event.quote.price)).toEqual([
      20_000, 20_100,
    ]);
  });

  it('does not start a new collapsed static liquidation run after stopAndDrain begins', async () => {
    const firstDeferred = createDeferred<StaticLiquidationRuntimeResult>();
    let executionCount = 0;
    const harness = createRuntimeHarness({
      executeStaticLiquidationOverride: async () => {
        executionCount += 1;
        return firstDeferred.promise;
      },
    });
    let stopped = false;

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent(20_000));
    await waitTick();
    expect(executionCount).toBe(1);

    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent(20_100));
    const stopPromise = harness.runtime.stopAndDrain().then(() => {
      stopped = true;
    });

    await waitTick();
    expect(stopped).toBe(false);
    expect(executionCount).toBe(1);

    firstDeferred.resolve({ kind: 'COMPLETED' });
    await stopPromise;

    expect(stopped).toBe(true);
    expect(executionCount).toBe(1);
    expect(harness.staticLiquidationEvents.map((event) => event.quote.price)).toEqual([20_000]);
  });

  it('retries static liquidation after WAIT even without a new quote push', async () => {
    const timerDouble = createControlledTimerDouble();
    let executionCount = 0;
    const harness = createRuntimeHarness({
      now: () => new Date('2026-04-08T10:00:00+08:00'),
      scheduleTimer: timerDouble.scheduleTimer,
      clearTimer: timerDouble.clearTimer,
      executeStaticLiquidationOverride: async ({ retryAttempts }) => {
        executionCount += 1;
        if (executionCount === 1) {
          expect(retryAttempts).toBe(0);
          return {
            kind: 'WAIT',
            wakeupSymbols: ['HSI.HK', 'BULL.HK'],
            retryAtMs: new Date('2026-04-08T10:00:02+08:00').getTime(),
          };
        }

        expect(retryAttempts).toBe(1);
        return {
          kind: 'COMPLETED',
        };
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent(20_000));
    await waitTick();
    expect(executionCount).toBe(1);
    expect(timerDouble.getScheduledDelayMs()).toBe(2_000);

    timerDouble.runScheduledTimer();
    await waitTick();
    expect(executionCount).toBe(2);
  });

  it('wakes static liquidation early on trading quote push and clears pending retry timer', async () => {
    const timerDouble = createControlledTimerDouble();
    let executionCount = 0;
    const harness = createRuntimeHarness({
      now: () => new Date('2026-04-08T10:00:00+08:00'),
      scheduleTimer: timerDouble.scheduleTimer,
      clearTimer: timerDouble.clearTimer,
      executeStaticLiquidationOverride: async ({ event, retryAttempts }) => {
        executionCount += 1;
        if (executionCount === 1) {
          expect(event.symbol).toBe('HSI.HK');
          expect(retryAttempts).toBe(0);
          return {
            kind: 'WAIT',
            wakeupSymbols: ['HSI.HK', 'BULL.HK'],
            retryAtMs: new Date('2026-04-08T10:00:02+08:00').getTime(),
          };
        }

        expect(event.symbol).toBe('BULL.HK');
        expect(retryAttempts).toBe(1);
        return {
          kind: 'COMPLETED',
        };
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent(20_000));
    await waitTick();
    expect(executionCount).toBe(1);
    expect(timerDouble.getScheduledDelayMs()).toBe(2_000);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));
    await waitTick();
    expect(executionCount).toBe(2);
    expect(timerDouble.getScheduledDelayMs()).toBeNull();
  });
});
