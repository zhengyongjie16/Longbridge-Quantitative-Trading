/**
 * seatSync 业务测试
 *
 * 功能：
 * - 验证席位同步相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { syncSeatState } from '../../../src/main/processMonitor/seatSync.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import type { MonitorContext } from '../../../src/types/state.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorRuntimeContext } from '../../../src/main/processMonitor/types.js';

import {
  createQuoteDouble,
  createSignalDouble,
  createSymbolRegistryDouble,
  createRiskCheckerDouble,
} from '../../helpers/testDoubles.js';

describe('seatSync business flow', () => {
  it('clears long-side runtime queues but preserves pending SEAT_REFRESH when LONG seat leaves ACTIVE', () => {
    const monitorSymbol = 'HSI.HK';
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
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

    let clearLongCalls = 0;
    const riskChecker = createRiskCheckerDouble({
      clearLongWarrantInfo: () => {
        clearLongCalls += 1;
      },
    });

    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();

    const longBuySignal = createSignalDouble('BUYCALL', 'BULL.HK');
    const longSellSignal = createSignalDouble('SELLCALL', 'BULL.HK');
    const shortBuySignal = createSignalDouble('BUYPUT', 'BEAR.HK');

    const buySignals = [longBuySignal, shortBuySignal];
    for (const signal of buySignals) {
      buyTaskQueue.push({ type: 'IMMEDIATE_BUY', monitorSymbol, data: signal });
    }

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
        openProtectionActive: false,
      },
    });

    monitorTaskQueue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: `${monitorSymbol}:SEAT_REFRESH:LONG`,
      monitorSymbol,
      data: {
        monitorSymbol,
        direction: 'LONG',
        seatVersion: 1,
        previousSymbol: 'OLD_BULL.HK',
        nextSymbol: 'BULL.HK',
        callPrice: 20_000,
        symbolName: 'BULL.HK',
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
        openProtectionActive: false,
      },
    });

    let delayedCancelled = 0;

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
          status: 'ACTIVE',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        short: {
          symbol: 'BEAR.HK',
          status: 'ACTIVE',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
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
    } as unknown as MonitorRuntimeContext;

    syncSeatState({
      monitorSymbol,
      monitorContext,
      mainContext,
      quotesMap: new Map<string, ReturnType<typeof createQuoteDouble>>([
        ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9)],
      ]),
    });

    expect(clearLongCalls).toBe(1);
    expect(delayedCancelled).toBe(2);

    expect(buyTaskQueue.pop()?.data.action).toBe('BUYPUT');
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();

    const remainingSeatRefreshTask = monitorTaskQueue.pop();
    expect(remainingSeatRefreshTask?.type).toBe('SEAT_REFRESH');
    expect(remainingSeatRefreshTask?.data).toMatchObject({
      direction: 'LONG',
      nextSymbol: 'BULL.HK',
    });

    const remainingShortTask = monitorTaskQueue.pop();
    expect(remainingShortTask?.type).toBe('AUTO_SYMBOL_TICK');
    expect(remainingShortTask?.data).toMatchObject({
      direction: 'SHORT',
      symbol: 'BEAR.HK',
    });
    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });

  it('does not schedule SEAT_REFRESH because activation is owned by SeatActivationDispatcher', () => {
    const monitorSymbol = 'HSI.HK';
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol,
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        callPrice: null,
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'OLD_BEAR.HK',
        status: 'ACTIVE',
        callPrice: null,
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 5,
      shortVersion: 6,
    });

    const previousLongSeat = symbolRegistry.getSeatState(monitorSymbol, 'LONG');
    const previousShortSeat = symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
    symbolRegistry.updateSeatState(monitorSymbol, 'LONG', {
      symbol: 'NEW_BULL.HK',
      status: 'ACTIVATING',
      callPrice: 21000,
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    symbolRegistry.updateSeatState(monitorSymbol, 'SHORT', {
      symbol: 'NEW_BEAR.HK',
      status: 'ACTIVATING',
      callPrice: 19000,
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const monitorContext = {
      riskChecker: createRiskCheckerDouble(),
      delayedSignalVerifier: {
        cancelAllForDirection: () => 0,
      },
      symbolRegistry,
      seatState: {
        long: previousLongSeat,
        short: previousShortSeat,
      },
      seatVersion: { long: 1, short: 1 },
      longSymbolName: 'OLD_BULL',
      shortSymbolName: 'OLD_BEAR',
    } as unknown as MonitorContext;

    const mainContext = {
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      monitorTaskQueue,
    } as unknown as MonitorRuntimeContext;

    const quotesMap = new Map<string, ReturnType<typeof createQuoteDouble>>([
      ['NEW_BULL.HK', createQuoteDouble('NEW_BULL.HK', 1.2)],
      ['NEW_BEAR.HK', createQuoteDouble('NEW_BEAR.HK', 0.8)],
    ]);

    syncSeatState({
      monitorSymbol,
      monitorContext,
      mainContext,
      quotesMap,
    });

    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });
});
