/**
 * timeWakeupEvaluationProgram 业务测试
 *
 * 覆盖单次时间唤醒评估的门禁状态、生命周期顺序与系统级唤醒候选输出。
 */
import { describe, expect, it } from 'bun:test';
import { timeWakeupEvaluationProgram } from '../../../src/main/timeWakeupEvaluationProgram/index.js';
import { createExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import type { TimeWakeupEvaluationContext } from '../../../src/main/timeWakeupEvaluationProgram/types.js';
import type { LastState, MonitorContext } from '../../../src/types/state.js';
import type { MultiMonitorTradingConfig } from '../../../src/types/config.js';
import type {
  DayLifecycleTickResult,
  LifecycleRuntimeFlags,
} from '../../../src/main/lifecycle/types.js';
import type {
  CancelPendingBuyOrdersResult,
  DoomsdayClearanceResult,
} from '../../../src/core/doomsdayProtection/types.js';
import type { DelayedSignalVerifierPort } from '../../../src/types/monitorContextPorts.js';
import type { TradingDayInfo } from '../../../src/types/services.js';
import {
  createAccountSnapshotDouble,
  createDelayedSignalVerifierDouble,
  createDoomsdayProtectionDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteSubscriptionRuntimeDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

type TimeWakeupEvaluationHarnessOptions = Readonly<{
  now: Date;
  initialCanTrade?: boolean | null;
  morningProtectionMinutes?: number | null;
  afternoonProtectionMinutes?: number | null;
  verifier?: DelayedSignalVerifierPort;
  lifecycleTick?: (now: Date, runtime: LifecycleRuntimeFlags) => Promise<DayLifecycleTickResult>;
  emitGateStateChanged?: () => void;
  doomsdayClearanceResult?: DoomsdayClearanceResult;
  cancelPendingBuyOrdersResult?: CancelPendingBuyOrdersResult;
  onCancelPendingBuyOrders?: () => void;
  onExecuteClearance?: () => void;
  onPositionsCommitted?: () => void;
  executeClearanceError?: Error;
  traderOverrides?: Parameters<typeof createTraderDouble>[0];
  cachedTradingDayInfo?: LastState['cachedTradingDayInfo'];
  isTradingDay?: (date: Date) => Promise<TradingDayInfo>;
}>;

async function expectPromiseRejectsWithMessage(
  promise: Promise<unknown>,
  expectedMessagePattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw new Error(`[测试] 预期 Promise 以 Error 拒绝，实际为: ${String(error)}`, {
        cause: error,
      });
    }

    expect(error.message).toMatch(expectedMessagePattern);
    return;
  }

  throw new Error('[测试] 预期 Promise 拒绝，但实际成功');
}

function createLastState(
  options: Pick<TimeWakeupEvaluationHarnessOptions, 'initialCanTrade' | 'cachedTradingDayInfo'>,
): LastState {
  return {
    canTrade: options.initialCanTrade ?? false,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-04-29',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: createAccountSnapshotDouble(100_000),
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: options.cachedTradingDayInfo ?? {
      dateKey: '2026-04-29',
      info: {
        isTradingDay: true,
        isHalfDay: false,
      },
    },
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  };
}

function createTradingConfig(
  morningProtectionMinutes: number | null,
  afternoonProtectionMinutes: number | null,
): MultiMonitorTradingConfig {
  return {
    monitors: [createMonitorConfigDouble({ monitorSymbol: '700.HK' })],
    global: {
      doomsdayProtection: true,
      debug: false,
      openProtection: {
        morning: { enabled: morningProtectionMinutes !== null, minutes: morningProtectionMinutes },
        afternoon: {
          enabled: afternoonProtectionMinutes !== null,
          minutes: afternoonProtectionMinutes,
        },
      },
      orderMonitorPriceUpdateInterval: 1,
      allowBuyOrderTrackingAboveInitialPrice: false,
      tradingOrderType: 'ELO',
      liquidationOrderType: 'ELO',
      buyOrderTimeout: { enabled: false, timeoutSeconds: 0 },
      sellOrderTimeout: { enabled: false, timeoutSeconds: 0 },
    },
  };
}

function createTimeWakeupEvaluationHarness(
  options: TimeWakeupEvaluationHarnessOptions,
): TimeWakeupEvaluationContext {
  const lastState = createLastState(options);
  const monitorConfig = createMonitorConfigDouble({ monitorSymbol: '700.HK' });
  const monitorContext = createMonitorContextDouble({
    config: monitorConfig,
    ...(options.verifier ? { delayedSignalVerifier: options.verifier } : {}),
  });
  const monitorContexts = new Map<string, MonitorContext>([
    [monitorConfig.monitorSymbol, monitorContext],
  ]);

  return {
    marketDataClient: createMarketDataClientDouble({
      isTradingDay:
        options.isTradingDay ?? (async () => ({ isTradingDay: true, isHalfDay: false })),
    }),
    trader: createTraderDouble(options.traderOverrides),
    lastState,
    doomsdayProtection: createDoomsdayProtectionDouble({
      cancelPendingBuyOrders: async () => {
        options.onCancelPendingBuyOrders?.();
        return (
          options.cancelPendingBuyOrdersResult ?? {
            executed: false,
            cancelRequestAcceptedCount: 0,
            nextRetryAtMs: null,
          }
        );
      },
      executeClearance: async (clearanceContext) => {
        options.onExecuteClearance?.();
        if (options.executeClearanceError !== undefined) {
          throw options.executeClearanceError;
        }

        await clearanceContext.onPositionsCommitted?.();
        return (
          options.doomsdayClearanceResult ?? {
            executed: false,
            signalCount: 0,
            nextRetryAtMs: null,
          }
        );
      },
    }),
    tradingConfig: createTradingConfig(
      options.morningProtectionMinutes ?? null,
      options.afternoonProtectionMinutes ?? null,
    ),
    monitorContexts,
    tradingGateEventRuntime: {
      emitGateStateChanged: options.emitGateStateChanged ?? (() => {}),
    },
    quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
      reconcilePositionHoldFromCurrentTruth: async () => {
        options.onPositionsCommitted?.();
      },
    }),
    dayLifecycleManager: {
      tick:
        options.lifecycleTick ??
        (async () => ({
          nextRetryAtMs: null,
          pendingOpenRebuild: false,
        })),
    },
    now: () => options.now,
  };
}

describe('timeWakeupEvaluationProgram', () => {
  it('交易日 API 失败时只安排 API_RETRY 且不更新交易门禁事实', async () => {
    let gateEmitted = false;
    let lifecycleCalled = false;
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      initialCanTrade: false,
      cachedTradingDayInfo: null,
      isTradingDay: async () => {
        throw createExternalApiRequestError({
          operation: 'test.isTradingDay',
          attempts: 1,
          cause: new Error('calendar unavailable'),
        });
      },
      lifecycleTick: async () => {
        lifecycleCalled = true;
        return { nextRetryAtMs: null, pendingOpenRebuild: false };
      },
      emitGateStateChanged: () => {
        gateEmitted = true;
      },
    });
    context.lastState.cachedTradingDayInfo = null;

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.hasWork).toBe(true);
    expect(result.plan.candidates.some((candidate) => candidate.source === 'API_RETRY')).toBe(true);
    expect(context.lastState.cachedTradingDayInfo).toBeNull();
    expect(context.lastState.canTrade).toBe(false);
    expect(gateEmitted).toBe(false);
    expect(lifecycleCalled).toBe(false);
  });

  it('交易日非 API 错误保持 fail-fast', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      cachedTradingDayInfo: null,
      isTradingDay: async () => {
        throw new TypeError('calendar contract broken');
      },
    });
    context.lastState.cachedTradingDayInfo = null;

    await expectPromiseRejectsWithMessage(
      timeWakeupEvaluationProgram(context),
      /calendar contract broken/,
    );
  });

  it('生命周期 API 失败时只安排 API_RETRY 且不提前提交交易门禁变化', async () => {
    let gateEmitted = false;
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      initialCanTrade: false,
      lifecycleTick: async () => {
        throw createExternalApiRequestError({
          operation: 'test.lifecycle',
          attempts: 1,
          cause: new Error('rebuild unavailable'),
        });
      },
      emitGateStateChanged: () => {
        gateEmitted = true;
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.hasWork).toBe(true);
    expect(result.plan.candidates.some((candidate) => candidate.source === 'API_RETRY')).toBe(true);
    expect(context.lastState.canTrade).toBe(false);
    expect(gateEmitted).toBe(false);
  });

  it('在 lifecycle tick 后发布 gate event', async () => {
    const calls: string[] = [];
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      initialCanTrade: false,
      lifecycleTick: async () => {
        calls.push('lifecycle');
        return { nextRetryAtMs: null, pendingOpenRebuild: false };
      },
      emitGateStateChanged: () => {
        calls.push('gate');
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(calls).toEqual(['lifecycle', 'gate']);
  });

  it('开盘保护保持 canTrade 为 true 且只标记 openProtectionActive', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:31:00.000+08:00'),
      morningProtectionMinutes: 5,
    });

    await timeWakeupEvaluationProgram(context);

    expect(context.lastState.canTrade).toBe(true);
    expect(context.lastState.openProtectionActive).toBe(true);
  });

  it('12:00 关闭连续交易门禁并取消普通延迟验证', async () => {
    const cancelAllCalls: string[] = [];
    const verifier = createDelayedSignalVerifierDouble({
      getPendingCount: () => 2,
      cancelAllForSymbol: (monitorSymbol) => {
        cancelAllCalls.push(monitorSymbol);
      },
    });
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T12:00:00.000+08:00'),
      initialCanTrade: true,
      verifier,
    });

    await timeWakeupEvaluationProgram(context);

    expect(context.lastState.canTrade).toBe(false);
    expect(cancelAllCalls).toEqual(['700.HK']);
  });

  it('返回包含 lifecycle 与 doomsday retry 候选的 planner 输出', async () => {
    const now = new Date('2026-04-29T15:56:00.000+08:00');
    const context = createTimeWakeupEvaluationHarness({
      now,
      lifecycleTick: async () => ({
        nextRetryAtMs: now.getTime() + 30_000,
        pendingOpenRebuild: false,
      }),
      doomsdayClearanceResult: {
        executed: false,
        signalCount: 0,
        nextRetryAtMs: now.getTime() + 45_000,
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'LIFECYCLE_RETRY',
      atMs: now.getTime() + 30_000,
    });

    expect(result.plan.candidates).toContainEqual({
      source: 'DOOMSDAY_RETRY',
      atMs: now.getTime() + 45_000,
    });
  });

  it('不复用非当前 HK 日期的交易日缓存', async () => {
    const queriedDates: string[] = [];
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      cachedTradingDayInfo: {
        dateKey: '2026-04-28',
        info: { isTradingDay: false, isHalfDay: false },
      },
      isTradingDay: async (date) => {
        queriedDates.push(date.toISOString());
        return { isTradingDay: true, isHalfDay: false };
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(queriedDates).toHaveLength(1);
    expect(context.lastState.cachedTradingDayInfo).toEqual({
      dateKey: '2026-04-29',
      info: { isTradingDay: true, isHalfDay: false },
    });
    expect(context.lastState.canTrade).toBe(true);
  });

  it('交易日查询失败时向上抛出且不制造系统级 recovery 候选', async () => {
    const staleTradingDayInfo = {
      dateKey: '2026-04-28',
      info: { isTradingDay: false, isHalfDay: false },
    };
    const lifecycleRuntimeFlags: LifecycleRuntimeFlags[] = [];
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      initialCanTrade: true,
      cachedTradingDayInfo: staleTradingDayInfo,
      isTradingDay: async () => {
        throw new Error('trading day unavailable');
      },
      lifecycleTick: async (_now, runtime) => {
        lifecycleRuntimeFlags.push(runtime);
        return { nextRetryAtMs: null, pendingOpenRebuild: false };
      },
    });

    await expectPromiseRejectsWithMessage(
      timeWakeupEvaluationProgram(context),
      /trading day unavailable/,
    );
    expect(context.lastState.canTrade).toBe(true);
    expect(context.lastState.cachedTradingDayInfo).toEqual(staleTradingDayInfo);
    expect(lifecycleRuntimeFlags).toEqual([]);
  });

  it('非交易日关闭连续交易门禁且不生成盘中边界候选', async () => {
    const lifecycleRuntimeFlags: LifecycleRuntimeFlags[] = [];
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      initialCanTrade: true,
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: false, isHalfDay: false },
      },
      lifecycleTick: async (_now, runtime) => {
        lifecycleRuntimeFlags.push(runtime);
        return { nextRetryAtMs: null, pendingOpenRebuild: false };
      },
    });

    const result = await timeWakeupEvaluationProgram(context);
    const candidateSources = result.plan.candidates.map((candidate) => candidate.source);

    expect(context.lastState.canTrade).toBe(false);
    expect(lifecycleRuntimeFlags).toEqual([
      {
        dayKey: '2026-04-29',
        canTradeNow: false,
        isTradingDay: false,
      },
    ]);
    expect(candidateSources).not.toContain('TRADING_GATE_EDGE');
    expect(candidateSources).not.toContain('OPEN_PROTECTION_EDGE');
    expect(candidateSources).not.toContain('MARKET_CLOSE_EDGE');
    expect(candidateSources).not.toContain('DOOMSDAY_WINDOW_ENTRY');
  });

  it('在开盘前返回交易门禁边界候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:29:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'TRADING_GATE_EDGE',
      atMs: new Date('2026-04-29T09:30:00.000+08:00').getTime(),
    });
  });

  it('正常日上午返回 12:00 午休交易门禁边界候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:35:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'TRADING_GATE_EDGE',
      atMs: new Date('2026-04-29T12:00:00.000+08:00').getTime(),
    });
  });

  it('正常日午休返回 13:00 午后交易门禁边界候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T12:00:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'TRADING_GATE_EDGE',
      atMs: new Date('2026-04-29T13:00:00.000+08:00').getTime(),
    });
  });

  it('半日市上午返回 12:00 收盘交易门禁边界候选且无 13:00 候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T11:59:00.000+08:00'),
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: true, isHalfDay: true },
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'TRADING_GATE_EDGE',
      atMs: new Date('2026-04-29T12:00:00.000+08:00').getTime(),
    });

    expect(result.plan.candidates).not.toContainEqual({
      source: 'TRADING_GATE_EDGE',
      atMs: new Date('2026-04-29T13:00:00.000+08:00').getTime(),
    });
  });

  it('在开盘保护窗口内返回保护结束候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:31:00.000+08:00'),
      morningProtectionMinutes: 5,
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'OPEN_PROTECTION_EDGE',
      atMs: new Date('2026-04-29T09:35:00.000+08:00').getTime(),
    });
  });

  it('正常日午盘开盘保护只标记保护状态并返回保护结束候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T13:01:00.000+08:00'),
      afternoonProtectionMinutes: 5,
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(context.lastState.canTrade).toBe(true);
    expect(context.lastState.openProtectionActive).toBe(true);
    expect(result.plan.candidates).toContainEqual({
      source: 'OPEN_PROTECTION_EDGE',
      atMs: new Date('2026-04-29T13:05:00.000+08:00').getTime(),
    });
  });

  it('半日市不生成午盘开盘保护候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T13:01:00.000+08:00'),
      afternoonProtectionMinutes: 5,
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: true, isHalfDay: true },
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(context.lastState.openProtectionActive).toBe(false);
    expect(result.plan.candidates).not.toContainEqual({
      source: 'OPEN_PROTECTION_EDGE',
      atMs: new Date('2026-04-29T13:05:00.000+08:00').getTime(),
    });
  });

  it('在收盘前返回市场收盘边界候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:59:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'MARKET_CLOSE_EDGE',
      atMs: new Date('2026-04-29T16:00:00.000+08:00').getTime(),
    });
  });

  it('正常日下午 13:05 返回末日保护买入截止入口候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T13:05:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'DOOMSDAY_WINDOW_ENTRY',
      atMs: new Date('2026-04-29T15:45:00.000+08:00').getTime(),
    });
  });

  it('末日买入截止窗口内调用买单撤单 action', async () => {
    const calls: string[] = [];
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:46:00.000+08:00'),
      onCancelPendingBuyOrders: () => {
        calls.push('cancelPendingBuyOrders');
      },
      cancelPendingBuyOrdersResult: {
        executed: true,
        cancelRequestAcceptedCount: 1,
        nextRetryAtMs: null,
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(calls).toEqual(['cancelPendingBuyOrders']);
  });

  it('正常日 15:50 返回末日保护清仓接管入口候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:50:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'DOOMSDAY_WINDOW_ENTRY',
      atMs: new Date('2026-04-29T15:55:00.000+08:00').getTime(),
    });
  });

  it('末日清仓接管窗口内执行清仓 action 并按返回值规划 retry', async () => {
    const calls: string[] = [];
    const retryAtMs = new Date('2026-04-29T15:57:00.000+08:00').getTime();
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:56:00.000+08:00'),
      onExecuteClearance: () => {
        calls.push('executeClearance');
      },
      onPositionsCommitted: () => {
        calls.push('reconcilePositionHold');
      },
      doomsdayClearanceResult: {
        executed: false,
        signalCount: 1,
        nextRetryAtMs: retryAtMs,
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(calls).toEqual(['executeClearance', 'reconcilePositionHold']);
    expect(result.plan.candidates).toContainEqual({
      source: 'DOOMSDAY_RETRY',
      atMs: retryAtMs,
    });
  });

  it('末日清仓 submitOrder 结果未知后刷新事实并拒绝系统级重复提交', async () => {
    const refreshedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 0, availableQuantity: 0 }),
    ];
    const calls: string[] = [];
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:56:00.000+08:00'),
      executeClearanceError: createExternalApiRequestError({
        operation: 'TradeContext.submitOrder',
        attempts: 1,
        cause: new Error('submit outcome unknown'),
      }),
      traderOverrides: {
        fetchAllOrdersFromAPI: async (forceRefresh) => {
          calls.push(`fetchAllOrders:${String(forceRefresh)}`);
          return [];
        },
        getStockPositions: async () => {
          calls.push('getStockPositions');
          return refreshedPositions;
        },
      },
      onPositionsCommitted: () => {
        calls.push('reconcilePositionHold');
      },
    });
    context.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ];
    context.lastState.positionCache.update(context.lastState.cachedPositions);

    let caught: unknown = null;
    try {
      await timeWakeupEvaluationProgram(context);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'ExternalApiRequestError',
      operation: 'TradeContext.submitOrder',
    });

    expect(calls).toEqual(['fetchAllOrders:true', 'getStockPositions', 'reconcilePositionHold']);
    expect(context.lastState.cachedPositions).toEqual(refreshedPositions);
    expect(context.lastState.positionCache.get('BULL.HK')).toEqual(refreshedPositions[0] ?? null);
  });

  it('半日市返回 11:45 与 11:55 末日保护窗口入口候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T11:40:00.000+08:00'),
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: true, isHalfDay: true },
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'DOOMSDAY_WINDOW_ENTRY',
      atMs: new Date('2026-04-29T11:45:00.000+08:00').getTime(),
    });

    expect(result.plan.candidates).toContainEqual({
      source: 'DOOMSDAY_WINDOW_ENTRY',
      atMs: new Date('2026-04-29T11:55:00.000+08:00').getTime(),
    });
  });

  it('收盘后仍返回下一 HK day boundary 候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T16:01:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'HK_DAY_BOUNDARY',
      atMs: new Date('2026-04-30T00:00:00.000+08:00').getTime(),
    });
  });

  it('同日交易日缓存命中时不调用 marketDataClient.isTradingDay', async () => {
    let queryCount = 0;
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: true, isHalfDay: false },
      },
      isTradingDay: async () => {
        queryCount += 1;
        return { isTradingDay: true, isHalfDay: false };
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(queryCount).toBe(0);
  });

  it('将待开盘重建解析为下一个连续交易开盘候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T16:01:00.000+08:00'),
      lifecycleTick: async () => ({ nextRetryAtMs: null, pendingOpenRebuild: true }),
    });
    context.lastState.tradingCalendarSnapshot = new Map([
      ['2026-04-29', { isTradingDay: true, isHalfDay: false }],
      ['2026-04-30', { isTradingDay: true, isHalfDay: false }],
    ]);

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.candidates).toContainEqual({
      source: 'LIFECYCLE_RETRY',
      atMs: new Date('2026-04-30T09:30:00.000+08:00').getTime(),
    });
  });
});
