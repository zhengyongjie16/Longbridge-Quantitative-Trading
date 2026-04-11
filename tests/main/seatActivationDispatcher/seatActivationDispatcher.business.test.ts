/**
 * SeatActivationDispatcher 业务测试
 *
 * 覆盖：runtime 阶段 seat 进入 ACTIVATING 后立即调度 SEAT_REFRESH。
 */
import { describe, expect, it } from 'bun:test';
import { createSeatActivationDispatcher } from '../../../src/main/seatActivationDispatcher/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createMonitorConfigDouble } from '../../helpers/testDoubles.js';

describe('SeatActivationDispatcher', () => {
  it('在 SWITCHING -> ACTIVATING 正常换标链路中写入真实旧标的', () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'OLD_BULL.HK',
    });
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const dispatcher = createSeatActivationDispatcher({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      monitorTaskQueue,
    });

    dispatcher.start();
    const nextVersion = symbolRegistry.bumpSeatVersion(monitorConfig.monitorSymbol, 'LONG');
    symbolRegistry.updateSeatState(monitorConfig.monitorSymbol, 'LONG', {
      symbol: 'NEW_BULL.HK',
      status: 'SWITCHING',
      lastSwitchAt: 123,
      lastSearchAt: 456,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    symbolRegistry.updateSeatState(monitorConfig.monitorSymbol, 'LONG', {
      symbol: 'NEW_BULL.HK',
      status: 'ACTIVATING',
      lastSwitchAt: 789,
      lastSearchAt: 790,
      lastSeatActivatedAt: null,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    dispatcher.stop();

    const task = monitorTaskQueue.pop();
    expect(task?.type).toBe('SEAT_REFRESH');
    if (task?.type !== 'SEAT_REFRESH') {
      throw new Error('expected SEAT_REFRESH task');
    }

    expect(task.data.monitorSymbol).toBe('HSI.HK');
    expect(task.data.direction).toBe('LONG');
    expect(task.data.nextSymbol).toBe('NEW_BULL.HK');
    expect(task.data.previousSymbol).toBe('OLD_BULL.HK');
    expect(task.data.seatVersion).toBe(nextVersion);
    expect(task.data.callPrice).toBe(20_000);
  });

  it('启动时 seed 已存在的 ACTIVATING seat 不会伪造旧标的', () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'OLD_BULL.HK',
    });
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const dispatcher = createSeatActivationDispatcher({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      monitorTaskQueue,
    });

    const nextVersion = symbolRegistry.bumpSeatVersion(monitorConfig.monitorSymbol, 'LONG');
    symbolRegistry.updateSeatState(monitorConfig.monitorSymbol, 'LONG', {
      symbol: 'NEW_BULL.HK',
      status: 'ACTIVATING',
      lastSwitchAt: 123,
      lastSearchAt: 456,
      lastSeatActivatedAt: null,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    dispatcher.start();
    dispatcher.stop();

    const task = monitorTaskQueue.pop();
    expect(task?.type).toBe('SEAT_REFRESH');
    if (task?.type !== 'SEAT_REFRESH') {
      throw new Error('expected SEAT_REFRESH task');
    }

    expect(task.data.monitorSymbol).toBe('HSI.HK');
    expect(task.data.direction).toBe('LONG');
    expect(task.data.nextSymbol).toBe('NEW_BULL.HK');
    expect(task.data.previousSymbol).toBeNull();
    expect(task.data.seatVersion).toBe(nextVersion);
    expect(task.data.callPrice).toBe(20_000);
  });
});
