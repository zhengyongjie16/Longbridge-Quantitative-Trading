/**
 * SwitchWakeupRuntime 业务测试
 *
 * 覆盖：
 * - WAIT wakeups 可由 ORDER_EVENT / FRESHNESS / SYMBOL_QUOTE / RETRY_TIMER 继续推进 pending switch
 * - route key 需要按 monitorSymbol + direction + seatVersion 隔离，并对旧 seatVersion 自然失效
 * - stopAndDrain 后旧事件与旧 timer 不再继续推进
 * - baseline / gate 关闭时事件只唤醒不推进，恢复后再由新事件继续推进
 * - 同一路由使用 single-flight + latest-only collapse
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createMonitorContextDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createPositionDouble,
} from '../../helpers/testDoubles.js';
import { createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createSwitchWakeupRuntime } from '../../../src/main/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import type {
  AutoSymbolManagerPort,
  SwitchDriveResult,
  SwitchWakeupRequirement,
} from '../../../src/types/monitorContextPorts.js';
import type {
  OrderStateChangedEvent,
  PostTradeConsistencyFreshReachedEvent,
  QuoteUpdatedEvent,
} from '../../../src/types/services.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';

function createDeferred<voidValue = void>(): {
  readonly promise: Promise<voidValue>;
  readonly resolve: (value: voidValue) => void;
} {
  let resolve!: (value: voidValue) => void;
  const promise = new Promise<voidValue>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

type ConsistencyStatus = Readonly<{
  started: boolean;
  currentVersion: number;
  staleVersion: number;
}>;

function createConsistencyHarness(initialStatus: ConsistencyStatus) {
  let status = initialStatus;
  let freshDeferred: ReturnType<typeof createDeferred<void>> | null = null;
  let freshReachedListener: ((event: PostTradeConsistencyFreshReachedEvent) => void) | null = null;

  return {
    port: {
      getStatus: () => status,
      waitForFresh: async () => {
        if (freshDeferred !== null) {
          await freshDeferred.promise;
        }
      },
      onFreshReached: (listener: (event: PostTradeConsistencyFreshReachedEvent) => void) => {
        freshReachedListener = listener;
        return () => {
          if (freshReachedListener === listener) {
            freshReachedListener = null;
          }
        };
      },
    },
    setStatus: (nextStatus: ConsistencyStatus) => {
      status = nextStatus;
    },
    blockFreshWait: () => {
      freshDeferred = createDeferred();
    },
    resolveFreshWait: () => {
      freshDeferred?.resolve();
      freshDeferred = null;
    },
    emitFreshReached: (trigger: PostTradeConsistencyFreshReachedEvent['trigger'] = 'REFRESH') => {
      freshReachedListener?.({
        currentVersion: status.currentVersion,
        staleVersion: status.staleVersion,
        trigger,
      });
    },
  };
}

function createTimerHarness(nowMs: number = 1_000) {
  let currentNowMs = nowMs;
  const timers = new Map<ReturnType<typeof setTimeout>, { atMs: number; callback: () => void }>();

  return {
    now: () => currentNowMs,
    setNow: (nextNowMs: number) => {
      currentNowMs = nextNowMs;
    },
    schedule: (callback: () => void, delayMs: number) => {
      const handle = setTimeout(() => {}, delayMs);
      timers.set(handle, {
        atMs: currentNowMs + delayMs,
        callback,
      });
      return handle;
    },
    clear: (handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle);
      timers.delete(handle);
    },
    fireDueTimers: () => {
      const dueTimers = [...timers.entries()].filter(([, timer]) => timer.atMs <= currentNowMs);
      for (const [handle, timer] of dueTimers) {
        clearTimeout(handle);
        timers.delete(handle);
        timer.callback();
      }
    },
    getPendingTimerCount: () => timers.size,
  };
}

describe('switchWakeupRuntime', () => {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null;
  let orderStateChangedListener: ((event: OrderStateChangedEvent) => void) | null;

  beforeEach(() => {
    quoteUpdatedListener = null;
    orderStateChangedListener = null;
  });

  function createBaseHarness(
    params: {
      readonly monitorContexts?: Map<string, MonitorContext>;
      readonly symbolRegistry?: SymbolRegistry;
      readonly lastState?: {
        canTrade: boolean | null;
        isTradingEnabled: boolean;
        isHalfDay: boolean | null;
        cachedPositions: ReturnType<typeof createPositionDouble>[];
      };
      readonly consistencyStatus?: ConsistencyStatus;
      readonly doomsdayProtectionEnabled?: boolean;
      readonly now?: () => Date;
      readonly timerHarness?: ReturnType<typeof createTimerHarness>;
      readonly autoSymbolManager?: AutoSymbolManagerPort;
    } = {},
  ): Readonly<{
    runtime: ReturnType<typeof createSwitchWakeupRuntime>;
    symbolRegistry: SymbolRegistry;
    monitorContexts: Map<string, MonitorContext>;
    lastState: {
      canTrade: boolean | null;
      isTradingEnabled: boolean;
      isHalfDay: boolean | null;
      cachedPositions: ReturnType<typeof createPositionDouble>[];
    };
    consistencyHarness: ReturnType<typeof createConsistencyHarness>;
    timerHarness: ReturnType<typeof createTimerHarness>;
  }> {
    const symbolRegistry =
      params.symbolRegistry ??
      createSymbolRegistryDouble({
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
        longVersion: 1,
        shortVersion: 1,
      });
    const consistencyHarness = createConsistencyHarness(
      params.consistencyStatus ?? {
        started: true,
        currentVersion: 1,
        staleVersion: 1,
      },
    );
    const timerHarness = params.timerHarness ?? createTimerHarness();
    const lastState = params.lastState ?? {
      canTrade: true,
      isTradingEnabled: true,
      isHalfDay: false,
      cachedPositions: [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ],
    };
    const monitorContexts =
      params.monitorContexts ??
      new Map([
        [
          'HSI.HK',
          createMonitorContextDouble({
            config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
            symbolRegistry,
            state: {
              monitorSymbol: 'HSI.HK',
              signal: null,
              pendingDelayedSignals: [],
              lastMonitorSnapshot: null,
              incrementalIndicatorRuntime: null,
            },
            ...(params.autoSymbolManager ? { autoSymbolManager: params.autoSymbolManager } : {}),
          }),
        ],
      ]);
    const trader = createTraderDouble({
      onOrderStateChanged: (listener) => {
        orderStateChangedListener = listener;
        return () => {
          if (orderStateChangedListener === listener) {
            orderStateChangedListener = null;
          }
        };
      },
    });
    const runtime = createSwitchWakeupRuntime({
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
      trader,
      symbolRegistry,
      monitorContexts,
      lastState,
      postTradeConsistencyRuntime: consistencyHarness.port,
      doomsdayProtectionEnabled: params.doomsdayProtectionEnabled ?? false,
      now:
        params.now ??
        (() => {
          return new Date('2026-04-07T02:00:00.000Z');
        }),
      scheduleTimer: (callback, delayMs) => timerHarness.schedule(callback, delayMs),
      clearTimer: (handle) => {
        timerHarness.clear(handle);
      },
    });

    return {
      runtime,
      symbolRegistry,
      monitorContexts,
      lastState,
      consistencyHarness,
      timerHarness,
    };
  }

  function emitQuoteUpdated(symbol: string, price: number): void {
    quoteUpdatedListener?.({
      symbol,
      quote: createQuoteDouble(symbol, price, 100),
    });
  }

  function emitOrderStateChanged(symbol: string): void {
    orderStateChangedListener?.({
      orderId: `order-${symbol}`,
      symbol,
      side: 'BUY',
      source: 'WS',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedPrice: 1,
      executedQuantity: 1,
      executedTimeMs: Date.now(),
    });
  }

  function createWaitResult(
    wakeups: ReadonlyArray<SwitchWakeupRequirement>,
  ): Extract<SwitchDriveResult, { kind: 'WAIT' }> {
    return {
      kind: 'WAIT',
      wakeups,
    };
  }

  it('re-drives the same pending switch on order, freshness, quote and retry-timer wakeups', async () => {
    const advanceCalls: Array<{
      direction: 'LONG' | 'SHORT';
      positionQuantities: ReadonlyArray<number>;
    }> = [];
    const timerHarness = createTimerHarness(10_000);
    const runtimeHarness = createBaseHarness({
      timerHarness,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        maybeSwitchOnInterval: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls.push({
            direction: params.direction,
            positionQuantities: params.positions.map(
              (position: { readonly quantity: number }) => position.quantity,
            ),
          });

          switch (advanceCalls.length) {
            case 1: {
              return {
                advanced: true,
                direction: params.direction,
                stillPending: true,
                driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
              };
            }

            case 2: {
              return {
                advanced: true,
                direction: params.direction,
                stillPending: true,
                driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
              };
            }

            case 3: {
              return {
                advanced: true,
                direction: params.direction,
                stillPending: true,
                driveResult: createWaitResult([
                  { kind: 'RETRY_TIMER', atMs: 10_100 },
                  { kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' },
                ]),
              };
            }

            default: {
              return {
                advanced: true,
                direction: params.direction,
                stillPending: false,
                driveResult: { kind: 'COMPLETED' },
              };
            }
          }
        },
        hasPendingSwitch: () => true,
        resetAllState: () => {},
      },
    });
    const firstMonitorContext = runtimeHarness.monitorContexts.get('HSI.HK');
    if (firstMonitorContext === undefined) {
      throw new Error('expected HSI.HK monitor context');
    }

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContext: firstMonitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    emitOrderStateChanged('OTHER.HK');
    await waitTick();
    expect(advanceCalls).toHaveLength(0);

    const monitorContext = runtimeHarness.monitorContexts.get('HSI.HK');
    if (monitorContext === undefined) {
      throw new Error('expected HSI.HK monitor context');
    }

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 1, availableQuantity: 1 }),
    ];

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
    ];
    emitOrderStateChanged('BULL.HK');
    await waitTick();

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 300, availableQuantity: 300 }),
    ];
    runtimeHarness.consistencyHarness.emitFreshReached();
    await waitTick();

    emitQuoteUpdated('OTHER.HK', 1.2);
    await waitTick();
    expect(advanceCalls).toHaveLength(2);

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 400, availableQuantity: 400 }),
    ];
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ];
    timerHarness.setNow(10_100);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(advanceCalls).toEqual([
      {
        direction: 'LONG',
        positionQuantities: [200],
      },
      {
        direction: 'LONG',
        positionQuantities: [300],
      },
      {
        direction: 'LONG',
        positionQuantities: [400],
      },
      {
        direction: 'LONG',
        positionQuantities: [500],
      },
    ]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);

    await runtimeHarness.runtime.stopAndDrain();
  });

  it('isolates routes by monitorSymbol + direction + seatVersion so multiple monitors do not conflict', async () => {
    const longSymbolRegistry = createSymbolRegistryDouble({
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
      longVersion: 1,
      shortVersion: 1,
    });
    const secondRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'TECH.HK',
      longSeat: {
        symbol: 'TECHBULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'TECHBEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });
    const sharedSymbolRegistry = {
      getSeatState: (monitorSymbol: string, direction: 'LONG' | 'SHORT') =>
        monitorSymbol === 'HSI.HK'
          ? longSymbolRegistry.getSeatState(monitorSymbol, direction)
          : secondRegistry.getSeatState(monitorSymbol, direction),
      getSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') =>
        monitorSymbol === 'HSI.HK'
          ? longSymbolRegistry.getSeatVersion(monitorSymbol, direction)
          : secondRegistry.getSeatVersion(monitorSymbol, direction),
      resolveSeatBySymbol: (symbol: string) =>
        longSymbolRegistry.resolveSeatBySymbol(symbol) ??
        secondRegistry.resolveSeatBySymbol(symbol),
      updateSeatState: (
        monitorSymbol: string,
        direction: 'LONG' | 'SHORT',
        nextState: ReturnType<typeof longSymbolRegistry.getSeatState>,
      ) =>
        monitorSymbol === 'HSI.HK'
          ? longSymbolRegistry.updateSeatState(monitorSymbol, direction, nextState)
          : secondRegistry.updateSeatState(monitorSymbol, direction, nextState),
      updateSeatStateWithVersionBump: (
        monitorSymbol: string,
        direction: 'LONG' | 'SHORT',
        nextState: ReturnType<typeof longSymbolRegistry.getSeatState>,
      ) =>
        monitorSymbol === 'HSI.HK'
          ? longSymbolRegistry.updateSeatStateWithVersionBump(monitorSymbol, direction, nextState)
          : secondRegistry.updateSeatStateWithVersionBump(monitorSymbol, direction, nextState),
      bumpSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') =>
        monitorSymbol === 'HSI.HK'
          ? longSymbolRegistry.bumpSeatVersion(monitorSymbol, direction)
          : secondRegistry.bumpSeatVersion(monitorSymbol, direction),
      onSeatStateChanged: () => () => {},
      onSeatVersionChanged: () => () => {},
      onSeatTruthChanged: () => {
        throw new Error('switchWakeupRuntime test must not subscribe to seat truth events');
      },
    };

    const longAdvanceCalls: string[] = [];
    const techAdvanceCalls: string[] = [];
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContextDouble({
          config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
          symbolRegistry: sharedSymbolRegistry,
          autoSymbolManager: {
            maybeSearchOnEvent: async () => {},
            maybeSwitchOnInterval: async () => ({ kind: 'NOOP' }),
            startSwitchOnDistance: async (params) => ({
              started: false,
              direction: params.direction,
              driveResult: { kind: 'NOOP' },
            }),
            advancePendingSwitch: async (params) => {
              longAdvanceCalls.push(`${params.direction}:${params.positions.length}`);
              return {
                advanced: true,
                direction: params.direction,
                stillPending: false,
                driveResult: { kind: 'COMPLETED' },
              };
            },
            hasPendingSwitch: () => true,
            resetAllState: () => {},
          },
        }),
      ],
      [
        'TECH.HK',
        createMonitorContextDouble({
          config: createMonitorConfig({ monitorSymbol: 'TECH.HK' }),
          symbolRegistry: sharedSymbolRegistry,
          autoSymbolManager: {
            maybeSearchOnEvent: async () => {},
            maybeSwitchOnInterval: async () => ({ kind: 'NOOP' }),
            startSwitchOnDistance: async (params) => ({
              started: false,
              direction: params.direction,
              driveResult: { kind: 'NOOP' },
            }),
            advancePendingSwitch: async (params) => {
              techAdvanceCalls.push(`${params.direction}:${params.positions.length}`);
              return {
                advanced: true,
                direction: params.direction,
                stillPending: false,
                driveResult: { kind: 'COMPLETED' },
              };
            },
            hasPendingSwitch: () => true,
            resetAllState: () => {},
          },
        }),
      ],
    ]);

    const runtimeHarness = createBaseHarness({
      monitorContexts,
      symbolRegistry: sharedSymbolRegistry,
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
        isHalfDay: false,
        cachedPositions: [],
      },
    });

    const hsiMonitorContext = runtimeHarness.monitorContexts.get('HSI.HK');
    const techMonitorContext = runtimeHarness.monitorContexts.get('TECH.HK');
    if (hsiMonitorContext === undefined || techMonitorContext === undefined) {
      throw new Error('expected monitor contexts');
    }

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContext: hsiMonitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });

    runtimeHarness.runtime.handoffPendingSwitch({
      monitorSymbol: 'TECH.HK',
      direction: 'LONG',
      monitorContext: techMonitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 1, availableQuantity: 1 }),
    ];
    runtimeHarness.consistencyHarness.emitFreshReached();
    await waitTick();

    expect(longAdvanceCalls).toEqual(['LONG:1']);
    expect(techAdvanceCalls).toEqual(['LONG:1']);

    await runtimeHarness.runtime.stopAndDrain();
  });

  it('naturally invalidates old seatVersion registrations before and after freshness wait', async () => {
    const advanceCalls: number[] = [];
    const symbolRegistry = createSymbolRegistryDouble({
      longVersion: 1,
      shortVersion: 1,
    });
    const consistencyHarness = createConsistencyHarness({
      started: true,
      currentVersion: 1,
      staleVersion: 2,
    });
    consistencyHarness.blockFreshWait();
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        maybeSwitchOnInterval: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls.push(symbolRegistry.getSeatVersion('HSI.HK', params.direction));
          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        resetAllState: () => {},
      },
    });
    const runtime = createSwitchWakeupRuntime({
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
      trader: createTraderDouble({
        onOrderStateChanged: (listener) => {
          orderStateChangedListener = listener;
          return () => {
            if (orderStateChangedListener === listener) {
              orderStateChangedListener = null;
            }
          };
        },
      }),
      symbolRegistry,
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
        isHalfDay: false,
        cachedPositions: [],
      },
      postTradeConsistencyRuntime: consistencyHarness.port,
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-07T02:00:00.000Z'),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });

    runtime.start();
    runtime.handoffPendingSwitch({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
    emitOrderStateChanged('BULL.HK');
    await waitTick();
    expect(advanceCalls).toEqual([]);

    runtime.handoffPendingSwitch({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });

    runtime.handoffPendingSwitch({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });

    runtime.handoffPendingSwitch({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });
    emitOrderStateChanged('BULL.HK');
    await waitTick();

    symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
    consistencyHarness.setStatus({
      started: true,
      currentVersion: 2,
      staleVersion: 2,
    });
    consistencyHarness.resolveFreshWait();
    await waitTick();

    expect(advanceCalls).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('ignores old events and retry timers after stopAndDrain', async () => {
    const timerHarness = createTimerHarness(20_000);
    let advanceCalls = 0;
    const runtimeHarness = createBaseHarness({
      timerHarness,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        maybeSwitchOnInterval: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: true,
            driveResult: createWaitResult([{ kind: 'RETRY_TIMER', atMs: 20_100 }]),
          };
        },
        hasPendingSwitch: () => true,
        resetAllState: () => {},
      },
    });
    const stopMonitorContext = runtimeHarness.monitorContexts.get('HSI.HK');
    if (stopMonitorContext === undefined) {
      throw new Error('expected HSI.HK monitor context');
    }

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContext: stopMonitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    emitOrderStateChanged('BULL.HK');
    await waitTick();
    expect(advanceCalls).toBe(1);
    expect(timerHarness.getPendingTimerCount()).toBe(1);

    await runtimeHarness.runtime.stopAndDrain();

    emitOrderStateChanged('BULL.HK');
    emitQuoteUpdated('BULL.HK', 1.23);
    runtimeHarness.consistencyHarness.emitFreshReached();
    timerHarness.setNow(20_100);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(advanceCalls).toBe(1);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
  });

  it('does not keep retry timers registered when stopAndDrain races with an in-flight advance', async () => {
    const timerHarness = createTimerHarness(30_000);
    const firstAdvance = createDeferred();
    let advanceCalls = 0;
    const runtimeHarness = createBaseHarness({
      timerHarness,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        maybeSwitchOnInterval: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          await firstAdvance.promise;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: true,
            driveResult: createWaitResult([{ kind: 'RETRY_TIMER', atMs: 30_100 }]),
          };
        },
        hasPendingSwitch: () => true,
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContexts.get('HSI.HK');
    if (monitorContext === undefined) {
      throw new Error('expected HSI.HK monitor context');
    }

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    emitOrderStateChanged('BULL.HK');
    await waitTick();
    expect(advanceCalls).toBe(1);

    const stopPromise = runtimeHarness.runtime.stopAndDrain();
    firstAdvance.resolve();
    await stopPromise;

    expect(timerHarness.getPendingTimerCount()).toBe(0);
    timerHarness.setNow(30_100);
    timerHarness.fireDueTimers();
    await waitTick();
    expect(advanceCalls).toBe(1);
  });

  it('does not advance when baseline is stale or lifecycle gate is closed', async () => {
    let advanceCalls = 0;
    const runtimeHarness = createBaseHarness({
      consistencyStatus: {
        started: false,
        currentVersion: 0,
        staleVersion: 0,
      },
      lastState: {
        canTrade: false,
        isTradingEnabled: false,
        isHalfDay: false,
        cachedPositions: [],
      },
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        maybeSwitchOnInterval: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContexts.get('HSI.HK');
    if (monitorContext === undefined) {
      throw new Error('expected HSI.HK monitor context');
    }

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });

    runtimeHarness.consistencyHarness.emitFreshReached();
    await waitTick();
    expect(advanceCalls).toBe(0);

    runtimeHarness.lastState.canTrade = true;
    runtimeHarness.lastState.isTradingEnabled = true;
    runtimeHarness.consistencyHarness.setStatus({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    });
    runtimeHarness.consistencyHarness.emitFreshReached();
    await waitTick();

    expect(advanceCalls).toBe(1);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('collapses concurrent wakeups to the latest pending execution for the same route', async () => {
    const firstAdvance = createDeferred();
    const observedPositionQuantities: ReadonlyArray<number>[] = [];
    let callCount = 0;
    const runtimeHarness = createBaseHarness({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        maybeSwitchOnInterval: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          callCount += 1;
          observedPositionQuantities.push(params.positions.map((position) => position.quantity));
          if (callCount === 1) {
            await firstAdvance.promise;
            return {
              advanced: true,
              direction: params.direction,
              stillPending: true,
              driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
            };
          }

          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContexts.get('HSI.HK');
    if (monitorContext === undefined) {
      throw new Error('expected HSI.HK monitor context');
    }

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
    ];

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    emitOrderStateChanged('BULL.HK');
    await waitTick();
    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
    ];

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 300, availableQuantity: 300 }),
    ];
    emitOrderStateChanged('BULL.HK');
    await waitTick();

    firstAdvance.resolve();
    await waitTick();
    await waitTick();

    expect(observedPositionQuantities).toEqual([[100], [300]]);
    await runtimeHarness.runtime.stopAndDrain();
  });
});
