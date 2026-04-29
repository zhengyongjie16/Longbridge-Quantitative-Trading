/**
 * monitorTaskQueue 业务测试
 *
 * 功能：
 * - 验证监控任务队列相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import type { MonitorTaskDataMap } from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

function createAutoSymbolTickTask(params: {
  readonly dedupeKey: string;
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly seatVersion: number;
}): Parameters<ReturnType<typeof createMonitorTaskQueue<MonitorTaskDataMap>>['scheduleLatest']>[0] {
  return {
    type: 'AUTO_SYMBOL_TICK',
    dedupeKey: params.dedupeKey,
    monitorSymbol: params.monitorSymbol,
    data: {
      monitorSymbol: params.monitorSymbol,
      direction: params.direction,
      seatVersion: params.seatVersion,
      symbol: `${params.monitorSymbol}:${params.direction}`,
      currentTimeMs: params.seatVersion,
    },
  };
}

describe('monitorTaskQueue business behavior', () => {
  it('scheduleLatest keeps only the latest task for the same dedupeKey', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG',
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG',
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 2,
      }),
    );

    const first = queue.pop();

    expect(first?.type).toBe('AUTO_SYMBOL_TICK');
    expect(first?.data.seatVersion).toBe(2);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('keeps FIFO order for different dedupe keys', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'A',
        monitorSymbol: 'A',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'B',
        monitorSymbol: 'B',
        direction: 'SHORT',
        seatVersion: 2,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'C',
        monitorSymbol: 'C',
        direction: 'LONG',
        seatVersion: 3,
      }),
    );

    expect(queue.pop()?.monitorSymbol).toBe('A');
    expect(queue.pop()?.monitorSymbol).toBe('B');
    expect(queue.pop()?.monitorSymbol).toBe('C');
    expect(queue.isEmpty()).toBeTrue();
  });

  it('notifies onTaskAdded callbacks for replacement tasks and supports unregister', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    let calls = 0;
    const unregister = queue.onTaskAdded(() => {
      calls += 1;
    });

    queue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'HSI.HK:SEAT_REFRESH',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 1,
        previousSymbol: 'OLD_BULL.HK',
        nextSymbol: 'BULL.HK',
        callPrice: 20_000,
        symbolName: 'BULL',
      },
    });

    queue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'HSI.HK:SEAT_REFRESH',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 2,
        previousSymbol: 'BULL.HK',
        nextSymbol: 'NEXT_BULL.HK',
        callPrice: 20_010,
        symbolName: 'NEXT_BULL',
      },
    });

    unregister();

    queue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'HSI.HK:SEAT_REFRESH:2',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        seatVersion: 2,
        previousSymbol: 'OLD_BEAR.HK',
        nextSymbol: 'BEAR.HK',
        callPrice: 20_100,
        symbolName: 'BEAR',
      },
    });

    expect(calls).toBe(2);
  });

  it('removeTasks and clearAll return removed count and call onRemove', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'A',
        monitorSymbol: 'A',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'B',
        monitorSymbol: 'B',
        direction: 'SHORT',
        seatVersion: 2,
      }),
    );

    const removedSymbols: string[] = [];
    const removed = queue.removeTasks(
      (task) => task.monitorSymbol === 'A',
      (task) => {
        removedSymbols.push(task.monitorSymbol);
      },
    );

    expect(removed).toBe(1);
    expect(removedSymbols).toEqual(['A']);

    const clearedSymbols: string[] = [];
    const cleared = queue.clearAll((task) => {
      clearedSymbols.push(task.monitorSymbol);
    });

    expect(cleared).toBe(1);
    expect(clearedSymbols).toEqual(['B']);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('removeTasks prevents removed tasks from being popped', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'A',
        monitorSymbol: 'A',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'B',
        monitorSymbol: 'B',
        direction: 'SHORT',
        seatVersion: 2,
      }),
    );

    const removed = queue.removeTasks((task) => task.dedupeKey === 'A');

    expect(removed).toBe(1);
    expect(queue.pop()?.dedupeKey).toBe('B');
    expect(queue.pop()).toBeNull();
    expect(queue.isEmpty()).toBeTrue();
  });

  it('clearAll clears active tasks after earlier pops', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'A',
        monitorSymbol: 'A',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'B',
        monitorSymbol: 'B',
        direction: 'SHORT',
        seatVersion: 2,
      }),
    );

    expect(queue.pop()?.dedupeKey).toBe('A');

    const clearedKeys: string[] = [];
    const cleared = queue.clearAll((task) => {
      clearedKeys.push(task.dedupeKey);
    });

    expect(cleared).toBe(1);
    expect(clearedKeys).toEqual(['B']);
    expect(queue.isEmpty()).toBeTrue();
  });
});
