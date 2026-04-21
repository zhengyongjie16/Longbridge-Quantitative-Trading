/**
 * app runtime queueCleanup 测试
 *
 * 功能：
 * - 验证 monitorContext 缺失时直接返回
 * - 验证仅清理指定方向任务并按需写日志
 * - 验证无移除任务时不写日志
 */
import { describe, expect, it } from 'bun:test';

import { clearMonitorDirectionQueuesWithLog } from '../../../src/app/runtime/queueCleanup.js';

import type { Signal } from '../../../src/types/signal.js';
import type { MonitorContext } from '../../../src/types/state.js';

function createSignal(action: Signal['action'], symbol: string): Signal {
  return {
    action,
    symbol,
    symbolName: symbol,
    reason: null,
    seatVersion: 0,
    triggerTime: new Date(),
    price: null,
    metadata: null,
  } as Signal;
}

describe('app runtime queueCleanup', () => {
  it('returns immediately when monitorContext is missing', () => {
    const delayedCalls = 0;
    let buyRemoveCalls = 0;
    let sellRemoveCalls = 0;
    let monitorRemoveCalls = 0;
    const debugLogs: string[] = [];

    clearMonitorDirectionQueuesWithLog({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContexts: new Map(),
      buyTaskQueue: {
        removeTasks: () => {
          buyRemoveCalls += 1;
          return 0;
        },
      } as never,
      sellTaskQueue: {
        removeTasks: () => {
          sellRemoveCalls += 1;
          return 0;
        },
      } as never,
      monitorTaskQueue: {
        removeTasks: () => {
          monitorRemoveCalls += 1;
          return 0;
        },
      } as never,
      logger: {
        debug: (message: string) => {
          debugLogs.push(message);
        },
      },
    });

    expect(delayedCalls).toBe(0);
    expect(buyRemoveCalls).toBe(0);
    expect(sellRemoveCalls).toBe(0);
    expect(monitorRemoveCalls).toBe(0);
    expect(debugLogs).toHaveLength(0);
  });

  it('cleans only LONG direction tasks and writes one debug log when removals exist', () => {
    const debugLogs: string[] = [];
    const longBuySignal = createSignal('BUYCALL', 'BULL.HK');
    const shortBuySignal = createSignal('BUYPUT', 'BEAR.HK');
    const longSellSignal = createSignal('SELLCALL', 'BULL.HK');
    const shortSellSignal = createSignal('SELLPUT', 'BEAR.HK');
    const delayedDirections: Array<'LONG' | 'SHORT'> = [];

    const monitorContext = {
      delayedSignalVerifier: {
        cancelAllForDirection: (_monitorSymbol: string, direction: 'LONG' | 'SHORT') => {
          delayedDirections.push(direction);
          return direction === 'LONG' ? 2 : 0;
        },
      },
    } as unknown as MonitorContext;

    clearMonitorDirectionQueuesWithLog({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      buyTaskQueue: {
        removeTasks: (
          predicate: (task: { readonly monitorSymbol: string; readonly data: Signal }) => boolean,
          onRemove?: (task: { readonly data: Signal }) => void,
        ) => {
          const tasks = [
            { monitorSymbol: 'HSI.HK', data: longBuySignal },
            { monitorSymbol: 'HSI.HK', data: shortBuySignal },
          ];
          let removed = 0;
          for (const task of tasks) {
            if (!predicate(task)) {
              continue;
            }

            removed += 1;
            onRemove?.(task);
          }

          return removed;
        },
      } as never,
      sellTaskQueue: {
        removeTasks: (
          predicate: (task: { readonly monitorSymbol: string; readonly data: Signal }) => boolean,
          onRemove?: (task: { readonly data: Signal }) => void,
        ) => {
          const tasks = [
            { monitorSymbol: 'HSI.HK', data: longSellSignal },
            { monitorSymbol: 'HSI.HK', data: shortSellSignal },
          ];
          let removed = 0;
          for (const task of tasks) {
            if (!predicate(task)) {
              continue;
            }

            removed += 1;
            onRemove?.(task);
          }

          return removed;
        },
      } as never,
      monitorTaskQueue: {
        removeTasks: (
          predicate: (task: { readonly monitorSymbol: string; readonly data: unknown }) => boolean,
        ) => {
          const tasks = [
            { monitorSymbol: 'HSI.HK', data: { direction: 'LONG' } },
            { monitorSymbol: 'HSI.HK', data: { direction: 'SHORT' } },
          ];
          let removed = 0;
          for (const task of tasks) {
            if (predicate(task)) {
              removed += 1;
            }
          }

          return removed;
        },
      } as never,
      logger: {
        debug: (message: string) => {
          debugLogs.push(message);
        },
      },
    });

    expect(delayedDirections).toEqual(['LONG']);
    expect(debugLogs).toHaveLength(1);
    expect(debugLogs[0]).toContain('HSI.HK LONG 清理待执行信号');
    expect(debugLogs[0]).toContain('延迟=2');
    expect(debugLogs[0]).toContain('买入=1');
    expect(debugLogs[0]).toContain('卖出=1');
    expect(debugLogs[0]).toContain('监控任务=1');
  });

  it('does not log when no tasks are removed', () => {
    const debugLogs: string[] = [];
    const monitorContext = {
      delayedSignalVerifier: {
        cancelAllForDirection: () => 0,
      },
    } as unknown as MonitorContext;

    clearMonitorDirectionQueuesWithLog({
      monitorSymbol: 'HSI.HK',
      direction: 'SHORT',
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      buyTaskQueue: {
        removeTasks: () => 0,
      } as never,
      sellTaskQueue: {
        removeTasks: () => 0,
      } as never,
      monitorTaskQueue: {
        removeTasks: () => 0,
      } as never,
      logger: {
        debug: (message: string) => {
          debugLogs.push(message);
        },
      },
    });

    expect(debugLogs).toHaveLength(0);
  });
});
