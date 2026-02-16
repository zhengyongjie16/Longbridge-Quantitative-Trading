/**
 * @module tests/main/asyncProgram/sellProcessor/business.test.ts
 * @description 测试模块，围绕 business.test.ts 场景验证 tests/main/asyncProgram/sellProcessor 相关业务行为与边界条件。
 */
import { describe, expect, it } from 'bun:test';

import { createSellTaskQueue } from '../../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createSellProcessor } from '../../../../src/main/asyncProgram/sellProcessor/index.js';
import { createRefreshGate } from '../../../../src/utils/refreshGate/index.js';

import type { LastState, MonitorContext } from '../../../../src/types/state.js';
import type { Signal } from '../../../../src/types/signal.js';

import {
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
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
    cachedPositions: [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
      createPositionDouble({ symbol: 'BEAR.HK', quantity: 300, availableQuantity: 300 }),
    ],
    positionCache: createPositionCacheDouble([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
      createPositionDouble({ symbol: 'BEAR.HK', quantity: 300, availableQuantity: 300 }),
    ]),
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
      onRejected: () => {},
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

describe('sellProcessor business flow', () => {
  it('waits for refreshGate freshness before processing sell task', async () => {
    const queue = createSellTaskQueue();
    const refreshGate = createRefreshGate();
    const staleVersion = refreshGate.markStale();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: (signals: Signal[]) => {
        processSellCalls += 1;
        return signals;
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

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor as never,
      trader,
      getLastState: () => createLastState(),
      refreshGate,
      getCanProcessTask: () => true,
    });

    const signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal.seatVersion = 2;

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });

    await Bun.sleep(50);
    expect(processSellCalls).toBe(0);

    refreshGate.markFresh(staleVersion);

    await waitUntil(() => executeCalls === 1);
    await processor.stopAndDrain();

    expect(processSellCalls).toBe(1);
  });

  it('skips stale-seat-version sell signal before sell quantity resolution', async () => {
    const queue = createSellTaskQueue();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: () => {
        processSellCalls += 1;
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

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor as never,
      trader,
      getLastState: () => createLastState(),
      refreshGate: createRefreshGate(),
      getCanProcessTask: () => true,
    });

    const staleSignal = createSignalDouble('SELLCALL', 'BULL.HK');
    staleSignal.seatVersion = 1;

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: staleSignal });

    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it('does not execute when processSellSignals turns signal into HOLD', async () => {
    const queue = createSellTaskQueue();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: (signals: Signal[]) => {
        processSellCalls += 1;
        const first = signals[0];
        if (first) {
          first.action = 'HOLD';
        }
        return signals;
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

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor as never,
      trader,
      getLastState: () => createLastState(),
      refreshGate: createRefreshGate(),
      getCanProcessTask: () => true,
    });

    const signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal.seatVersion = 2;

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });

    await waitUntil(() => processSellCalls === 1);
    await Bun.sleep(20);
    await processor.stopAndDrain();

    expect(executeCalls).toBe(0);
  });

  it('blocks final execution when lifecycle gate closes after sell-quantity resolution', async () => {
    const queue = createSellTaskQueue();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: (signals: Signal[]) => {
        processSellCalls += 1;
        return signals;
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

    let gateCheckCount = 0;
    const dynamicGate = () => {
      gateCheckCount += 1;
      return gateCheckCount === 1;
    };

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => createMonitorContext(),
      signalProcessor: signalProcessor as never,
      trader,
      getLastState: () => createLastState(),
      refreshGate: createRefreshGate(),
      getCanProcessTask: dynamicGate,
    });

    const signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal.seatVersion = 2;

    processor.start();
    queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });

    await waitUntil(() => processSellCalls === 1);
    await Bun.sleep(20);
    await processor.stopAndDrain();

    expect(executeCalls).toBe(0);
  });
});
