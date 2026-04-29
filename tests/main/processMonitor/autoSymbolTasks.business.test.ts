/**
 * autoSymbolTasks 业务测试
 *
 * 功能：
 * - 验证自动寻标任务相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { scheduleAutoSymbolTasks } from '../../../src/main/processMonitor/autoSymbolTasks.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import type { MonitorContext } from '../../../src/types/state.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorRuntimeContext } from '../../../src/main/processMonitor/types.js';

import {
  createMonitorConfigDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

function createPeriodicMonitorConfig() {
  const baseConfig = createMonitorConfigDouble();
  return createMonitorConfigDouble({
    autoSearchConfig: {
      ...baseConfig.autoSearchConfig,
      switchIntervalMinutes: 30,
    },
  });
}

describe('autoSymbolTasks business scheduling', () => {
  it('schedules LONG/SHORT AUTO_SYMBOL_TICK only for periodic switch checks', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longVersion: 5,
      shortVersion: 8,
    });

    const monitorContext = {
      config: createPeriodicMonitorConfig(),
      symbolRegistry,
      autoSymbolManager: {
        hasPendingSwitch: () => false,
      },
    } as unknown as MonitorContext;

    const mainContext = {
      monitorTaskQueue,
    } as unknown as MonitorRuntimeContext;

    scheduleAutoSymbolTasks({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      mainContext,
      autoSearchEnabled: true,
      currentTimeMs: 123_456,
    });

    const first = monitorTaskQueue.pop();
    const second = monitorTaskQueue.pop();

    expect(first?.type).toBe('AUTO_SYMBOL_TICK');
    expect(first?.dedupeKey).toBe('HSI.HK:AUTO_SYMBOL_TICK:LONG');
    expect((first?.data as { seatVersion: number }).seatVersion).toBe(5);
    expect((first?.data as { currentTimeMs: number }).currentTimeMs).toBe(123_456);
    expect((first?.data as { symbol: string | null }).symbol).toBe('BULL.HK');

    expect(second?.type).toBe('AUTO_SYMBOL_TICK');
    expect(second?.dedupeKey).toBe('HSI.HK:AUTO_SYMBOL_TICK:SHORT');
    expect((second?.data as { seatVersion: number }).seatVersion).toBe(8);
    expect((second?.data as { currentTimeMs: number }).currentTimeMs).toBe(123_456);
    expect((second?.data as { symbol: string | null }).symbol).toBe('BEAR.HK');
  });

  it('keeps only LONG and SHORT AUTO_SYMBOL_TICK for periodic switch owner', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
    });

    const monitorContext = {
      config: createPeriodicMonitorConfig(),
      symbolRegistry,
      autoSymbolManager: {
        hasPendingSwitch: () => true,
      },
    } as unknown as MonitorContext;

    const mainContext = {
      monitorTaskQueue,
    } as unknown as MonitorRuntimeContext;

    scheduleAutoSymbolTasks({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      mainContext,
      autoSearchEnabled: true,
      currentTimeMs: 123_456,
    });

    const first = monitorTaskQueue.pop();
    const second = monitorTaskQueue.pop();
    const third = monitorTaskQueue.pop();

    expect(first?.type).toBe('AUTO_SYMBOL_TICK');
    expect(second?.type).toBe('AUTO_SYMBOL_TICK');
    expect(third).toBeNull();
  });

  it('does nothing when auto-search is disabled', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();

    scheduleAutoSymbolTasks({
      monitorSymbol: 'HSI.HK',
      monitorContext: {
        config: createPeriodicMonitorConfig(),
        symbolRegistry: createSymbolRegistryDouble(),
        autoSymbolManager: {
          hasPendingSwitch: () => true,
        },
      } as unknown as MonitorContext,
      mainContext: {
        monitorTaskQueue,
      },
      autoSearchEnabled: false,
      currentTimeMs: Date.now(),
    });

    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });
});
