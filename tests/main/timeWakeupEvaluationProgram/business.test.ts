/**
 * timeWakeupEvaluationProgram 业务测试
 *
 * 覆盖单次时间唤醒评估的门禁状态、生命周期顺序与系统级唤醒候选输出。
 */
import { describe, expect, it } from 'bun:test';
import { TRADING } from '../../../src/constants/index.js';
import { timeWakeupEvaluationProgram } from '../../../src/main/timeWakeupEvaluationProgram/index.js';
import type { TimeWakeupEvaluationContext } from '../../../src/main/timeWakeupEvaluationProgram/types.js';
import type { LastState, MonitorContext } from '../../../src/types/state.js';
import type { MultiMonitorTradingConfig } from '../../../src/types/config.js';
import type { DayLifecycleTickResult } from '../../../src/main/lifecycle/types.js';
import type { DoomsdayClearanceResult } from '../../../src/core/doomsdayProtection/types.js';
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
  createQuoteSubscriptionRuntimeDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

type TimeWakeupEvaluationHarnessOptions = Readonly<{
  now: Date;
  initialCanTrade?: boolean | null;
  morningProtectionMinutes?: number | null;
  verifier?: DelayedSignalVerifierPort;
  lifecycleTick?: () => Promise<DayLifecycleTickResult>;
  emitGateStateChanged?: () => void;
  doomsdayClearanceResult?: DoomsdayClearanceResult;
  cachedTradingDayInfo?: LastState['cachedTradingDayInfo'];
  isTradingDay?: (date: Date) => Promise<TradingDayInfo>;
}>;

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

function createTradingConfig(morningProtectionMinutes: number | null): MultiMonitorTradingConfig {
  return {
    monitors: [createMonitorConfigDouble({ monitorSymbol: '700.HK' })],
    global: {
      doomsdayProtection: true,
      debug: false,
      openProtection: {
        morning: { enabled: morningProtectionMinutes !== null, minutes: morningProtectionMinutes },
        afternoon: { enabled: false, minutes: null },
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
    trader: createTraderDouble(),
    lastState,
    doomsdayProtection: createDoomsdayProtectionDouble({
      executeClearance: async () =>
        options.doomsdayClearanceResult ?? {
          executed: false,
          signalCount: 0,
          nextRetryAtMs: null,
        },
    }),
    tradingConfig: createTradingConfig(options.morningProtectionMinutes ?? null),
    monitorContexts,
    tradingGateEventRuntime: {
      emitGateStateChanged: options.emitGateStateChanged ?? (() => {}),
    },
    quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
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

  it('交易日查询失败时进入保护性暂停并安排重试候选', async () => {
    const now = new Date('2026-04-29T09:30:00.000+08:00');
    const staleTradingDayInfo = {
      dateKey: '2026-04-28',
      info: { isTradingDay: false, isHalfDay: false },
    };
    const context = createTimeWakeupEvaluationHarness({
      now,
      initialCanTrade: true,
      cachedTradingDayInfo: staleTradingDayInfo,
      isTradingDay: async () => {
        throw new Error('trading day unavailable');
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(context.lastState.canTrade).toBe(false);
    expect(context.lastState.isHalfDay).toBe(false);
    expect(context.lastState.cachedTradingDayInfo).toEqual(staleTradingDayInfo);
    expect(result.plan.candidates).toContainEqual({
      source: 'TRADING_GATE_EDGE',
      atMs: now.getTime() + TRADING.INTERVAL_MS,
    });
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
