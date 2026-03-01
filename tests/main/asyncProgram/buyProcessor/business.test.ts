/**
 * buyProcessor 业务测试
 *
 * 功能：
 * - 验证买入处理器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createBuyTaskQueue } from '../../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createBuyProcessor } from '../../../../src/main/asyncProgram/buyProcessor/index.js';

import type { Signal } from '../../../../src/types/signal.js';

import {
  createDoomsdayProtectionDouble,
  createSignalDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import {
  createLastState,
  createMonitorContext,
  runProcessorFlow,
} from '../utils.js';

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
        return { submittedCount: 1, submittedOrderIds: [] };
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

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({
          type: 'IMMEDIATE_BUY',
          monitorSymbol: 'HSI.HK',
          data: signal,
        });
      },
      waitCondition: () => executed === 1,
    });

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
        return { submittedCount: 1, submittedOrderIds: [] };
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

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_BUY', monitorSymbol: 'HSI.HK', data: signal });
      },
      waitCondition: () => riskCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

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
        return { submittedCount: 1, submittedOrderIds: [] };
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
