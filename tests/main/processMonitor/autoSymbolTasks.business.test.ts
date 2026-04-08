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
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

import { createSymbolRegistryDouble } from '../../helpers/testDoubles.js';

describe('autoSymbolTasks business scheduling', () => {
  it('always schedules LONG/SHORT AUTO_SYMBOL_TICK when auto-search is enabled', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
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
      openProtectionActive: false,
    });

    const first = monitorTaskQueue.pop();
    const second = monitorTaskQueue.pop();

    expect(first?.type).toBe('AUTO_SYMBOL_TICK');
    expect(first?.dedupeKey).toBe('HSI.HK:AUTO_SYMBOL_TICK:LONG');
    expect((first?.data as { seatVersion: number }).seatVersion).toBe(5);
    expect((first?.data as { currentTimeMs: number }).currentTimeMs).toBe(123_456);
    expect((first?.data as { openProtectionActive: boolean }).openProtectionActive).toBeFalse();
    expect((first?.data as { symbol: string | null }).symbol).toBe('BULL.HK');

    expect(second?.type).toBe('AUTO_SYMBOL_TICK');
    expect(second?.dedupeKey).toBe('HSI.HK:AUTO_SYMBOL_TICK:SHORT');
    expect((second?.data as { seatVersion: number }).seatVersion).toBe(8);
    expect((second?.data as { currentTimeMs: number }).currentTimeMs).toBe(123_456);
    expect((second?.data as { openProtectionActive: boolean }).openProtectionActive).toBeFalse();
    expect((second?.data as { symbol: string | null }).symbol).toBe('BEAR.HK');
  });

  it('keeps only LONG and SHORT AUTO_SYMBOL_TICK when pending switch exists or monitor price changes', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
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
      openProtectionActive: false,
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
      openProtectionActive: false,
    });

    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });
});
