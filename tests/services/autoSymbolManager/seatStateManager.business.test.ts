/**
 * seatStateManager 业务测试
 *
 * 功能：
 * - 验证席位状态管理相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import { getHKDateKey } from '../../../src/utils/helpers/tradingTime.js';

import { createSymbolRegistryDouble } from '../../helpers/testDoubles.js';

describe('autoSymbolManager seatStateManager business flow', () => {
  it('clearSeat bumps seat version and puts seat into SWITCHING with switch state snapshot', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const switchStates = new Map();
    const switchSuppressions = new Map();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');

    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: {
        warn: () => {},
      } as never,
      getHKDateKey,
    });

    const nextVersion = manager.clearSeat({
      direction: 'LONG',
      reason: 'test-clear-seat',
    });

    expect(nextVersion).toBe(2);
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);

    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('SWITCHING');
    expect(seat.symbol).toBe('OLD_BULL.HK');

    const switchState = switchStates.get('LONG') as {
      stage: string;
      oldSymbol: string;
      seatVersion: number;
    };
    expect(switchState.stage).toBe('CANCEL_PENDING');
    expect(switchState.oldSymbol).toBe('OLD_BULL.HK');
    expect(switchState.seatVersion).toBe(2);
  });

  it('suppression is valid on same HK date and auto-clears on date rollover', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
    });

    const switchStates = new Map();
    const switchSuppressions = new Map();
    let now = new Date('2026-02-16T01:00:00.000Z');

    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => now,
      logger: {
        warn: () => {},
      } as never,
      getHKDateKey,
    });

    manager.markSuppression('LONG', 'OLD_BULL.HK');

    const sameDay = manager.resolveSuppression('LONG', 'OLD_BULL.HK');
    expect(sameDay?.symbol).toBe('OLD_BULL.HK');

    now = new Date('2026-02-17T01:00:00.000Z');
    const nextDay = manager.resolveSuppression('LONG', 'OLD_BULL.HK');

    expect(nextDay).toBeNull();
    expect(switchSuppressions.size).toBe(0);
  });
});
