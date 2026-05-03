/**
 * signalPipeline 业务测试
 *
 * 功能：
 * - 验证信号管道相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { runSignalPipeline } from '../../../src/main/businessEventProgram/signalPipeline.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';

import type { Signal } from '../../../src/types/signal.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type {
  SignalPipelineParams,
  SignalSeatInfo,
} from '../../../src/main/businessEventProgram/types.js';

import {
  createIndicatorUsageProfileDouble,
  createOrderRecorderDouble,
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
    adx: null,
  };
}

function createSeatInfo(overrides: Partial<SignalSeatInfo> = {}): SignalSeatInfo {
  const base: SignalSeatInfo = {
    longSeatState: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeatState: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longSeatVersion: 7,
    shortSeatVersion: 11,
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
  };

  return {
    ...base,
    ...overrides,
  };
}

function createPipelineHarness(params: {
  immediateSignals: ReadonlyArray<Signal>;
  delayedSignals: ReadonlyArray<Signal>;
  seatInfo?: SignalSeatInfo;
  canTradeNow?: boolean;
  openProtectionActive?: boolean;
  isTradingEnabled?: boolean;
}): {
  buyTaskQueue: ReturnType<typeof createBuyTaskQueue>;
  sellTaskQueue: ReturnType<typeof createSellTaskQueue>;
  delayedAdded: Signal[];
  getGenerateSignalsCallCount: () => number;
} {
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();

  const delayedAdded: Signal[] = [];
  let generateSignalsCallCount = 0;

  const monitorContext = {
    strategy: {
      generateSignals: () => {
        generateSignalsCallCount += 1;
        return {
          immediateSignals: params.immediateSignals,
          delayedSignals: params.delayedSignals,
        };
      },
    },
    orderRecorder: createOrderRecorderDouble(),
    indicatorProfile: createIndicatorUsageProfileDouble(),
    delayedSignalVerifier: {
      addSignal: (queuedSignal: { readonly signal: Signal }) => {
        delayedAdded.push(queuedSignal.signal);
      },
    },
  } as unknown as MonitorContext;

  const tradingConfig = createTradingConfig();

  const mainContext: SignalPipelineParams['mainContext'] = {
    lastState: {
      isTradingEnabled: params.isTradingEnabled ?? true,
      canTrade: params.canTradeNow ?? true,
      openProtectionActive: params.openProtectionActive ?? false,
      isHalfDay: false,
    } as SignalPipelineParams['mainContext']['lastState'],
    tradingConfig: {
      ...tradingConfig,
      global: {
        ...tradingConfig.global,
        doomsdayProtection: false,
      },
    },
    buyTaskQueue,
    sellTaskQueue,
  };

  runSignalPipeline({
    monitorSymbol: 'HSI.HK',
    monitorSnapshot: createSnapshot(),
    monitorContext,
    mainContext,
    runtimeFlags: {
      currentTime: new Date('2026-02-16T09:31:00.000Z'),
      openProtectionActive: params.openProtectionActive ?? false,
    },
    seatInfo: params.seatInfo ?? createSeatInfo(),
  });

  return {
    buyTaskQueue,
    sellTaskQueue,
    delayedAdded,
    getGenerateSignalsCallCount: () => generateSignalsCallCount,
  };
}

describe('signalPipeline business flow', () => {
  it('routes immediate/delayed signals to correct queues and binds seatVersion without quote enrichment', () => {
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
    expect(queuedBuy?.data.symbolName).toBeNull();

    expect(queuedSell?.type).toBe('IMMEDIATE_SELL');
    expect(queuedSell?.data.seatVersion).toBe(11);
    expect(queuedSell?.data.symbolName).toBeNull();

    expect(harness.delayedAdded).toHaveLength(1);
    expect(harness.delayedAdded[0]?.seatVersion).toBe(11);
  });

  it('routes buy and sell signals without quote enrichment in seat info', () => {
    const immediateBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    const immediateSell = createSignalDouble('SELLCALL', 'BULL.HK');

    const harness = createPipelineHarness({
      immediateSignals: [immediateBuy, immediateSell],
      delayedSignals: [],
    });

    const queuedBuy = harness.buyTaskQueue.pop();
    expect(queuedBuy?.data.action).toBe('BUYCALL');
    const queuedSell = harness.sellTaskQueue.pop();
    expect(queuedSell?.data.action).toBe('SELLCALL');
  });

  it('does not generate or enqueue valid signals when trading gate is disabled', () => {
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
    expect(harness.getGenerateSignalsCallCount()).toBe(0);
  });

  it('does not generate or enqueue valid signals when continuous trading gate is closed', () => {
    const immediateBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    const delayedBuy = createSignalDouble('BUYPUT', 'BEAR.HK');

    const harness = createPipelineHarness({
      immediateSignals: [immediateBuy],
      delayedSignals: [delayedBuy],
      canTradeNow: false,
    });

    expect(harness.buyTaskQueue.isEmpty()).toBeTrue();
    expect(harness.sellTaskQueue.isEmpty()).toBeTrue();
    expect(harness.delayedAdded).toHaveLength(0);
    expect(harness.getGenerateSignalsCallCount()).toBe(0);
  });

  it('returns early during opening protection without generating or enqueuing signals', () => {
    const harness = createPipelineHarness({
      immediateSignals: [createSignalDouble('BUYCALL', 'BULL.HK')],
      delayedSignals: [createSignalDouble('BUYPUT', 'BEAR.HK')],
      openProtectionActive: true,
    });

    expect(harness.buyTaskQueue.isEmpty()).toBeTrue();
    expect(harness.sellTaskQueue.isEmpty()).toBeTrue();
    expect(harness.getGenerateSignalsCallCount()).toBe(0);
  });
});
