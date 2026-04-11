/**
 * AutoSearchWakeupRuntime 业务测试
 *
 * 覆盖：runtime start seed 与 gate-open 事件唤醒 EMPTY seat，不依赖 AUTO_SYMBOL_TICK。
 */
import { describe, expect, it } from 'bun:test';
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

function createAutoSearchEnabledMonitorConfig() {
  const baseConfig = createMonitorConfigDouble();
  return createMonitorConfigDouble({
    autoSearchConfig: {
      ...baseConfig.autoSearchConfig,
      autoSearchEnabled: true,
      autoSearchOpenDelayMinutes: 0,
    },
  });
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
});
