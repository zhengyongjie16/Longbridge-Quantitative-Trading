/**
 * buyProcessor 业务测试
 *
 * 功能：
 * - 验证买入处理器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createBuyTaskQueue } from '../../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createBuyProcessor } from '../../../../src/main/asyncProgram/buyProcessor/index.js';

import type { LastState, MonitorContext } from '../../../../src/types/state.js';
import type { Signal } from '../../../../src/types/signal.js';

import {
  createDoomsdayProtectionDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-16',
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

function createMonitorContext(overrides: Partial<MonitorContext> = {}): MonitorContext {
  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: 'HSI.HK',
    longVersion: 2,
    shortVersion: 3,
  });

  return {
    config: createMonitorConfigDouble(),
    state: {
      monitorSymbol: 'HSI.HK',
      monitorPrice: 20_000,
      longPrice: 1.1,
      shortPrice: 0.9,
      signal: null,
      pendingDelayedSignals: [],
      monitorValues: null,
      lastMonitorSnapshot: null,
      lastCandleFingerprint: null,
    },
    symbolRegistry,
    seatState: {
      long: symbolRegistry.getSeatState('HSI.HK', 'LONG'),
      short: symbolRegistry.getSeatState('HSI.HK', 'SHORT'),
    },
    seatVersion: {
      long: symbolRegistry.getSeatVersion('HSI.HK', 'LONG'),
      short: symbolRegistry.getSeatVersion('HSI.HK', 'SHORT'),
    },
    autoSymbolManager: {
      maybeSearchOnTick: async () => {},
      maybeSwitchOnInterval: async () => {},
      maybeSwitchOnDistance: async () => {},
      hasPendingSwitch: () => false,
      resetAllState: () => {},
    },
    strategy: {
      generateCloseSignals: () => ({ immediateSignals: [], delayedSignals: [] }),
    },
    orderRecorder: createOrderRecorderDouble(),
    dailyLossTracker: {
      resetAll: () => {},
      recalculateFromAllOrders: () => {},
      recordFilledOrder: () => {},
      getLossOffset: () => 0,
    },
    riskChecker: createRiskCheckerDouble(),
    unrealizedLossMonitor: {
      monitorUnrealizedLoss: async () => {},
    },
    delayedSignalVerifier: {
      addSignal: () => {},
      cancelAllForSymbol: () => {},
      cancelAllForDirection: () => 0,
      cancelAll: () => 0,
      getPendingCount: () => 0,
      onVerified: () => {},
      destroy: () => {},
    },
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    monitorSymbolName: 'HSI.HK',
    normalizedMonitorSymbol: 'HSI.HK',
    rsiPeriods: [6],
    emaPeriods: [7],
    psyPeriods: [13],
    longQuote: createQuoteDouble('BULL.HK', 1.1, 100),
    shortQuote: createQuoteDouble('BEAR.HK', 0.9, 100),
    monitorQuote: createQuoteDouble('HSI.HK', 20_000, 1),
    ...overrides,
  } as unknown as MonitorContext;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number = 800): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitUntil timeout');
    }
    await Bun.sleep(10);
  }
}

describe('buyProcessor business flow', () => {
  it('runs risk pipeline then executes buy order with execution-time quote price/lotSize', async () => {
    const queue = createBuyTaskQueue();
    const monitorContext = createMonitorContext();

    let riskCheckCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async (signals: Signal[]) => {
        riskCheckCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executed = 0;
    const submittedSnapshotRef: {
      current: { price: number | null | undefined; lotSize: number | null | undefined } | null;
    } = {
      current: null,
    };
    const trader = createTraderDouble({
      executeSignals: async (signals: Signal[]) => {
        executed += 1;
        const first = signals[0];
        submittedSnapshotRef.current = {
          price: first?.price,
          lotSize: first?.lotSize,
        };
        return { submittedCount: 1 };
      },
    });

    const processor = createBuyProcessor({
      taskQueue: queue,
      getMonitorContext: () => monitorContext,
      signalProcessor: signalProcessor as never,
      trader,
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal.seatVersion = 2;

    processor.start();
    queue.push({
      type: 'IMMEDIATE_BUY',
      monitorSymbol: 'HSI.HK',
      data: signal,
    });

    await waitUntil(() => executed === 1);
    await processor.stopAndDrain();

    expect(riskCheckCalls).toBe(1);
    expect(submittedSnapshotRef.current).toEqual({
      price: 1.1,
      lotSize: 100,
    });
  });

  it('treats risk rejection as successful handling and does not submit order', async () => {
    const queue = createBuyTaskQueue();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async () => {
        riskCalls += 1;
        return [];
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1 };
      },
    });

    const processor = createBuyProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor as never,
      trader,
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal.seatVersion = 2;

    processor.start();
    queue.push({ type: 'IMMEDIATE_BUY', monitorSymbol: 'HSI.HK', data: signal });

    await waitUntil(() => riskCalls === 1);
    await Bun.sleep(20);
    await processor.stopAndDrain();

    expect(executeCalls).toBe(0);
  });

  it('drops stale-seat-version buy signal before risk checks', async () => {
    const queue = createBuyTaskQueue();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async () => {
        riskCalls += 1;
        return [];
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1 };
      },
    });

    const processor = createBuyProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor as never,
      trader,
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    const staleSignal = createSignalDouble('BUYCALL', 'BULL.HK');
    staleSignal.seatVersion = 1;

    processor.start();
    queue.push({ type: 'IMMEDIATE_BUY', monitorSymbol: 'HSI.HK', data: staleSignal });

    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(riskCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it('base gate blocks task before processTask when lifecycle gate is closed', async () => {
    const queue = createBuyTaskQueue();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async () => {
        riskCalls += 1;
        return [];
      },
      resetRiskCheckCooldown: () => {},
    };

    const processor = createBuyProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor as never,
      trader: createTraderDouble(),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getLastState: () => createLastState(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => false,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal.seatVersion = 2;

    processor.start();
    queue.push({ type: 'IMMEDIATE_BUY', monitorSymbol: 'HSI.HK', data: signal });

    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(riskCalls).toBe(0);
  });
});
