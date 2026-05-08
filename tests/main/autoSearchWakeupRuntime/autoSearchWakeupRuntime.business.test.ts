/**
 * AutoSearchWakeupRuntime 业务测试
 *
 * 覆盖：runtime start seed 与 gate-open 事件唤醒 EMPTY seat，不依赖 AUTO_SYMBOL_TICK。
 */
import { describe, expect, it } from 'bun:test';
import { TIME, TRADING } from '../../../src/constants/index.js';
import { createAutoSearchWakeupRuntime } from '../../../src/main/autoSearchWakeupRuntime/index.js';
import { createTradingGateEventRuntime } from '../../../src/main/tradingGateEventRuntime/index.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import type { SearchOnEventParams } from '../../../src/services/autoSymbolManager/types.js';
import {
  createAutoSymbolManagerDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
} from '../../helpers/testDoubles.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';

function createAutoSearchEnabledMonitorConfig(
  params: { readonly autoSearchOpenDelayMinutes?: number } = {},
) {
  const baseConfig = createMonitorConfigDouble();
  return createMonitorConfigDouble({
    autoSearchConfig: {
      ...baseConfig.autoSearchConfig,
      autoSearchEnabled: true,
      autoSearchOpenDelayMinutes: params.autoSearchOpenDelayMinutes ?? 0,
    },
  });
}

type TimerHandle = ReturnType<typeof setTimeout>;

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
    getPendingTimerAts: () => [...timers.values()].map((timer) => timer.atMs),
  };
}

function makeSeatEmpty(
  symbolRegistry: ReturnType<typeof createSymbolRegistry>,
  monitorSymbol: string,
): void {
  symbolRegistry.updateSeatState(monitorSymbol, 'SHORT', {
    symbol: 'BEAR.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: 1,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  });

  symbolRegistry.updateSeatState(monitorSymbol, 'LONG', {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  });
}

describe('AutoSearchWakeupRuntime', () => {
  it('start 时 seed 当前 EMPTY seat 并调用 maybeSearchOnEvent', async () => {
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
        },
      }),
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      monitorContexts: new Map([[monitorConfig.monitorSymbol, monitorContext]]),
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
      },
      tradingGateEventRuntime,
      now: () => new Date('2026-04-10T02:00:00.000Z'),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });

    runtime.start();
    await Bun.sleep(0);
    await runtime.stopAndDrain();

    expect(
      calls.map((call) => call.direction).sort((left, right) => left.localeCompare(right)),
    ).toEqual(['LONG']);
    expect(calls.every((call) => call.canTradeNow)).toBe(true);
  });

  it('gate 从关闭变为打开时唤醒已经存在的 EMPTY seat', async () => {
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
        },
      }),
    });
    const lastState = {
      canTrade: false,
      isTradingEnabled: true,
    };
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      monitorContexts: new Map([[monitorConfig.monitorSymbol, monitorContext]]),
      lastState,
      tradingGateEventRuntime,
      now: () => new Date('2026-04-10T02:00:00.000Z'),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });

    runtime.start();
    await Bun.sleep(0);
    expect(calls).toHaveLength(0);

    lastState.canTrade = true;
    tradingGateEventRuntime.emitGateStateChanged({
      previousCanTrade: false,
      nextCanTrade: true,
      timestampMs: Date.now(),
    });
    await Bun.sleep(0);
    await runtime.stopAndDrain();

    expect(
      calls.map((call) => call.direction).sort((left, right) => left.localeCompare(right)),
    ).toEqual(['LONG']);
  });

  it('非 API 寻标错误进入 fatal channel', async () => {
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async () => {
          throw new TypeError('auto search contract broken');
        },
      }),
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      monitorContexts: new Map([[monitorConfig.monitorSymbol, monitorContext]]),
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
      },
      tradingGateEventRuntime,
      now: () => new Date('2026-04-10T02:00:00.000Z'),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });

    const fatalErrorPromise = runtime.drainFatalError().catch((error: unknown) => error);
    runtime.start();
    const fatalError = await fatalErrorPromise;
    await runtime.stopAndDrain();

    expect(fatalError).toBeInstanceOf(TypeError);
    expect((fatalError as Error).message).toBe('auto search contract broken');
  });

  it('自动寻标 API 失败后保留同版本显式 retry 且不推进失败计数或冻结状态', async () => {
    const startMs = Date.parse('2026-04-10T02:00:00.000Z');
    const timers = createTimerHarness(startMs);
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    symbolRegistry.updateSeatState(monitorConfig.monitorSymbol, 'LONG', {
      ...symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG'),
      searchFailCountToday: 2,
    });
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
          if (calls.length === 1) {
            throw Object.assign(new Error('api unavailable'), {
              name: 'ExternalApiRequestError',
              operation: 'test.autoSearch',
              attempts: 1,
            });
          }
        },
      }),
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      monitorContexts: new Map([[monitorConfig.monitorSymbol, monitorContext]]),
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
      },
      tradingGateEventRuntime,
      now: timers.now,
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    runtime.start();
    await Bun.sleep(0);

    expect(calls).toHaveLength(1);
    expect(timers.getPendingTimerAts()).toEqual([startMs + TRADING.INTERVAL_MS]);
    expect(symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG')).toMatchObject({
      searchFailCountToday: 2,
      frozenTradingDayKey: null,
    });

    timers.setNow(startMs + TRADING.INTERVAL_MS);
    timers.fireNext();
    await Bun.sleep(0);
    await runtime.stopAndDrain();

    expect(calls).toHaveLength(2);
    expect(symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG')).toMatchObject({
      searchFailCountToday: 2,
      frozenTradingDayKey: null,
    });
  });

  it('自动寻标 API 失败写回 EMPTY 时不通过席位事件即时重入', async () => {
    const startMs = Date.parse('2026-04-10T02:00:00.000Z');
    const timers = createTimerHarness(startMs);
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
          if (calls.length === 1) {
            const currentSeat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
            symbolRegistry.updateSeatState(monitorConfig.monitorSymbol, 'LONG', {
              ...currentSeat,
              status: 'SEARCHING',
              lastSearchAt: startMs,
            });

            symbolRegistry.updateSeatState(monitorConfig.monitorSymbol, 'LONG', {
              ...currentSeat,
              status: 'EMPTY',
              lastSearchAt: null,
            });
            throw Object.assign(new Error('api unavailable'), {
              name: 'ExternalApiRequestError',
              operation: 'test.autoSearch',
              attempts: 1,
            });
          }
        },
      }),
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      monitorContexts: new Map([[monitorConfig.monitorSymbol, monitorContext]]),
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
      },
      tradingGateEventRuntime,
      now: timers.now,
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    runtime.start();
    await Bun.sleep(0);

    expect(calls).toHaveLength(1);
    expect(timers.getPendingTimerAts()).toEqual([startMs + TRADING.INTERVAL_MS]);

    await runtime.stopAndDrain();
  });

  it('自动寻标开盘延迟超长时按安全分段注册，到真实延迟结束才寻标', async () => {
    const openMs = Date.parse('2026-04-10T01:30:00.000Z');
    const openDelayMinutes = Math.ceil(
      (TIME.MAX_TIMER_DELAY_MS + 5) / TIME.MILLISECONDS_PER_MINUTE,
    );
    const delayEndMs = openMs + openDelayMinutes * TIME.MILLISECONDS_PER_MINUTE;
    const timers = createTimerHarness(openMs);
    const monitorConfig = createAutoSearchEnabledMonitorConfig({
      autoSearchOpenDelayMinutes: openDelayMinutes,
    });
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
        },
      }),
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      monitorContexts: new Map([[monitorConfig.monitorSymbol, monitorContext]]),
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
      },
      tradingGateEventRuntime,
      now: timers.now,
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    runtime.start();
    await Bun.sleep(0);

    expect(calls).toHaveLength(0);
    expect(timers.getPendingTimerAts()).toEqual([openMs + TIME.MAX_TIMER_DELAY_MS]);

    timers.setNow(openMs + TIME.MAX_TIMER_DELAY_MS);
    timers.fireNext();
    await Bun.sleep(0);

    expect(calls).toHaveLength(0);
    expect(timers.getPendingTimerAts()).toEqual([delayEndMs]);

    timers.setNow(delayEndMs);
    timers.fireNext();
    await Bun.sleep(0);
    await runtime.stopAndDrain();

    expect(calls.map((call) => call.direction)).toEqual(['LONG']);
  });
});
