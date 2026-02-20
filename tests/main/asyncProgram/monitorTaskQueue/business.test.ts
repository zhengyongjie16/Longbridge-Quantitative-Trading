/**
 * monitorTaskQueue 业务测试
 *
 * 功能：
 * - 验证监控任务队列相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import type {
  MonitorTaskData,
  MonitorTaskType,
} from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

describe('monitorTaskQueue business behavior', () => {
  it('scheduleLatest keeps only the latest task for the same dedupeKey', () => {
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();

    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 1,
        symbol: 'BULL.HK',
        currentTimeMs: 100,
        canTradeNow: true,
      },
    });
    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 2,
        symbol: 'BULL.HK',
        currentTimeMs: 200,
        canTradeNow: true,
      },
    });

    const first = queue.pop();

    expect((first?.data as { seatVersion: number }).seatVersion).toBe(2);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('notifies onTaskAdded callbacks and supports unregister', () => {
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();

    let calls = 0;
    const unregister = queue.onTaskAdded(() => {
      calls += 1;
    });

    queue.scheduleLatest({
      type: 'UNREALIZED_LOSS_CHECK',
      dedupeKey: 'HSI.HK:UNREALIZED_LOSS_CHECK',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        long: { seatVersion: 1, symbol: 'BULL.HK', quote: null },
        short: { seatVersion: 1, symbol: 'BEAR.HK', quote: null },
      },
    });

    unregister();

    queue.scheduleLatest({
      type: 'UNREALIZED_LOSS_CHECK',
      dedupeKey: 'HSI.HK:UNREALIZED_LOSS_CHECK:2',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        long: { seatVersion: 1, symbol: 'BULL.HK', quote: null },
        short: { seatVersion: 1, symbol: 'BEAR.HK', quote: null },
      },
    });

    expect(calls).toBe(1);
  });

  it('removeTasks and clearAll return removed count and call onRemove', () => {
    const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();

    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'A',
      monitorSymbol: 'A',
      data: {
        monitorSymbol: 'A',
        direction: 'LONG',
        seatVersion: 1,
        symbol: 'BULL.HK',
        currentTimeMs: 1,
        canTradeNow: true,
      },
    });
    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'B',
      monitorSymbol: 'B',
      data: {
        monitorSymbol: 'B',
        direction: 'SHORT',
        seatVersion: 2,
        symbol: 'BEAR.HK',
        currentTimeMs: 2,
        canTradeNow: true,
      },
    });

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
});
