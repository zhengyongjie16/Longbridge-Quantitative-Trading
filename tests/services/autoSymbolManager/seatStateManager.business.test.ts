/**
 * seatStateManager 业务测试
 *
 * 功能：
 * - 验证席位状态管理相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import type {
  SwitchState,
  SwitchSuppression,
} from '../../../src/services/autoSymbolManager/types.js';
import { createSymbolRegistryDouble } from '../../helpers/testDoubles.js';
import { getHKDateKey } from '../../../src/utils/time/index.js';
import { createLoggerStub } from './utils.js';

function createSwitchStatesMap(): Map<'LONG' | 'SHORT', SwitchState> {
  return new Map<'LONG' | 'SHORT', SwitchState>();
}

function createSwitchSuppressionsMap(): Map<'LONG' | 'SHORT', SwitchSuppression> {
  return new Map<'LONG' | 'SHORT', SwitchSuppression>();
}

describe('autoSymbolManager seatStateManager business flow', () => {
  it('enterSwitchingSeat bumps seat version and puts seat into SWITCHING with switch state snapshot', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const nextVersion = manager.enterSwitchingSeat({
      direction: 'LONG',
      reason: 'test-enter-switching-seat',
    });
    expect(nextVersion).toBe(2);
    expect(symbolRegistry.getSeatVersion('HSI.HK', 'LONG')).toBe(2);
    const seat = symbolRegistry.getSeatState('HSI.HK', 'LONG');
    expect(seat.status).toBe('SWITCHING');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    const switchState = switchStates.get('LONG');
    expect(switchState).toBeDefined();
    if (!switchState) {
      throw new Error('LONG switch state must exist after enterSwitchingSeat');
    }

    expect(switchState.stage).toBe('CANCEL_PENDING');
    expect(switchState.oldSymbol).toBe('OLD_BULL.HK');
    expect(switchState.seatVersion).toBe(2);
  });

  it('suppression is valid on same HK date and auto-clears on date rollover', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let now = new Date('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });
    manager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');
    const sameDay = manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');
    expect(sameDay?.symbol).toBe('OLD_BULL.HK');
    now = new Date('2026-02-17T01:00:00.000Z');
    const nextDay = manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');
    expect(nextDay).toBeNull();
    expect(switchSuppressions.size).toBe(0);
  });

  it('keeps PERIODIC and DISTANCE_SAFE_SIDE suppressions independent on same symbol and day', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const now = new Date('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });

    manager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');

    expect(manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE')).toBeNull();
    expect(manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC')).not.toBeNull();

    manager.markSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE');

    const periodicSuppression = manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');
    const safeSideSuppression = manager.resolveSuppression(
      'LONG',
      'OLD_BULL.HK',
      'DISTANCE_SAFE_SIDE',
    );

    expect(periodicSuppression).not.toBeNull();
    expect(safeSideSuppression).not.toBeNull();

    const expectedTriggerKinds = ['DISTANCE_SAFE_SIDE', 'PERIODIC'] as const;
    const expectedTriggerKindsList = [...expectedTriggerKinds];
    const compareTriggerKind = (
      left: (typeof expectedTriggerKinds)[number],
      right: (typeof expectedTriggerKinds)[number],
    ): number => expectedTriggerKinds.indexOf(left) - expectedTriggerKinds.indexOf(right);

    const periodicTriggerKinds = [...(periodicSuppression?.suppressedTriggerKinds ?? [])].sort(
      compareTriggerKind,
    );
    const safeSideTriggerKinds = [...(safeSideSuppression?.suppressedTriggerKinds ?? [])].sort(
      compareTriggerKind,
    );

    expect(periodicTriggerKinds).toEqual(expectedTriggerKindsList);
    expect(safeSideTriggerKinds).toEqual(expectedTriggerKindsList);
  });

  it('keeps suppression independent when DISTANCE_SAFE_SIDE is recorded before PERIODIC', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const now = new Date('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });

    manager.markSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE');
    manager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');

    expect(manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE')).not.toBeNull();
    expect(manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC')).not.toBeNull();
  });

  it('keeps LONG and SHORT suppressions isolated on same symbol and day', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const now = new Date('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });

    manager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');

    expect(manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC')).not.toBeNull();
    expect(manager.resolveSuppression('SHORT', 'OLD_BULL.HK', 'PERIODIC')).toBeNull();
  });

  it('auto-clears suppression when symbol changes on same day', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const now = new Date('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });

    manager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');

    expect(manager.resolveSuppression('LONG', 'NEW_BULL.HK', 'PERIODIC')).toBeNull();
    expect(switchSuppressions.size).toBe(0);
  });
});
