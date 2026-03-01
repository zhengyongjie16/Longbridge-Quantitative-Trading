/**
 * sellProcessor 业务测试
 *
 * 功能：
 * - 验证卖出处理器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createSellTaskQueue } from '../../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createSellProcessor } from '../../../../src/main/asyncProgram/sellProcessor/index.js';
import { createRefreshGate } from '../../../../src/utils/refreshGate/index.js';

import type { Signal } from '../../../../src/types/signal.js';

import {
  createMonitorConfigDouble,
  createSignalDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import {
  createLastState,
  createLastStateWithPositions,
  createMonitorContext,
  runProcessorFlow,
  waitUntil,
} from '../utils.js';

describe('sellProcessor business flow', () => {
  it('passes timeout and trading-calendar context into processSellSignals', async () => {
    type CapturedSellParams = {
      readonly signals: Signal[];
      readonly smartCloseTimeoutMinutes: number | null;
      readonly isHalfDay: boolean;
      readonly tradingCalendarSnapshot: ReadonlyMap<
        string,
        { readonly isTradingDay: boolean; readonly isHalfDay: boolean }
      >;
      readonly nowMs: number;
    };

    const queue = createSellTaskQueue();
    const tradingCalendarSnapshot = new Map([
      ['2026-02-16', { isTradingDay: true, isHalfDay: true }],
    ]);
    const lastState = createLastStateWithPositions();
    lastState.isHalfDay = true;
    lastState.tradingCalendarSnapshot = tradingCalendarSnapshot;

    let capturedInput: CapturedSellParams | null = null;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: (input: unknown) => {
        const typedInput = input as CapturedSellParams;
        capturedInput = typedInput;
        return [...typedInput.signals];
      },
      resetRiskCheckCooldown: () => {},
    };

    const trader = createTraderDouble({
      executeSignals: async () => ({ submittedCount: 1, submittedOrderIds: [] }),
    });

    const monitorContext = createMonitorContext({
      config: createMonitorConfigDouble({
        smartCloseTimeoutMinutes: 45,
      }),
    });

    const processor = createSellProcessor({
      taskQueue: queue,
      getMonitorContext: () => monitorContext,
      signalProcessor: signalProcessor as never,
      trader,
      getLastState: () => lastState,
      refreshGate: createRefreshGate(),
      getCanProcessTask: () => true,
    });

    const signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal.seatVersion = 2;

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => capturedInput !== null,
    });

    const captured = capturedInput as CapturedSellParams | null;
    if (captured === null) {
      throw new Error('processSellSignals input not captured');
    }
    expect(captured.smartCloseTimeoutMinutes).toBe(45);
    expect(captured.isHalfDay).toBe(true);
    expect(captured.tradingCalendarSnapshot).toBe(tradingCalendarSnapshot);
    expect(Number.isFinite(captured.nowMs)).toBe(true);
  });

  it('waits for refreshGate freshness before processing sell task', async () => {
    const queue = createSellTaskQueue();
    const refreshGate = createRefreshGate();
    const staleVersion = refreshGate.markStale();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
        processSellCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
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
        return { submittedCount: 1, submittedOrderIds: [] };
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
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
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
        return { submittedCount: 1, submittedOrderIds: [] };
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

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => processSellCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(executeCalls).toBe(0);
  });

  it('blocks final execution when lifecycle gate closes after sell-quantity resolution', async () => {
    const queue = createSellTaskQueue();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: Signal[] }) => {
        processSellCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { submittedCount: 1, submittedOrderIds: [] };
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

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_SELL', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => processSellCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(executeCalls).toBe(0);
  });
});
