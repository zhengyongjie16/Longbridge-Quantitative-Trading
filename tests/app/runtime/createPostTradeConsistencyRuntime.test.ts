/**
 * createPostTradeConsistencyRuntime 测试
 *
 * 覆盖最小成交后一致性运行时切片：启动前积压 stale、启动后消费刷新、
 * 以及 completeRebuildBaseline 的最小 freshness 推进行为。
 */
import { describe, expect, it } from 'bun:test';

import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import type { LastState } from '../../../src/types/state.js';

import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createMonitorContextDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

/**
 * 创建可由测试手动控制完成与失败时机的 Promise。
 *
 * @returns 暴露 promise、resolve 与 reject 的 deferred 对象
 */
function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

/**
 * 轮询等待条件成立。
 *
 * @param predicate 需要等待变为 true 的条件
 * @param timeoutMs 超时时间，默认 1000ms
 * @returns 条件成立时 resolve；超时则抛错
 */
async function waitForCondition(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition.');
    }

    await Bun.sleep(1);
  }
}

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-04-04',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  };
}

/**
 * 为运行时绑定最小业务依赖，满足 fail-fast 启动前置条件。
 *
 * @param runtime 待绑定的成交后一致性运行时
 */
function bindMinimalBusinessDeps(
  runtime: ReturnType<typeof createPostTradeConsistencyRuntime>,
): void {
  runtime.bindBusinessDeps({
    monitorContexts: new Map(),
    dailyLossTracker: createDailyLossTrackerDouble(),
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
  });
}

describe('createPostTradeConsistencyRuntime', () => {
  it('marks stale before start and consumes the backlog after start while emitting fresh reached event', async () => {
    const lastState = createLastState();
    let accountRefreshCalls = 0;
    let positionRefreshCalls = 0;
    const freshEvents: Array<{
      readonly currentVersion: number;
      readonly staleVersion: number;
      readonly trigger: 'REFRESH' | 'REBUILD_BASELINE';
    }> = [];

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountRefreshCalls += 1;
            return createAccountSnapshotDouble(88_000);
          },
          getStockPositions: async () => {
            positionRefreshCalls += 1;
            return [
              createPositionDouble({
                symbol: 'BULL.HK',
                quantity: 300,
                availableQuantity: 300,
              }),
            ];
          },
        }),
      lastState,
    });

    runtime.onFreshReached((event) => {
      freshEvents.push(event);
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    await Bun.sleep(30);

    expect(accountRefreshCalls).toBe(0);
    expect(positionRefreshCalls).toBe(0);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });

    runtime.start();
    await runtime.waitForFresh();
    await runtime.stopAndDrain();

    expect(accountRefreshCalls).toBe(1);
    expect(positionRefreshCalls).toBe(1);
    expect(lastState.cachedAccount?.buyPower).toBe(88_000);
    expect(lastState.cachedPositions).toHaveLength(1);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(300);
    expect(freshEvents).toEqual([
      {
        currentVersion: 1,
        staleVersion: 1,
        trigger: 'REFRESH',
      },
    ]);

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
  });

  it('awaits positions committed hook after writing latest positions', async () => {
    const lastState = createLastState();
    const committedSnapshots: Array<{
      readonly cachedPositionCount: number;
      readonly cacheQuantity: number | null;
    }> = [];
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(88_000),
          getStockPositions: async () => [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 300,
              availableQuantity: 300,
            }),
          ],
        }),
      lastState,
      onPositionsCommitted: async () => {
        await Bun.sleep(1);
        committedSnapshots.push({
          cachedPositionCount: lastState.cachedPositions.length,
          cacheQuantity: lastState.positionCache.get('BULL.HK')?.quantity ?? null,
        });
      },
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    runtime.start();
    await runtime.waitForFresh();
    await runtime.stopAndDrain();

    expect(committedSnapshots).toEqual([
      {
        cachedPositionCount: 1,
        cacheQuantity: 300,
      },
    ]);

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
  });

  it('retries to the latest stale version after an in-flight failure receives a newer settlement need', async () => {
    const lastState = createLastState();
    const firstAccountRefresh = createDeferred<ReturnType<typeof createAccountSnapshotDouble>>();
    const firstPositionRefresh =
      createDeferred<ReadonlyArray<ReturnType<typeof createPositionDouble>>>();
    let accountRefreshCalls = 0;
    let positionRefreshCalls = 0;

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountRefreshCalls += 1;
            if (accountRefreshCalls === 1) {
              return firstAccountRefresh.promise;
            }

            return createAccountSnapshotDouble(99_000);
          },
          getStockPositions: async () => {
            positionRefreshCalls += 1;
            if (positionRefreshCalls === 1) {
              return firstPositionRefresh.promise;
            }

            return [
              createPositionDouble({
                symbol: 'BULL.HK',
                quantity: 500,
                availableQuantity: 500,
              }),
            ];
          },
        }),
      lastState,
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    runtime.start();

    await waitForCondition(() => accountRefreshCalls === 1);

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    const staleStatus = runtime.getStatus();
    expect(staleStatus.staleVersion).toBe(2);
    expect(staleStatus.currentVersion).toBe(0);

    firstAccountRefresh.reject(
      createExternalApiRequestError({
        operation: 'TradeContext.accountBalance',
        attempts: 1,
        cause: new Error('first refresh fails'),
      }),
    );

    firstPositionRefresh.resolve([
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    ]);

    await runtime.waitForFresh();

    expect(accountRefreshCalls).toBe(2);
    expect(positionRefreshCalls).toBe(2);
    expect(lastState.cachedAccount?.buyPower).toBe(99_000);
    expect(lastState.cachedPositions).toHaveLength(1);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(500);
    expect(runtime.getStatus()).toEqual({
      started: true,
      currentVersion: 2,
      staleVersion: 2,
    });

    await runtime.waitForFresh();
    await runtime.stopAndDrain();
  });

  it('retries failed refresh and still refreshes all currently attributed seat symbols after recovery', async () => {
    const lastState = createLastState();
    let accountCallCount = 0;
    const refreshedSymbols: string[] = [];

    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        maxUnrealizedLossPerSymbol: 2_000,
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
          status: 'ACTIVE',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
      }),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble({
        getLossOffset: () => 0,
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async (_orderRecorder, symbol) => {
          refreshedSymbols.push(symbol);
          return { r1: 100, n1: 100 };
        },
      }),
    });

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountCallCount += 1;
            if (accountCallCount === 1) {
              throw createExternalApiRequestError({
                operation: 'TradeContext.accountBalance',
                attempts: 1,
                cause: new Error('account API temporary unavailable'),
              });
            }

            return createAccountSnapshotDouble(66_000);
          },
          getStockPositions: async () => [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 300,
              availableQuantity: 300,
            }),
          ],
        }),
      lastState,
    });
    runtime.bindBusinessDeps({
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      dailyLossTracker: createDailyLossTrackerDouble(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    runtime.start();
    await runtime.waitForFresh();
    await runtime.stopAndDrain();

    expect(accountCallCount).toBeGreaterThanOrEqual(2);
    expect(new Set(refreshedSymbols)).toEqual(new Set(['BULL.HK', 'BEAR.HK']));
    expect(lastState.cachedAccount?.buyPower).toBe(66_000);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
  });

  it('fails fast when account refresh hits TypeError and exposes the fatal channel immediately', async () => {
    const lastState = createLastState();
    let accountCallCount = 0;
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountCallCount += 1;
            throw new TypeError('TradeContext.accountBalance returned no primary account');
          },
          getStockPositions: async () => [],
        }),
      lastState,
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: false,
    });

    const waiterResult = runtime.waitForFresh().then(
      () => null,
      (error: unknown) => error,
    );
    const fatalResult = runtime.drainFatalError().then(
      () => null,
      (error: unknown) => error,
    );

    runtime.start();

    const waitError = await waiterResult;
    const fatalError = await fatalResult;
    let drainError: unknown = null;
    try {
      await runtime.stopAndDrain();
    } catch (error) {
      drainError = error;
    }

    expect(fatalError).toBeInstanceOf(TypeError);
    expect((fatalError as Error).message).toBe(
      'TradeContext.accountBalance returned no primary account',
    );
    expect(drainError).toBeInstanceOf(TypeError);
    expect((drainError as Error).message).toBe(
      'TradeContext.accountBalance returned no primary account',
    );
    expect(waitError).toBeInstanceOf(Error);
    expect((waitError as Error).message).toBe(
      '[postTradeConsistencyRuntime] freshness wait aborted: FATAL_INVARIANT',
    );
    expect(accountCallCount).toBe(1);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('fails fast when positions committed hook throws ordinary Error', async () => {
    const lastState = createLastState();
    const internalError = new Error('position commit failed');
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(100),
          getStockPositions: async () => [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 1,
              availableQuantity: 1,
            }),
          ],
        }),
      lastState,
      onPositionsCommitted: async () => {
        throw internalError;
      },
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    runtime.start();
    const fatalResult = await Promise.race([
      runtime.drainFatalError().then(
        () => null,
        (error: unknown) => error,
      ),
      Bun.sleep(80).then(() => null),
    ]);

    let drainError: unknown = null;
    try {
      await runtime.stopAndDrain();
    } catch (error) {
      drainError = error;
    }

    expect(fatalResult).toBe(internalError);
    expect(drainError).toBe(internalError);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('fails fast when unrealized loss refresh returns null', async () => {
    const lastState = createLastState();
    let riskRefreshCallCount = 0;
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
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
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          riskRefreshCallCount += 1;
          return null;
        },
      }),
    });
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(100),
          getStockPositions: async () => [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 1,
              availableQuantity: 1,
            }),
          ],
        }),
      lastState,
    });

    runtime.bindBusinessDeps({
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      dailyLossTracker: createDailyLossTrackerDouble(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    runtime.start();
    let caught: unknown = null;
    try {
      await runtime.drainFatalError();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(riskRefreshCallCount).toBe(1);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('fails fast when unrealized loss refresh hits TypeError and does not schedule retry', async () => {
    const lastState = createLastState();
    let accountCallCount = 0;
    let riskRefreshCallCount = 0;

    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
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
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          riskRefreshCallCount += 1;
          throw new TypeError('refresh unrealized loss contract violated');
        },
      }),
    });

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountCallCount += 1;
            return createAccountSnapshotDouble(77_000);
          },
          getStockPositions: async () => [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 300,
              availableQuantity: 300,
            }),
          ],
        }),
      lastState,
    });

    runtime.bindBusinessDeps({
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      dailyLossTracker: createDailyLossTrackerDouble(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    const waiterResult = runtime.waitForFresh().then(
      () => null,
      (error: unknown) => error,
    );

    runtime.start();

    const waitError = await waiterResult;
    let drainError: unknown = null;
    try {
      await runtime.stopAndDrain();
    } catch (error) {
      drainError = error;
    }

    expect(drainError).toBeInstanceOf(TypeError);
    expect((drainError as Error).message).toBe('refresh unrealized loss contract violated');
    expect(waitError).toBeInstanceOf(Error);
    expect((waitError as Error).message).toBe(
      '[postTradeConsistencyRuntime] freshness wait aborted: FATAL_INVARIANT',
    );
    expect(accountCallCount).toBe(1);
    expect(riskRefreshCallCount).toBe(1);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('completes protective liquidation episodes and advances daily loss plus cooldown after positions refresh', async () => {
    const lastState = createLastState();
    const startNewProtectionEpisodeCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      boundaryExecutedTimeMs: number;
    }> = [];
    const cooldownCalls: Array<{
      symbol: string;
      direction: 'LONG' | 'SHORT';
      executedTimeMs: number;
      triggerLimit: number;
    }> = [];
    const riskRefreshCalls: Array<{
      symbol: string;
      isLongSymbol: boolean;
      dailyLossOffset: number | undefined;
    }> = [];
    const protectiveBoundaryMs = 1_712_222_333_000;

    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        liquidationTriggerLimit: 2,
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
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble({
        getLossOffset: () => 88,
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async (
          _orderRecorder,
          symbol,
          isLongSymbol,
          _quote,
          dailyLossOffset,
        ) => {
          riskRefreshCalls.push({ symbol, isLongSymbol, dailyLossOffset });
          return { r1: 1, n1: 2 };
        },
      }),
    });

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(77_000),
          getStockPositions: async () => [],
          hasPendingProtectiveLiquidationOrders: () => false,
        }),
      lastState,
    });
    runtime.bindBusinessDeps({
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      dailyLossTracker: createDailyLossTrackerDouble({
        startNewProtectionEpisode: (params) => {
          startNewProtectionEpisodeCalls.push(params);
        },
      }),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        recordLiquidationTrigger: (params) => {
          cooldownCalls.push({
            symbol: params.symbol,
            direction: params.direction,
            executedTimeMs: params.executedTimeMs,
            triggerLimit: params.triggerLimit,
          });
          return {
            currentCount: 2,
            cooldownActivated: true,
          };
        },
      }),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
        getInProgressEpisodes: () => [
          {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            symbol: 'BULL.HK',
            latestExecutedTimeMs: protectiveBoundaryMs,
          },
        ],
        completeIfEligible: () => ({
          monitorSymbol: 'HSI.HK',
          direction: 'LONG',
          boundaryExecutedTimeMs: protectiveBoundaryMs,
        }),
      }),
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    runtime.start();
    await runtime.waitForFresh();
    await runtime.stopAndDrain();

    expect(lastState.cachedAccount?.buyPower).toBe(77_000);
    expect(lastState.cachedPositions).toEqual([]);
    expect(startNewProtectionEpisodeCalls).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        boundaryExecutedTimeMs: protectiveBoundaryMs,
      },
    ]);

    expect(cooldownCalls).toEqual([
      {
        symbol: 'HSI.HK',
        direction: 'LONG',
        executedTimeMs: protectiveBoundaryMs,
        triggerLimit: 2,
      },
    ]);

    expect(riskRefreshCalls).toEqual([
      {
        symbol: 'BULL.HK',
        isLongSymbol: true,
        dailyLossOffset: 88,
      },
    ]);
  });

  it('fails fast when start is called before bindBusinessDeps', () => {
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () => createTraderDouble(),
      lastState: createLastState(),
    });

    expect(() => {
      runtime.start();
    }).toThrow('[postTradeConsistencyRuntime] businessDeps 尚未绑定，禁止启动');
  });

  it('fails fast and stops retrying when attributed seat symbols are duplicated', async () => {
    const lastState = createLastState();
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
    const duplicateMonitorContexts = new Map([
      [
        'HSI.HK',
        createMonitorContextDouble({
          config: createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' }),
          symbolRegistry,
        }),
      ],
      [
        'TECH.HK',
        createMonitorContextDouble({
          config: createMonitorConfigDouble({ monitorSymbol: 'TECH.HK' }),
          symbolRegistry,
        }),
      ],
    ]);
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(10_000),
          getStockPositions: async () => [],
        }),
      lastState,
    });
    expect(() => {
      runtime.bindBusinessDeps({
        monitorContexts: duplicateMonitorContexts,
        dailyLossTracker: createDailyLossTrackerDouble(),
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      });
    }).toThrow('重复归属');
  });

  it('completeRebuildBaseline advances freshness only after pending work is cleared and emits rebuild baseline event', () => {
    const freshEvents: Array<{
      readonly currentVersion: number;
      readonly staleVersion: number;
      readonly trigger: 'REFRESH' | 'REBUILD_BASELINE';
    }> = [];
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () => createTraderDouble(),
      lastState: createLastState(),
    });

    runtime.onFreshReached((event) => {
      freshEvents.push(event);
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: false,
    });
    runtime.completeRebuildBaseline();

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
    expect(freshEvents).toEqual([]);

    runtime.midnightClear();
    runtime.completeRebuildBaseline();

    expect(freshEvents).toEqual([
      {
        currentVersion: 1,
        staleVersion: 1,
        trigger: 'REBUILD_BASELINE',
      },
    ]);

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
  });

  it('aborts waiters without marking fresh during shutdown', async () => {
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () => createTraderDouble(),
      lastState: createLastState(),
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    const waiter = runtime.waitForFresh();
    runtime.abortWaiting();

    expect(waiter).rejects.toThrow(
      '[postTradeConsistencyRuntime] freshness wait aborted: STOP_AND_DRAIN',
    );

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('does not report fatal when shutdown aborts waiters during a successful in-flight refresh', async () => {
    const lastState = createLastState();
    const accountRefresh = createDeferred<ReturnType<typeof createAccountSnapshotDouble>>();
    let accountRefreshCalls = 0;
    const freshEvents: Array<{
      readonly currentVersion: number;
      readonly staleVersion: number;
      readonly trigger: 'REFRESH' | 'REBUILD_BASELINE';
    }> = [];

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountRefreshCalls += 1;
            return accountRefresh.promise;
          },
          getStockPositions: async () => [],
        }),
      lastState,
    });

    runtime.onFreshReached((event) => {
      freshEvents.push(event);
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: false,
    });
    runtime.start();

    await waitForCondition(() => accountRefreshCalls === 1);
    runtime.abortWaiting();
    accountRefresh.resolve(createAccountSnapshotDouble(66_000));

    await runtime.stopAndDrain();

    expect(freshEvents).toEqual([]);
    expect(lastState.cachedAccount?.buyPower).toBe(66_000);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('continues consuming late settlement refresh after shutdown aborts waiters', async () => {
    const lastState = createLastState();
    const accountRefresh = createDeferred<ReturnType<typeof createAccountSnapshotDouble>>();
    let accountRefreshCalls = 0;
    const freshEvents: Array<{
      readonly currentVersion: number;
      readonly staleVersion: number;
      readonly trigger: 'REFRESH' | 'REBUILD_BASELINE';
    }> = [];

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountRefreshCalls += 1;
            return accountRefresh.promise;
          },
          getStockPositions: async () => [],
        }),
      lastState,
    });

    runtime.onFreshReached((event) => {
      freshEvents.push(event);
    });

    bindMinimalBusinessDeps(runtime);
    runtime.start();
    runtime.abortWaiting();

    expect(() => {
      runtime.recordSettlementRefreshNeed({
        refreshAccount: true,
        refreshPositions: false,
      });
    }).not.toThrow();

    await waitForCondition(() => accountRefreshCalls === 1);
    accountRefresh.resolve(createAccountSnapshotDouble(55_000));

    await runtime.stopAndDrain();

    expect(freshEvents).toEqual([]);
    expect(lastState.cachedAccount?.buyPower).toBe(55_000);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('does not complete protective liquidation when original liquidation symbol still has position after seat switch', async () => {
    const lastState = createLastState();
    const startNewProtectionEpisodeCalls: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      boundaryExecutedTimeMs: number;
    }> = [];
    const cooldownCalls: Array<{
      symbol: string;
      direction: 'LONG' | 'SHORT';
      executedTimeMs: number;
    }> = [];
    const protectiveBoundaryMs = 1_712_222_333_000;

    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        liquidationTriggerLimit: 2,
      }),
      symbolRegistry: createSymbolRegistryDouble({
        monitorSymbol: 'HSI.HK',
        longSeat: {
          symbol: 'BULL.NEW.HK',
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
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble({
        getLossOffset: () => 0,
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => ({ r1: 1, n1: 2 }),
      }),
    });

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(77_000),
          getStockPositions: async () => [
            createPositionDouble({
              symbol: 'BULL.OLD.HK',
              quantity: 100,
              availableQuantity: 100,
            }),
          ],
          hasPendingProtectiveLiquidationOrders: () => false,
        }),
      lastState,
    });
    runtime.bindBusinessDeps({
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      dailyLossTracker: createDailyLossTrackerDouble({
        startNewProtectionEpisode: (params) => {
          startNewProtectionEpisodeCalls.push(params);
        },
      }),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        recordLiquidationTrigger: (params) => {
          cooldownCalls.push({
            symbol: params.symbol,
            direction: params.direction,
            executedTimeMs: params.executedTimeMs,
          });
          return {
            currentCount: 1,
            cooldownActivated: false,
          };
        },
      }),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
        getInProgressEpisodes: () => [
          {
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            symbol: 'BULL.OLD.HK',
            latestExecutedTimeMs: protectiveBoundaryMs,
          },
        ],
        completeIfEligible: ({ isDirectionFlat }) =>
          isDirectionFlat
            ? {
                monitorSymbol: 'HSI.HK',
                direction: 'LONG',
                boundaryExecutedTimeMs: protectiveBoundaryMs,
              }
            : null,
      }),
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    runtime.start();
    await runtime.waitForFresh();
    await runtime.stopAndDrain();

    expect(startNewProtectionEpisodeCalls).toEqual([]);
    expect(cooldownCalls).toEqual([]);
  });
});
