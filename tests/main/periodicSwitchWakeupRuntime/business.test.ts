/**
 * PeriodicSwitchWakeupRuntime 业务测试
 *
 * 覆盖周期换标 due timer 的 ownership、baseline 隔离、waiting-empty 显式唤醒与 stop 清理语义。
 */
import { describe, expect, it } from 'bun:test';
import { createPeriodicSwitchWakeupRuntime } from '../../../src/main/periodicSwitchWakeupRuntime/index.js';
import {
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import type { MonitorConfig } from '../../../src/types/config.js';
import type { SeatState } from '../../../src/types/seat.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type {
  OrderStateChangedEvent,
  PostTradeConsistencyFreshReachedEvent,
  Unsubscribe,
} from '../../../src/types/services.js';
import type { TradingGateStateChangedEvent } from '../../../src/main/tradingGateEventRuntime/types.js';
import type {
  PeriodicSwitchRouteBaseline,
  PeriodicSwitchWakeupRuntimeDeps,
} from '../../../src/main/periodicSwitchWakeupRuntime/types.js';
import type { MonitorTaskInput } from '../../../src/main/asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

type ScheduledTask = MonitorTaskInput<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'>;
type TimerHandle = ReturnType<typeof setTimeout>;

type PeriodicHarness = Readonly<{
  runtime: ReturnType<typeof createPeriodicSwitchWakeupRuntime>;
  symbolRegistry: ReturnType<typeof createSymbolRegistryDouble>;
  tasks: ScheduledTask[];
  timers: ReturnType<typeof createTimerHarness>;
  subscriptions: ReturnType<typeof createSubscriptionHarness>;
  monitorConfig: MonitorConfig;
}>;

function createActiveSeat(symbol: string, lastSeatActivatedAt: number): SeatState {
  return {
    symbol,
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
}

function createSwitchEnabledMonitorConfig(
  params: {
    readonly monitorSymbol?: string;
    readonly switchIntervalMinutes?: number;
    readonly autoSearchEnabled?: boolean;
  } = {},
): MonitorConfig {
  const baseConfig = createMonitorConfigDouble({
    monitorSymbol: params.monitorSymbol ?? 'HSI.HK',
  });

  return createMonitorConfigDouble({
    ...baseConfig,
    autoSearchConfig: {
      ...baseConfig.autoSearchConfig,
      autoSearchEnabled: params.autoSearchEnabled ?? true,
      switchIntervalMinutes: params.switchIntervalMinutes ?? 5,
    },
  });
}

function createTimerHarness(initialNowMs: number) {
  let currentNowMs = initialNowMs;
  const timers = new Map<TimerHandle, { readonly atMs: number; readonly callback: () => void }>();

  return {
    now: () => new Date(currentNowMs),
    setNow: (nextNowMs: number) => {
      currentNowMs = nextNowMs;
    },
    scheduleTimer: (callback: () => void, delayMs: number) => {
      const handle = setTimeout(() => {}, 2_147_483_647);
      timers.set(handle, {
        atMs: currentNowMs + delayMs,
        callback,
      });
      return handle;
    },
    clearTimer: (handle: TimerHandle) => {
      clearTimeout(handle);
      timers.delete(handle);
    },
    fireNext: () => {
      const next = [...timers.entries()].sort(([, left], [, right]) => left.atMs - right.atMs)[0];
      if (next === undefined) {
        return;
      }

      const [handle, timer] = next;
      clearTimeout(handle);
      timers.delete(handle);
      timer.callback();
    },
    getPendingTimerCount: () => timers.size,
    getPendingTimerAts: () => [...timers.values()].map((timer) => timer.atMs),
  };
}

function createSubscriptionHarness() {
  const orderListeners = new Set<(event: OrderStateChangedEvent) => void>();
  const freshListeners = new Set<(event: PostTradeConsistencyFreshReachedEvent) => void>();
  const gateListeners = new Set<(event: TradingGateStateChangedEvent) => void>();

  return {
    trader: createTraderDouble({
      onOrderStateChanged: (listener) => {
        orderListeners.add(listener);
        return () => {
          orderListeners.delete(listener);
        };
      },
    }),
    postTradeConsistencyRuntime: {
      onFreshReached: (listener: (event: PostTradeConsistencyFreshReachedEvent) => void) => {
        freshListeners.add(listener);
        return () => {
          freshListeners.delete(listener);
        };
      },
    },
    tradingGateEventRuntime: {
      onGateStateChanged: (
        listener: (event: TradingGateStateChangedEvent) => void,
      ): Unsubscribe => {
        gateListeners.add(listener);
        return () => {
          gateListeners.delete(listener);
        };
      },
    },
    emitOrder: () => {
      const event: OrderStateChangedEvent = {
        orderId: 'order-1',
        symbol: 'BULL.HK',
        side: 'SELL',
        source: 'WS',
        status: 'FILLED',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedPrice: 1,
        executedQuantity: 100,
        executedTimeMs: 2_000,
      };
      for (const listener of orderListeners) {
        listener(event);
      }
    },
    emitFresh: () => {
      const event: PostTradeConsistencyFreshReachedEvent = {
        currentVersion: 2,
        staleVersion: 2,
        trigger: 'REFRESH',
      };
      for (const listener of freshListeners) {
        listener(event);
      }
    },
    emitGate: (event: TradingGateStateChangedEvent) => {
      for (const listener of gateListeners) {
        listener(event);
      }
    },
    getListenerCounts: () => ({
      order: orderListeners.size,
      fresh: freshListeners.size,
      gate: gateListeners.size,
    }),
  };
}

function createHarness(
  params: {
    readonly nowMs?: number;
    readonly monitorConfig?: MonitorConfig;
    readonly symbolRegistry?: ReturnType<typeof createSymbolRegistryDouble>;
    readonly monitorContexts?: ReadonlyMap<string, Pick<MonitorContext, 'config'>>;
    readonly calculateDueAtMs?: PeriodicSwitchWakeupRuntimeDeps['calculateDueAtMs'];
    readonly taskFailureRetryDelayMs?: number;
  } = {},
): PeriodicHarness {
  const monitorConfig = params.monitorConfig ?? createSwitchEnabledMonitorConfig();
  const symbolRegistry =
    params.symbolRegistry ??
    createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
      longSeat: createActiveSeat('BULL.HK', 1_000),
      shortSeat: createActiveSeat('BEAR.HK', 1_500),
      longVersion: 1,
      shortVersion: 2,
    });
  const monitorContext = createMonitorContextDouble({
    config: monitorConfig,
    symbolRegistry,
  });
  const monitorContexts =
    params.monitorContexts ?? new Map([[monitorConfig.monitorSymbol, monitorContext]]);
  const timers = createTimerHarness(params.nowMs ?? 10_000);
  const subscriptions = createSubscriptionHarness();
  const tasks: ScheduledTask[] = [];

  const runtime = createPeriodicSwitchWakeupRuntime({
    tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
    monitorContexts,
    symbolRegistry,
    monitorTaskQueue: {
      scheduleLatest: (task) => {
        if (task.type === 'AUTO_SYMBOL_TICK') {
          tasks.push(task);
        }
      },
    },
    trader: subscriptions.trader,
    postTradeConsistencyRuntime: subscriptions.postTradeConsistencyRuntime,
    tradingGateEventRuntime: subscriptions.tradingGateEventRuntime,
    calculateDueAtMs:
      params.calculateDueAtMs ?? ((input) => input.startMs + input.switchIntervalMinutes * 60_000),
    taskFailureRetryDelayMs: params.taskFailureRetryDelayMs ?? 1_000,
    now: timers.now,
    scheduleTimer: timers.scheduleTimer,
    clearTimer: timers.clearTimer,
  });

  return {
    runtime,
    symbolRegistry,
    tasks,
    timers,
    subscriptions,
    monitorConfig,
  };
}

function expectTickTask(
  task: ScheduledTask | undefined,
  expected: PeriodicSwitchRouteBaseline,
): void {
  expect(task).toBeDefined();
  if (task === undefined) {
    return;
  }

  expect(task.type).toBe('AUTO_SYMBOL_TICK');
  expect(task.dedupeKey).toBe(`${expected.monitorSymbol}:AUTO_SYMBOL_TICK:${expected.direction}`);
  expect(task.monitorSymbol).toBe(expected.monitorSymbol);
  expect(task.data.monitorSymbol).toBe(expected.monitorSymbol);
  expect(task.data.direction).toBe(expected.direction);
  expect(task.data.seatVersion).toBe(expected.seatVersion);
  expect(task.data.symbol).toBe(expected.symbol);
  expect(task.data.currentTimeMs).toEqual(expect.any(Number));
  expect(task.data).toHaveProperty('lastSeatActivatedAt', expected.lastSeatActivatedAt);
}

describe('PeriodicSwitchWakeupRuntime', () => {
  it('start seed 已启用 monitor 的 LONG/SHORT，并对 due route 入队完整 baseline', () => {
    const harness = createHarness({ nowMs: 400_000 });

    harness.runtime.start();

    expect(harness.tasks).toHaveLength(2);
    expectTickTask(harness.tasks[0], {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    });

    expectTickTask(harness.tasks[1], {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'SHORT',
      symbol: 'BEAR.HK',
      seatVersion: 2,
      lastSeatActivatedAt: 1_500,
    });
    expect(harness.tasks.map((task) => task.data.currentTimeMs)).toEqual([400_000, 400_000]);
  });

  it('start 幂等且 stopAndDrain 后可重新订阅与 seed', async () => {
    const harness = createHarness({ nowMs: 400_000 });

    harness.runtime.start();
    harness.runtime.start();

    expect(harness.tasks).toHaveLength(2);
    expect(harness.symbolRegistry.getSeatTruthChangedListenerCount()).toBe(1);
    expect(harness.subscriptions.getListenerCounts()).toEqual({ order: 1, fresh: 1, gate: 1 });

    await harness.runtime.stopAndDrain();
    expect(harness.symbolRegistry.getSeatTruthChangedListenerCount()).toBe(0);
    expect(harness.subscriptions.getListenerCounts()).toEqual({ order: 0, fresh: 0, gate: 0 });

    harness.runtime.start();

    expect(harness.tasks).toHaveLength(4);
    expect(harness.symbolRegistry.getSeatTruthChangedListenerCount()).toBe(1);
    expect(harness.subscriptions.getListenerCounts()).toEqual({ order: 1, fresh: 1, gate: 1 });
  });

  it('dueAtMs 小于等于当前时间时 inline 派发一次且不注册 0ms timer', () => {
    const harness = createHarness({
      nowMs: 301_000,
      calculateDueAtMs: () => 301_000,
    });

    harness.runtime.start();

    expect(harness.tasks).toHaveLength(2);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('dueAtMs 大于当前时间时只注册 one-shot timer，触发时 baseline 匹配才派发且不递归重排', () => {
    const harness = createHarness({
      nowMs: 100_000,
      calculateDueAtMs: ({ startMs }) => (startMs === 1_000 ? 200_000 : 300_000),
    });

    harness.runtime.start();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(2);
    expect(harness.timers.getPendingTimerAts().sort((left, right) => left - right)).toEqual([
      200_000, 300_000,
    ]);

    harness.timers.setNow(200_000);
    harness.timers.fireNext();

    expect(harness.tasks).toHaveLength(1);
    expect(harness.tasks[0]?.data.direction).toBe('LONG');
    expect(harness.timers.getPendingTimerCount()).toBe(1);
  });

  it('timer 触发时 baseline 已过期则不派发', () => {
    const harness = createHarness({ nowMs: 100_000 });
    harness.runtime.start();
    expect(harness.timers.getPendingTimerCount()).toBe(2);

    harness.symbolRegistry.updateSeatStateWithVersionBump(
      harness.monitorConfig.monitorSymbol,
      'LONG',
      createActiveSeat('BULL2.HK', 100_000),
    );
    harness.timers.setNow(301_000);
    harness.timers.fireNext();

    expect(harness.tasks.filter((task) => task.data.direction === 'LONG')).toHaveLength(0);
  });

  it('calculateDueAtMs 返回 null 时不派发也不注册 timer', () => {
    const harness = createHarness({
      nowMs: 100_000,
      calculateDueAtMs: () => null,
    });

    harness.runtime.start();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('stopAndDrain 阻止后续 timer/order/fresh 派发并清理 waiting-empty', async () => {
    const harness = createHarness({ nowMs: 100_000 });
    harness.runtime.start();
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };
    harness.runtime.markWaitingEmpty(baseline);

    await harness.runtime.stopAndDrain();
    harness.timers.setNow(301_000);
    harness.timers.fireNext();
    harness.subscriptions.emitOrder();
    harness.subscriptions.emitFresh();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);

    harness.runtime.start();
    const taskCountAfterRestartSeed = harness.tasks.length;
    harness.subscriptions.emitOrder();
    expect(harness.tasks).toHaveLength(taskCountAfterRestartSeed);
  });

  it('onSeatTruthChanged 只对事件 route 重算，不作为 waiting-empty progress 来源', () => {
    const harness = createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const staleBaseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };
    harness.runtime.markWaitingEmpty(staleBaseline);

    harness.symbolRegistry.updateSeatStateWithVersionBump(
      harness.monitorConfig.monitorSymbol,
      'LONG',
      createActiveSeat('BULL2.HK', 400_000),
    );

    harness.symbolRegistry.updateSeatStateWithVersionBump(
      harness.monitorConfig.monitorSymbol,
      'SHORT',
      createActiveSeat('BEAR2.HK', 1_500),
    );

    expect(harness.tasks).toHaveLength(1);
    expect(harness.tasks[0]?.data.direction).toBe('SHORT');
  });

  it('order/fresh 事件只重新派发 waiting-empty routes，并使用相同 dedupe key', () => {
    const harness = createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.markWaitingEmpty(baseline);
    harness.subscriptions.emitOrder();
    harness.subscriptions.emitFresh();

    expect(harness.tasks).toHaveLength(2);
    expect(harness.tasks.every((task) => task.dedupeKey === 'HSI.HK:AUTO_SYMBOL_TICK:LONG')).toBe(
      true,
    );
    expect(harness.tasks.every((task) => task.data.direction === 'LONG')).toBe(true);
  });

  it('当前 baseline 已 waiting-empty 时 replanRouteAfterTask 保持等待且不重派发', () => {
    const harness = createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.markWaitingEmpty(baseline);
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'processed' });

    expect(harness.tasks).toHaveLength(0);

    harness.subscriptions.emitOrder();

    expect(harness.tasks).toHaveLength(1);
    expect(harness.tasks[0]?.data.direction).toBe('LONG');
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('processed replanRouteAfterTask 不重复派发已处理 due route', () => {
    const harness = createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'processed' });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('processed replanRouteAfterTask 会为未来 due route 安排 timer', () => {
    const harness = createHarness({
      nowMs: 400_000,
      calculateDueAtMs: () => 405_000,
    });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'processed' });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts()).toEqual([405_000, 405_000]);
  });

  it('skipped replanRouteAfterTask 不注册恢复 timer', () => {
    const harness = createHarness({ nowMs: 400_000, taskFailureRetryDelayMs: 1_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'skipped' });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('blocked replanRouteAfterTask 保留 baseline 并等待 null-to-open gate 重新派发', () => {
    const harness = createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'blocked' });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);

    harness.subscriptions.emitGate({
      previousCanTrade: null,
      nextCanTrade: true,
      timestampMs: 400_000,
    });

    expect(harness.tasks).toHaveLength(2);
    expect(
      harness.tasks.some(
        (task) =>
          task.data.direction === baseline.direction && task.data.symbol === baseline.symbol,
      ),
    ).toBe(true);
  });

  it('waiting-empty route 收到 blocked outcome 后转交 gate-open owner', () => {
    const harness = createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.markWaitingEmpty(baseline);
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'blocked' });

    harness.subscriptions.emitOrder();
    harness.subscriptions.emitFresh();

    expect(harness.tasks).toHaveLength(0);

    harness.subscriptions.emitGate({
      previousCanTrade: false,
      nextCanTrade: true,
      timestampMs: 400_000,
    });

    expect(harness.tasks).toHaveLength(2);
    expect(
      harness.tasks.some(
        (task) =>
          task.data.direction === baseline.direction && task.data.symbol === baseline.symbol,
      ),
    ).toBe(true);
  });

  it('failed replanRouteAfterTask 不同步重派发 due route，并由失败恢复 timer 恢复入队', () => {
    const harness = createHarness({ nowMs: 400_000, taskFailureRetryDelayMs: 1_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'failed' });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(1);
    expect(harness.timers.getPendingTimerAts()).toEqual([401_000]);

    harness.timers.setNow(401_000);
    harness.timers.fireNext();

    expect(harness.tasks).toHaveLength(1);
    expectTickTask(harness.tasks[0], baseline);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('waiting-empty route 收到 failed outcome 时只保留失败恢复 timer 通道', () => {
    const harness = createHarness({ nowMs: 400_000, taskFailureRetryDelayMs: 1_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.markWaitingEmpty(baseline);
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'failed' });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(1);
    expect(harness.timers.getPendingTimerAts()).toEqual([401_000]);

    harness.subscriptions.emitOrder();
    harness.subscriptions.emitFresh();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(1);

    harness.timers.setNow(401_000);
    harness.timers.fireNext();

    expect(harness.tasks).toHaveLength(1);
    expectTickTask(harness.tasks[0], baseline);
  });

  it('failed 后同 baseline 收到 skipped outcome 会取消失败恢复 timer', () => {
    const harness = createHarness({ nowMs: 400_000, taskFailureRetryDelayMs: 1_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'failed' });
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'skipped' });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('waiting-empty route 收到 skipped outcome 会清理等待且不注册 timer', () => {
    const harness = createHarness({ nowMs: 400_000, taskFailureRetryDelayMs: 1_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.markWaitingEmpty(baseline);
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'skipped' });
    harness.subscriptions.emitOrder();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('同一 baseline 连续 failed outcome 只保留一个失败恢复 timer 且只恢复一次', () => {
    const harness = createHarness({ nowMs: 400_000, taskFailureRetryDelayMs: 1_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'failed' });
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'failed' });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(1);

    harness.timers.setNow(401_000);
    harness.timers.fireNext();

    expect(harness.tasks).toHaveLength(1);
    expectTickTask(harness.tasks[0], baseline);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('失败恢复 timer 到期前 baseline 改变时不派发旧任务', () => {
    const harness = createHarness({
      nowMs: 400_000,
      taskFailureRetryDelayMs: 1_000,
      calculateDueAtMs: ({ startMs }) => (startMs === 500_000 ? null : 1_000),
    });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };

    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'failed' });
    expect(harness.timers.getPendingTimerCount()).toBe(1);

    harness.symbolRegistry.updateSeatStateWithVersionBump(
      harness.monitorConfig.monitorSymbol,
      'LONG',
      createActiveSeat('BULL2.HK', 500_000),
    );
    harness.timers.setNow(401_000);
    harness.timers.fireNext();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('stale mark/clear/replan baseline 不能修改新激活 route', () => {
    const harness = createHarness({
      nowMs: 100_000,
      calculateDueAtMs: ({ startMs }) => (startMs === 600_000 ? 700_000 : 300_000),
    });
    harness.runtime.start();
    const staleBaseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };
    harness.symbolRegistry.updateSeatStateWithVersionBump(
      harness.monitorConfig.monitorSymbol,
      'LONG',
      createActiveSeat('BULL2.HK', 600_000),
    );
    harness.tasks.length = 0;

    harness.runtime.markWaitingEmpty(staleBaseline);
    harness.subscriptions.emitOrder();
    harness.runtime.clearWaitingEmpty(staleBaseline);
    harness.runtime.replanRouteAfterTask({
      ...staleBaseline,
      taskTimeMs: 100_000,
      status: 'processed',
    });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts()).toContain(700_000);
  });

  it('gate open 不破坏 waiting-empty，后续 order/fresh 仍重派同一 baseline', () => {
    const harness = createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    harness.tasks.length = 0;
    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: harness.monitorConfig.monitorSymbol,
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    };
    harness.runtime.markWaitingEmpty(baseline);

    harness.subscriptions.emitGate({
      previousCanTrade: false,
      nextCanTrade: true,
      timestampMs: 400_000,
    });

    harness.subscriptions.emitGate({
      previousCanTrade: true,
      nextCanTrade: true,
      timestampMs: 401_000,
    });

    expect(harness.tasks).toHaveLength(1);
    expect(harness.tasks[0]?.data.direction).toBe('SHORT');

    harness.subscriptions.emitOrder();
    harness.subscriptions.emitFresh();

    expect(harness.tasks).toHaveLength(3);
    expect(harness.tasks[1]?.data).toMatchObject(baseline);
    expect(harness.tasks[2]?.data).toMatchObject(baseline);
  });
});
