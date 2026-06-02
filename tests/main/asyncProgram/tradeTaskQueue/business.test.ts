/**
 * tradeTaskQueue 业务测试
 *
 * 功能：
 * - 验证买卖任务队列的 FIFO、移除、清空与任务添加回调语义。
 */
import { describe, expect, it } from 'bun:test';

import { createBuyTaskQueue } from '../../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import type {
  BuyTaskType,
  TaskQueue,
} from '../../../../src/main/asyncProgram/tradeTaskQueue/types.js';
import type { BuySignal } from '../../../../src/types/signal.js';

function createSignal(symbol: string): BuySignal {
  return {
    symbol,
    symbolName: symbol,
    action: 'BUYCALL',
    seatVersion: 1,
  };
}

function pushBuyTask(params: {
  readonly queue: TaskQueue<BuyTaskType>;
  readonly type: BuyTaskType;
  readonly monitorSymbol: string;
  readonly symbol: string;
}): void {
  params.queue.push({
    type: params.type,
    monitorSymbol: params.monitorSymbol,
    data: createSignal(params.symbol),
  });
}

describe('tradeTaskQueue business behavior', () => {
  it('pops buy tasks in FIFO order', () => {
    const queue = createBuyTaskQueue();

    pushBuyTask({
      queue,
      type: 'IMMEDIATE_BUY',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL-1.HK',
    });

    pushBuyTask({
      queue,
      type: 'IMMEDIATE_BUY',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL-2.HK',
    });

    pushBuyTask({
      queue,
      type: 'VERIFIED_BUY',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL-3.HK',
    });

    expect(queue.pop()?.data.symbol).toBe('BULL-1.HK');
    expect(queue.pop()?.data.symbol).toBe('BULL-2.HK');
    expect(queue.pop()?.data.symbol).toBe('BULL-3.HK');
    expect(queue.pop()).toBeNull();
    expect(queue.isEmpty()).toBeTrue();
  });

  it('removeTasks removes only matched active tasks and calls onRemove once per task', () => {
    const queue = createBuyTaskQueue();
    const removedSymbols: string[] = [];

    pushBuyTask({
      queue,
      type: 'IMMEDIATE_BUY',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL-1.HK',
    });

    pushBuyTask({
      queue,
      type: 'VERIFIED_BUY',
      monitorSymbol: 'TECH.HK',
      symbol: 'TECH-BULL.HK',
    });

    pushBuyTask({
      queue,
      type: 'IMMEDIATE_BUY',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL-2.HK',
    });

    const removed = queue.removeTasks(
      (task) => task.monitorSymbol === 'HSI.HK',
      (task) => {
        removedSymbols[removedSymbols.length] = task.data.symbol;
      },
    );

    expect(removed).toBe(2);
    expect(removedSymbols).toHaveLength(2);
    expect(removedSymbols).toContain('BULL-1.HK');
    expect(removedSymbols).toContain('BULL-2.HK');
    expect(queue.pop()?.data.symbol).toBe('TECH-BULL.HK');
    expect(queue.isEmpty()).toBeTrue();
  });

  it('clearAll only clears tasks that have not been popped', () => {
    const queue = createBuyTaskQueue();
    const clearedSymbols: string[] = [];

    pushBuyTask({
      queue,
      type: 'IMMEDIATE_BUY',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL-1.HK',
    });

    pushBuyTask({
      queue,
      type: 'IMMEDIATE_BUY',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL-2.HK',
    });

    expect(queue.pop()?.data.symbol).toBe('BULL-1.HK');

    const cleared = queue.clearAll((task) => {
      clearedSymbols[clearedSymbols.length] = task.data.symbol;
    });

    expect(cleared).toBe(1);
    expect(clearedSymbols).toEqual(['BULL-2.HK']);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('notifies onTaskAdded callbacks and supports unregister', () => {
    const queue = createBuyTaskQueue();
    let calls = 0;
    const unregister = queue.onTaskAdded(() => {
      calls += 1;
    });

    pushBuyTask({
      queue,
      type: 'IMMEDIATE_BUY',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL-1.HK',
    });

    unregister();

    pushBuyTask({
      queue,
      type: 'IMMEDIATE_BUY',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL-2.HK',
    });

    expect(calls).toBe(1);
  });
});
