/**
 * signalPipeline 业务测试
 *
 * 功能：
 * - 验证信号管道相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { runSignalPipeline } from '../../../src/main/processMonitor/signalPipeline.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';

import type { Signal } from '../../../src/types/signal.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { MainProgramContext } from '../../../src/main/mainProgram/types.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { SeatSyncResult } from '../../../src/main/processMonitor/types.js';

import {
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createSignalDouble,
} from '../../helpers/testDoubles.js';

function createSnapshot(): IndicatorSnapshot {
  return {
    price: 100,
    changePercent: 0,
    ema: null,
    rsi: null,
    psy: null,
    mfi: null,
    kdj: null,
    macd: null,
  };
}

function createSeatInfo(overrides: Partial<SeatSyncResult> = {}): SeatSyncResult {
  const base: SeatSyncResult = {
    longSeatState: {
      symbol: 'BULL.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatReadyAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeatState: {
      symbol: 'BEAR.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatReadyAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longSeatVersion: 7,
    shortSeatVersion: 11,
    longSeatReady: true,
    shortSeatReady: true,
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longQuote: createQuoteDouble('BULL.HK', 1.2),
    shortQuote: createQuoteDouble('BEAR.HK', 0.9),
  };

  return {
    ...base,
    ...overrides,
  };
}

function createPipelineHarness(params: {
  immediateSignals: ReadonlyArray<Signal>;
  delayedSignals: ReadonlyArray<Signal>;
  seatInfo?: SeatSyncResult;
  canTradeNow?: boolean;
  openProtectionActive?: boolean;
  isTradingEnabled?: boolean;
}): {
  buyTaskQueue: ReturnType<typeof createBuyTaskQueue>;
  sellTaskQueue: ReturnType<typeof createSellTaskQueue>;
  delayedAdded: Signal[];
  releasedSignals: Signal[];
  releasedPositions: Array<string>;
} {
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();

  const delayedAdded: Signal[] = [];
  const releasedSignals: Signal[] = [];
  const releasedPositions: Array<string> = [];

  const monitorContext = {
    strategy: {
      generateCloseSignals: () => ({
        immediateSignals: params.immediateSignals,
        delayedSignals: params.delayedSignals,
      }),
    },
    orderRecorder: createOrderRecorderDouble(),
    delayedSignalVerifier: {
      addSignal: (signal: Signal) => {
        delayedAdded.push(signal);
      },
    },
  } as unknown as MonitorContext;

  const positionCache = createPositionCacheDouble([
    createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
    createPositionDouble({ symbol: 'BEAR.HK', quantity: 100, availableQuantity: 100 }),
  ]);

  const mainContext = {
    lastState: {
      positionCache,
    },
    buyTaskQueue,
    sellTaskQueue,
  } as unknown as MainProgramContext;

  runSignalPipeline({
    monitorSymbol: 'HSI.HK',
    monitorSnapshot: createSnapshot(),
    monitorContext,
    mainContext,
    runtimeFlags: {
      currentTime: new Date('2026-02-16T09:31:00.000Z'),
      isHalfDay: false,
      canTradeNow: params.canTradeNow ?? true,
      openProtectionActive: params.openProtectionActive ?? false,
      isTradingEnabled: params.isTradingEnabled ?? true,
    },
    seatInfo: params.seatInfo ?? createSeatInfo(),
    releaseSignal: (signal) => {
      releasedSignals.push(signal);
    },
    releasePosition: (position) => {
      releasedPositions.push(position.symbol);
    },
  });

  return {
    buyTaskQueue,
    sellTaskQueue,
    delayedAdded,
    releasedSignals,
    releasedPositions,
  };
}

describe('signalPipeline business flow', () => {
  it('routes immediate/delayed signals to correct queues and enriches seatVersion/symbolName', () => {
    const immediateBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    immediateBuy.symbolName = null;
    const immediateSell = createSignalDouble('SELLPUT', 'BEAR.HK');
    immediateSell.symbolName = null;
    const delayedBuy = createSignalDouble('BUYPUT', 'BEAR.HK');
    delayedBuy.symbolName = null;

    const harness = createPipelineHarness({
      immediateSignals: [immediateBuy, immediateSell],
      delayedSignals: [delayedBuy],
    });

    const queuedBuy = harness.buyTaskQueue.pop();
    const queuedSell = harness.sellTaskQueue.pop();

    expect(queuedBuy?.type).toBe('IMMEDIATE_BUY');
    expect(queuedBuy?.data.seatVersion).toBe(7);
    expect(queuedBuy?.data.symbolName).toBe('BULL.HK');

    expect(queuedSell?.type).toBe('IMMEDIATE_SELL');
    expect(queuedSell?.data.seatVersion).toBe(11);
    expect(queuedSell?.data.symbolName).toBe('BEAR.HK');

    expect(harness.delayedAdded).toHaveLength(1);
    expect(harness.delayedAdded[0]?.seatVersion).toBe(11);
    expect(harness.releasedSignals).toHaveLength(0);
    expect(harness.releasedPositions).toEqual(['BULL.HK', 'BEAR.HK']);
  });

  it('drops buy signal when quote is not ready but keeps sell signal path available', () => {
    const immediateBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    const immediateSell = createSignalDouble('SELLCALL', 'BULL.HK');

    const harness = createPipelineHarness({
      immediateSignals: [immediateBuy, immediateSell],
      delayedSignals: [],
      seatInfo: createSeatInfo({
        longQuote: null,
      }),
    });

    expect(harness.releasedSignals).toHaveLength(1);
    expect(harness.releasedSignals[0]?.action).toBe('BUYCALL');

    const queuedSell = harness.sellTaskQueue.pop();
    expect(queuedSell?.data.action).toBe('SELLCALL');
    expect(harness.buyTaskQueue.isEmpty()).toBeTrue();
  });

  it('releases valid signals instead of enqueue when trading gate is disabled', () => {
    const immediateBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    const delayedBuy = createSignalDouble('BUYPUT', 'BEAR.HK');

    const harness = createPipelineHarness({
      immediateSignals: [immediateBuy],
      delayedSignals: [delayedBuy],
      isTradingEnabled: false,
    });

    expect(harness.buyTaskQueue.isEmpty()).toBeTrue();
    expect(harness.sellTaskQueue.isEmpty()).toBeTrue();
    expect(harness.delayedAdded).toHaveLength(0);
    expect(harness.releasedSignals).toEqual([immediateBuy, delayedBuy]);
  });

  it('returns early during opening protection and still releases pooled positions', () => {
    const harness = createPipelineHarness({
      immediateSignals: [createSignalDouble('BUYCALL', 'BULL.HK')],
      delayedSignals: [createSignalDouble('BUYPUT', 'BEAR.HK')],
      openProtectionActive: true,
    });

    expect(harness.buyTaskQueue.isEmpty()).toBeTrue();
    expect(harness.sellTaskQueue.isEmpty()).toBeTrue();
    expect(harness.releasedSignals).toHaveLength(0);
    expect(harness.releasedPositions).toEqual(['BULL.HK', 'BEAR.HK']);
  });
});
