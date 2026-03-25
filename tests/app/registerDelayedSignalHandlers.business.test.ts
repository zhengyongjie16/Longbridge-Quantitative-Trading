/**
 * registerDelayedSignalHandlers 业务测试
 *
 * 功能：
 * - 验证延迟验证通过后的信号分流边界与释放行为。
 */
import { describe, expect, it } from 'bun:test';

import { registerDelayedSignalHandlers } from '../../src/app/registerDelayedSignalHandlers.js';
import { createSignalDouble, createSymbolRegistryDouble } from '../helpers/testDoubles.js';

import type { Signal } from '../../src/types/signal.js';
import type {
  BuyTaskType,
  SellTaskType,
  TaskQueue,
} from '../../src/main/asyncProgram/tradeTaskQueue/types.js';

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

describe('registerDelayedSignalHandlers business flow', () => {
  it('releases HOLD signal without enqueuing buy or sell tasks', () => {
    const callbackRef: { current: (signal: Signal, monitorSymbol: string) => void } = {
      current: () => {
        throw new Error('verified callback not registered');
      },
    };
    const buyTasks: Signal[] = [];
    const sellTasks: Signal[] = [];
    const releasedSignals: Signal[] = [];

    const buyTaskQueue = createTaskQueueDouble<BuyTaskType>();
    buyTaskQueue.push = (task) => {
      buyTasks.push(task.data);
    };

    const sellTaskQueue = createTaskQueueDouble<SellTaskType>();
    sellTaskQueue.push = (task) => {
      sellTasks.push(task.data);
    };

    const monitorSymbol = 'HSI.HK';
    const symbolRegistry = createSymbolRegistryDouble({ monitorSymbol });
    const monitorContext = {
      monitorSymbolName: monitorSymbol,
      symbolRegistry,
      delayedSignalVerifier: {
        addSignal: () => {},
        onVerified: (callback: (signal: Signal, symbol: string) => void) => {
          callbackRef.current = callback;
        },
        cancelAll: () => 0,
        cancelAllForSymbol: () => {},
        cancelAllForDirection: () => 0,
        getPendingCount: () => 0,
        destroy: () => {},
      },
    };

    registerDelayedSignalHandlers({
      monitorContexts: new Map([[monitorSymbol, monitorContext as never]]),
      lastState: {
        isTradingEnabled: true,
      } as never,
      buyTaskQueue,
      sellTaskQueue,
      logger: {
        debug: () => {},
        warn: () => {},
      },
      releaseSignal: (signal) => {
        releasedSignals.push(signal);
      },
    });

    const signal = createSignalDouble('HOLD', 'BULL.HK');
    callbackRef.current(signal, monitorSymbol);

    expect(releasedSignals).toEqual([signal]);
    expect(buyTasks).toHaveLength(0);
    expect(sellTasks).toHaveLength(0);
  });
});
