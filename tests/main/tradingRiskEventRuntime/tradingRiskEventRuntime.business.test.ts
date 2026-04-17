/**
 * TradingRiskEventRuntime 业务测试
 *
 * 功能：
 * - 验证路由索引、门禁、seat 版本校验与 single-flight latest-only 语义
 * - 验证单方向浮亏执行器会把 seatVersion 写入清仓信号
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createUnrealizedLossMonitorDouble,
  createQuoteDouble,
  createDailyLossTrackerDouble,
} from '../../helpers/testDoubles.js';
import { createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createTradingRiskEventRuntime } from '../../../src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.js';
import { buildTradingRiskRoutingIndex } from '../../../src/main/tradingRiskEventRuntime/routingIndex.js';
import { resolveTradingRiskRoute } from '../../../src/main/tradingRiskEventRuntime/routeValidation.js';
import { createUnrealizedLossMonitor } from '../../../src/core/riskController/unrealizedLossMonitor.js';
import type { TradingRiskEventRuntimeDeps } from '../../../src/main/tradingRiskEventRuntime/types.js';
import type { QuoteUpdatedEvent } from '../../../src/types/services.js';

type TestTradingRiskConsistencyStatus = ReturnType<
  TradingRiskEventRuntimeDeps['postTradeConsistencyRuntime']['getStatus']
>;

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

function createConsistencyPort(initialStatus: TestTradingRiskConsistencyStatus) {
  let status = initialStatus;
  let freshDeferred: ReturnType<typeof createDeferred<void>> | null = null;
  return {
    enablePendingFreshWait: () => {
      freshDeferred = createDeferred();
    },
    port: {
      getStatus: () => status,
      waitForFresh: async () => {
        if (freshDeferred) {
          await freshDeferred.promise;
        }
      },
    },
    setStatus: (nextStatus: TestTradingRiskConsistencyStatus) => {
      status = nextStatus;
    },
    resolveFresh: () => {
      freshDeferred?.resolve();
    },
  };
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('tradingRiskEventRuntime routing', () => {
  it('throws when the same trading symbol is owned by multiple monitors', () => {
    const symbolRegistry = createSymbolRegistryDouble({
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
    const monitorContexts = new Map<string, ReturnType<typeof createMonitorContextDouble>>([
      [
        'HSI.HK',
        createMonitorContextDouble({
          config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
          symbolRegistry,
        }),
      ],
      [
        'TECH.HK',
        createMonitorContextDouble({
          config: createMonitorConfig({ monitorSymbol: 'TECH.HK' }),
          symbolRegistry,
        }),
      ],
    ]);

    expect(() =>
      buildTradingRiskRoutingIndex({
        monitorContexts,
        symbolRegistry,
      }),
    ).toThrow('重复归属');
  });

  it('resolves the current route from the registry snapshot', () => {
    const symbolRegistry = createSymbolRegistryDouble({
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
      config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry,
    });
    const routingIndex = buildTradingRiskRoutingIndex({
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      symbolRegistry,
    });

    const longRoute = resolveTradingRiskRoute(routingIndex, 'BULL.HK');
    expect(longRoute?.monitorSymbol).toBe('HSI.HK');
    expect(longRoute?.direction).toBe('LONG');
    expect(longRoute?.seatVersion).toBe(1);
  });
});

describe('tradingRiskEventRuntime runtime flow', () => {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null;

  beforeEach(() => {
    quoteUpdatedListener = null;
  });

  function createRuntimeDeps(
    params: {
      readonly lastState?: {
        readonly canTrade: boolean | null;
        readonly isTradingEnabled: boolean;
        readonly isHalfDay: boolean | null;
      };
      readonly doomsdayProtectionEnabled?: boolean;
      readonly consistencyPort?: ReturnType<typeof createConsistencyPort>;
      readonly consistencyStatus?: TestTradingRiskConsistencyStatus;
      readonly monitorContexts?: ReadonlyMap<string, ReturnType<typeof createMonitorContextDouble>>;
      readonly now?: () => Date;
      readonly symbolRegistry?: ReturnType<typeof createSymbolRegistryDouble>;
      readonly trader?: ReturnType<typeof createTraderDouble>;
      readonly unrealizedLossMonitor?: ReturnType<typeof createUnrealizedLossMonitorDouble>;
    } = {},
  ) {
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
      });
    const trader = params.trader ?? createTraderDouble();
    const unrealizedLossMonitor =
      params.unrealizedLossMonitor ??
      createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async () => {},
      });
    const monitorContext =
      params.monitorContexts ??
      new Map([
        [
          'HSI.HK',
          createMonitorContextDouble({
            config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
            symbolRegistry,
            unrealizedLossMonitor,
          }),
        ],
      ]);
    const consistencyPort =
      params.consistencyPort ??
      createConsistencyPort(
        params.consistencyStatus ?? {
          started: true,
          currentVersion: 1,
          staleVersion: 1,
        },
      );

    return {
      deps: {
        marketDataClient: {
          onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
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
        monitorContexts: monitorContext,
        lastState: params.lastState ?? {
          canTrade: true,
          isTradingEnabled: true,
          isHalfDay: false,
        },
        postTradeConsistencyRuntime: consistencyPort.port,
        doomsdayProtectionEnabled: params.doomsdayProtectionEnabled ?? false,
        now: params.now ?? (() => new Date('2026-04-06T01:30:00.000Z')),
      },
      consistencyPort,
      trader,
    };
  }

  function emitQuoteUpdated(symbol: string, price: number): void {
    quoteUpdatedListener?.({
      symbol,
      quote: createQuoteDouble(symbol, price, 100),
    });
  }

  it('starts and stops quote push processing', async () => {
    const executedPrices: number[] = [];
    const { deps } = createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    await runtime.stopAndDrain();

    emitQuoteUpdated('BULL.HK', 9.87);
    await waitTick();

    expect(executedPrices).toEqual([1.23]);
  });

  it('fails fast on start when duplicate trading-symbol ownership already exists', async () => {
    const symbolRegistry = createSymbolRegistryDouble({
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
    const monitorContexts = new Map<string, ReturnType<typeof createMonitorContextDouble>>([
      [
        'HSI.HK',
        createMonitorContextDouble({
          config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
          symbolRegistry,
        }),
      ],
      [
        'TECH.HK',
        createMonitorContextDouble({
          config: createMonitorConfig({ monitorSymbol: 'TECH.HK' }),
          symbolRegistry,
        }),
      ],
    ]);
    const { deps } = createRuntimeDeps({
      symbolRegistry,
      monitorContexts,
    });
    const runtime = createTradingRiskEventRuntime(deps);

    expect(() => {
      runtime.start();
    }).toThrow('重复归属');
  });

  it('skips when trading gate is closed', async () => {
    const executedPrices: number[] = [];
    const { deps } = createRuntimeDeps({
      lastState: {
        canTrade: false,
        isTradingEnabled: true,
        isHalfDay: false,
      },
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when baseline is not ready', async () => {
    const executedPrices: number[] = [];
    const consistencyPort = createConsistencyPort({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
    const { deps } = createRuntimeDeps({
      consistencyPort,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips stale routes when seat version changes during freshness wait', async () => {
    const executedPrices: number[] = [];
    const symbolRegistry = createSymbolRegistryDouble({
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
    const consistencyPort = createConsistencyPort({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    });
    consistencyPort.enablePendingFreshWait();
    const { deps } = createRuntimeDeps({
      consistencyPort,
      symbolRegistry,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
    consistencyPort.resolveFresh();
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when doomsday protection takes over in the final five minutes', async () => {
    const executedPrices: number[] = [];
    const { deps } = createRuntimeDeps({
      doomsdayProtectionEnabled: true,
      now: () => new Date('2026-04-06T07:56:00.000Z'),
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when baseline becomes stale again after freshness wait', async () => {
    const executedPrices: number[] = [];
    const consistencyPort = createConsistencyPort({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    });
    consistencyPort.enablePendingFreshWait();
    const { deps } = createRuntimeDeps({
      consistencyPort,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    consistencyPort.setStatus({
      started: true,
      currentVersion: 1,
      staleVersion: 2,
    });
    consistencyPort.resolveFresh();
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when trading gate closes after freshness wait', async () => {
    const executedPrices: number[] = [];
    const consistencyPort = createConsistencyPort({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    });
    consistencyPort.enablePendingFreshWait();
    const lastState = {
      canTrade: true,
      isTradingEnabled: true,
      isHalfDay: false,
    };
    const { deps } = createRuntimeDeps({
      consistencyPort,
      lastState,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    lastState.canTrade = false;
    consistencyPort.resolveFresh();
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('collapses concurrent events to the latest quote for the same route', async () => {
    const executedPrices: number[] = [];
    const firstCall = createDeferred();
    let callCount = 0;
    const { deps } = createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          callCount += 1;
          executedPrices.push(quote.price);
          if (callCount === 1) {
            await firstCall.promise;
          }
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1);
    await waitTick();

    emitQuoteUpdated('BULL.HK', 2);
    emitQuoteUpdated('BULL.HK', 3);
    await waitTick();

    firstCall.resolve();
    await waitTick();
    await waitTick();

    expect(executedPrices).toEqual([1, 3]);
    await runtime.stopAndDrain();
  });
});

describe('unrealizedLossMonitor directional execution', () => {
  it('writes seatVersion into the liquidation signal', async () => {
    const executedSignals: Array<{ readonly seatVersion: number | null; readonly action: string }> =
      [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        for (const signal of signals) {
          executedSignals.push({
            seatVersion: signal.seatVersion ?? null,
            action: signal.action,
          });
        }

        return { submittedCount: signals.length, submittedOrderIds: [] };
      },
    });
    const riskChecker = createRiskCheckerDouble({
      checkUnrealizedLoss: () => ({
        shouldLiquidate: true,
        reason: 'test-liquidation',
        quantity: 1,
      }),
      refreshUnrealizedLossData: async () => ({ r1: 0, n1: 0 }),
    });
    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: 1,
    });

    await monitor.monitorDirectionalUnrealizedLoss({
      symbol: 'BULL.HK',
      isLong: true,
      monitorSymbol: 'HSI.HK',
      seatVersion: 7,
      quote: createQuoteDouble('BULL.HK', 1.23, 100),
      riskChecker,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
    });

    expect(executedSignals).toEqual([
      {
        seatVersion: 7,
        action: 'SELLCALL',
      },
    ]);
  });
});
