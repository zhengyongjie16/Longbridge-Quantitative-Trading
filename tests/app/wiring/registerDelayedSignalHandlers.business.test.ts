/**
 * registerDelayedSignalHandlers 业务测试
 *
 * 功能：
 * - 验证延迟验证通过后的信号分流边界。
 */
import { describe, expect, it } from 'bun:test';

import { registerDelayedSignalHandlers } from '../../../src/app/wiring/registerDelayedSignalHandlers.js';
import { createLastState } from '../../main/asyncProgram/utils.js';
import {
  createDelayedSignalVerifierDouble,
  createMonitorContextDouble,
  createSignalDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

import type { Signal } from '../../../src/types/signal.js';
import type {
  BuyTaskType,
  SellTaskType,
  TaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/types.js';

type DelayedSignalHandlerHarness = Readonly<{
  callbackRef: { current: (signal: Signal, monitorSymbol: string) => void };
  monitorSymbol: string;
  buyTasks: Signal[];
  sellTasks: Signal[];
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  monitorContexts: ReturnType<typeof createMonitorContexts>;
}>;

function createTaskQueueDouble<TType extends string>(): TaskQueue<TType> {
  return {
    push: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => 0,
    onTaskAdded: () => () => {},
  };
}

function createMonitorContexts(
  monitorSymbol: string,
  callbackRef: { current: (signal: Signal, monitorSymbol: string) => void },
) {
  const symbolRegistry = createSymbolRegistryDouble({ monitorSymbol });
  const monitorContext = createMonitorContextDouble({
    symbolRegistry,
    monitorSymbolName: monitorSymbol,
    delayedSignalVerifier: createDelayedSignalVerifierDouble({
      onVerified: (callback: (signal: Signal, symbol: string) => void) => {
        callbackRef.current = callback;
      },
    }),
  });

  return new Map([[monitorSymbol, monitorContext]]);
}

function createHarness(): DelayedSignalHandlerHarness {
  const callbackRef: { current: (signal: Signal, monitorSymbol: string) => void } = {
    current: () => {
      throw new Error('verified callback not registered');
    },
  };
  const buyTasks: Signal[] = [];
  const sellTasks: Signal[] = [];
  const buyTaskQueue = createTaskQueueDouble<BuyTaskType>();
  const sellTaskQueue = createTaskQueueDouble<SellTaskType>();
  const monitorSymbol = 'HSI.HK';

  buyTaskQueue.push = (task) => {
    buyTasks.push(task.data);
  };

  sellTaskQueue.push = (task) => {
    sellTasks.push(task.data);
  };

  return {
    callbackRef,
    monitorSymbol,
    buyTasks,
    sellTasks,
    buyTaskQueue,
    sellTaskQueue,
    monitorContexts: createMonitorContexts(monitorSymbol, callbackRef),
  };
}

describe('registerDelayedSignalHandlers business flow', () => {
  it('drops HOLD signal without enqueuing buy or sell tasks', () => {
    const harness = createHarness();

    registerDelayedSignalHandlers({
      monitorContexts: harness.monitorContexts,
      lastState: createLastState({
        isTradingEnabled: true,
        canTrade: true,
        isHalfDay: false,
      }),
      buyTaskQueue: harness.buyTaskQueue,
      sellTaskQueue: harness.sellTaskQueue,
      logger: {
        debug: () => {},
        warn: () => {},
      },
      doomsdayProtectionEnabled: false,
    });

    harness.callbackRef.current(createSignalDouble('HOLD', 'BULL.HK'), harness.monitorSymbol);

    expect(harness.buyTasks).toHaveLength(0);
    expect(harness.sellTasks).toHaveLength(0);
  });

  it('enqueues verified buy signal while opening protection remains active in runtime state', () => {
    const harness = createHarness();

    registerDelayedSignalHandlers({
      monitorContexts: harness.monitorContexts,
      lastState: createLastState({
        isTradingEnabled: true,
        canTrade: true,
        openProtectionActive: true,
        isHalfDay: false,
      }),
      buyTaskQueue: harness.buyTaskQueue,
      sellTaskQueue: harness.sellTaskQueue,
      logger: {
        debug: () => {},
        warn: () => {},
      },
      doomsdayProtectionEnabled: true,
      now: () => new Date('2026-03-09T09:35:00+08:00'),
    });

    harness.callbackRef.current(createSignalDouble('BUYCALL', 'BULL.HK'), harness.monitorSymbol);

    expect(harness.buyTasks).toHaveLength(1);
    expect(harness.sellTasks).toHaveLength(0);
  });

  it('drops verified ordinary signal during doomsday clearance takeover window', () => {
    const harness = createHarness();

    registerDelayedSignalHandlers({
      monitorContexts: harness.monitorContexts,
      lastState: createLastState({
        isTradingEnabled: true,
        canTrade: true,
        isHalfDay: false,
      }),
      buyTaskQueue: harness.buyTaskQueue,
      sellTaskQueue: harness.sellTaskQueue,
      logger: {
        debug: () => {},
        warn: () => {},
      },
      doomsdayProtectionEnabled: true,
      now: () => new Date('2026-03-09T15:56:00+08:00'),
    });

    harness.callbackRef.current(createSignalDouble('BUYCALL', 'BULL.HK'), harness.monitorSymbol);

    expect(harness.buyTasks).toHaveLength(0);
    expect(harness.sellTasks).toHaveLength(0);
  });
});
