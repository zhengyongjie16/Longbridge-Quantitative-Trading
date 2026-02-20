/**
 * autoSymbolTasks 业务测试
 *
 * 功能：
 * - 验证自动寻标任务相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { scheduleAutoSymbolTasks } from '../../../src/main/processMonitor/autoSymbolTasks.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import type { MainProgramContext } from '../../../src/main/mainProgram/types.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type {
  MonitorTaskData,
  MonitorTaskType,
} from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

import { createSymbolRegistryDouble } from '../../helpers/testDoubles.js';

describe('autoSymbolTasks business scheduling', () => {
  it('always schedules LONG/SHORT AUTO_SYMBOL_TICK when auto-search is enabled', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longVersion: 5,
      shortVersion: 8,
    });

    const monitorContext = {
      symbolRegistry,
      autoSymbolManager: {
        hasPendingSwitch: () => false,
      },
    } as unknown as MonitorContext;

    const mainContext = {
      monitorTaskQueue,
    } as unknown as MainProgramContext;

    scheduleAutoSymbolTasks({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      mainContext,
      autoSearchEnabled: true,
      currentTimeMs: 123_456,
      canTradeNow: true,
      monitorPriceChanged: false,
      resolvedMonitorPrice: null,
      quotesMap: new Map(),
    });

    const first = monitorTaskQueue.pop();
    const second = monitorTaskQueue.pop();

    expect(first?.type).toBe('AUTO_SYMBOL_TICK');
    expect(first?.dedupeKey).toBe('HSI.HK:AUTO_SYMBOL_TICK:LONG');
    expect((first?.data as { seatVersion: number }).seatVersion).toBe(5);

    expect(second?.type).toBe('AUTO_SYMBOL_TICK');
    expect(second?.dedupeKey).toBe('HSI.HK:AUTO_SYMBOL_TICK:SHORT');
    expect((second?.data as { seatVersion: number }).seatVersion).toBe(8);
  });

  it('schedules AUTO_SYMBOL_SWITCH_DISTANCE when pending switch exists even without price change', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
    });

    const monitorContext = {
      symbolRegistry,
      autoSymbolManager: {
        hasPendingSwitch: () => true,
      },
    } as unknown as MonitorContext;

    const mainContext = {
      monitorTaskQueue,
    } as unknown as MainProgramContext;

    scheduleAutoSymbolTasks({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      mainContext,
      autoSearchEnabled: true,
      currentTimeMs: 123_456,
      canTradeNow: true,
      monitorPriceChanged: false,
      resolvedMonitorPrice: 19_999,
      quotesMap: new Map(),
    });

    const tasks: MonitorTaskType[] = [];
    while (!monitorTaskQueue.isEmpty()) {
      const task = monitorTaskQueue.pop();
      if (task) {
        tasks.push(task.type);
      }
    }

    expect(tasks).toContain('AUTO_SYMBOL_TICK');
    expect(tasks).toContain('AUTO_SYMBOL_SWITCH_DISTANCE');
  });

  it('does nothing when auto-search is disabled', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();

    scheduleAutoSymbolTasks({
      monitorSymbol: 'HSI.HK',
      monitorContext: {
        symbolRegistry: createSymbolRegistryDouble(),
        autoSymbolManager: {
          hasPendingSwitch: () => true,
        },
      } as unknown as MonitorContext,
      mainContext: {
        monitorTaskQueue,
      } as unknown as MainProgramContext,
      autoSearchEnabled: false,
      currentTimeMs: Date.now(),
      canTradeNow: true,
      monitorPriceChanged: true,
      resolvedMonitorPrice: 20_000,
      quotesMap: new Map(),
    });

    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });
});
