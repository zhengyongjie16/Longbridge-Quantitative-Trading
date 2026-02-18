/**
 * seatSync 业务测试
 *
 * 功能：
 * - 围绕 seatSync.business.test.ts 场景验证 tests/main/processMonitor 相关业务行为与边界条件。
 */
import { describe, expect, it } from 'bun:test';

import { syncSeatState } from '../../../src/main/processMonitor/seatSync.js';
import { createBuyTaskQueue, createSellTaskQueue } from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import type { Signal } from '../../../src/types/signal.js';
import type { MainProgramContext } from '../../../src/main/mainProgram/types.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { MonitorTaskData, MonitorTaskType } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

import {
  createQuoteDouble,
  createSignalDouble,
  createSymbolRegistryDouble,
  createRiskCheckerDouble,
} from '../../helpers/testDoubles.js';

describe('seatSync business flow', () => {
  it('clears long-side runtime queues when LONG seat leaves READY', () => {
    const monitorSymbol = 'HSI.HK';
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    let clearLongCalls = 0;
    const riskChecker = createRiskCheckerDouble({
      clearLongWarrantInfo: () => {
        clearLongCalls += 1;
      },
    });

    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();

    const longBuySignal = createSignalDouble('BUYCALL', 'BULL.HK');
    const longSellSignal = createSignalDouble('SELLCALL', 'BULL.HK');
    const shortBuySignal = createSignalDouble('BUYPUT', 'BEAR.HK');

    buyTaskQueue.push({ type: 'IMMEDIATE_BUY', monitorSymbol, data: longBuySignal });
    buyTaskQueue.push({ type: 'IMMEDIATE_BUY', monitorSymbol, data: shortBuySignal });
    sellTaskQueue.push({ type: 'IMMEDIATE_SELL', monitorSymbol, data: longSellSignal });

    monitorTaskQueue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: `${monitorSymbol}:AUTO_SYMBOL_TICK:LONG`,
      monitorSymbol,
      data: {
        monitorSymbol,
        direction: 'LONG',
        seatVersion: 1,
        symbol: 'BULL.HK',
        currentTimeMs: Date.now(),
        canTradeNow: true,
      },
    });
    monitorTaskQueue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: `${monitorSymbol}:AUTO_SYMBOL_TICK:SHORT`,
      monitorSymbol,
      data: {
        monitorSymbol,
        direction: 'SHORT',
        seatVersion: 1,
        symbol: 'BEAR.HK',
        currentTimeMs: Date.now(),
        canTradeNow: true,
      },
    });

    let delayedCancelled = 0;
    const releasedSignals: Signal[] = [];

    const monitorContext = {
      riskChecker,
      delayedSignalVerifier: {
        cancelAllForDirection: (_symbol: string, direction: 'LONG' | 'SHORT') => {
          if (direction === 'LONG') {
            delayedCancelled += 2;
            return 2;
          }
          return 0;
        },
      },
      symbolRegistry,
      seatState: {
        long: {
          symbol: 'BULL.HK',
          status: 'READY',
          lastSwitchAt: null,
          lastSearchAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        short: {
          symbol: 'BEAR.HK',
          status: 'READY',
          lastSwitchAt: null,
          lastSearchAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
      },
      seatVersion: { long: 1, short: 1 },
      longSymbolName: 'BULL.HK',
      shortSymbolName: 'BEAR.HK',
    } as unknown as MonitorContext;

    const mainContext = {
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    } as unknown as MainProgramContext;

    syncSeatState({
      monitorSymbol,
      monitorQuote: createQuoteDouble(monitorSymbol, 20_000),
      monitorContext,
      mainContext,
      quotesMap: new Map<string, ReturnType<typeof createQuoteDouble>>([
        ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9)],
      ]),
      releaseSignal: (signal) => {
        releasedSignals.push(signal);
      },
    });

    expect(clearLongCalls).toBe(1);
    expect(delayedCancelled).toBe(2);
    expect(releasedSignals).toEqual([longBuySignal, longSellSignal]);

    expect(buyTaskQueue.pop()?.data.action).toBe('BUYPUT');
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();

    const remainingMonitorTask = monitorTaskQueue.pop();
    expect(remainingMonitorTask?.dedupeKey).toContain(':SHORT');
    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });

  it('schedules SEAT_REFRESH tasks when ready seats switch symbols', () => {
    const monitorSymbol = 'HSI.HK';
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol,
      longSeat: {
        symbol: 'NEW_BULL.HK',
        status: 'READY',
        callPrice: 21000,
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'NEW_BEAR.HK',
        status: 'READY',
        callPrice: 19000,
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 5,
      shortVersion: 6,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    const monitorContext = {
      riskChecker: createRiskCheckerDouble(),
      delayedSignalVerifier: {
        cancelAllForDirection: () => 0,
      },
      symbolRegistry,
      seatState: {
        long: {
          symbol: 'OLD_BULL.HK',
          status: 'READY',
          lastSwitchAt: null,
          lastSearchAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        short: {
          symbol: 'OLD_BEAR.HK',
          status: 'READY',
          lastSwitchAt: null,
          lastSearchAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
      },
      seatVersion: { long: 1, short: 1 },
      longSymbolName: 'OLD_BULL',
      shortSymbolName: 'OLD_BEAR',
    } as unknown as MonitorContext;

    const mainContext = {
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      monitorTaskQueue,
    } as unknown as MainProgramContext;

    const quotesMap = new Map<string, ReturnType<typeof createQuoteDouble>>([
      ['NEW_BULL.HK', createQuoteDouble('NEW_BULL.HK', 1.2)],
      ['NEW_BEAR.HK', createQuoteDouble('NEW_BEAR.HK', 0.8)],
    ]);

    syncSeatState({
      monitorSymbol,
      monitorQuote: createQuoteDouble(monitorSymbol, 20_500),
      monitorContext,
      mainContext,
      quotesMap,
      releaseSignal: () => {},
    });

    const firstTask = monitorTaskQueue.pop();
    const secondTask = monitorTaskQueue.pop();

    expect(firstTask?.type).toBe('SEAT_REFRESH');
    expect(firstTask?.dedupeKey).toBe(`${monitorSymbol}:SEAT_REFRESH:LONG`);
    expect((firstTask?.data as { nextSymbol: string }).nextSymbol).toBe('NEW_BULL.HK');

    expect(secondTask?.type).toBe('SEAT_REFRESH');
    expect(secondTask?.dedupeKey).toBe(`${monitorSymbol}:SEAT_REFRESH:SHORT`);
    expect((secondTask?.data as { nextSymbol: string }).nextSymbol).toBe('NEW_BEAR.HK');
  });
});
