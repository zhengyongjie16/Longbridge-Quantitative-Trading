/**
 * seatRuntimeStore 业务测试
 *
 * 功能：
 * - 验证席位运行态 store 成为 seat 状态与版本的单一真相源
 * - 验证 legacy SymbolRegistry facade 对 seat runtime 的读写转发
 */
import { describe, expect, it } from 'bun:test';
import { createSeatRuntimeStore } from '../../../src/app/runtime/seatRuntimeStore.js';
import { createSymbolRegistryFromSeatRuntimeStore } from '../../../src/services/autoSymbolManager/utils.js';
import { createMonitorConfigDouble } from '../../helpers/testDoubles.js';

describe('seat runtime store business flow', () => {
  it('initializes static seats as READY and auto-search seats as EMPTY', () => {
    const staticMonitor = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      autoSearchConfig: {
        autoSearchEnabled: false,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
    });
    const autoSearchMonitor = createMonitorConfigDouble({
      monitorSymbol: 'MHI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });

    const store = createSeatRuntimeStore([staticMonitor, autoSearchMonitor]);

    expect(store.getSeatState('HSI.HK', 'LONG')).toMatchObject({
      symbol: 'BULL.HK',
      status: 'READY',
    });

    expect(store.getSeatState('HSI.HK', 'SHORT')).toMatchObject({
      symbol: 'BEAR.HK',
      status: 'READY',
    });

    expect(store.getSeatState('MHI.HK', 'LONG')).toMatchObject({
      symbol: null,
      status: 'EMPTY',
    });

    expect(store.getSeatState('MHI.HK', 'SHORT')).toMatchObject({
      symbol: null,
      status: 'EMPTY',
    });
  });

  it('routes SymbolRegistry facade reads and writes to the same seat runtime entry', () => {
    const monitor = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });
    const store = createSeatRuntimeStore([monitor]);
    const registry = createSymbolRegistryFromSeatRuntimeStore(store);

    registry.updateSeatState('HSI.HK', 'LONG', {
      symbol: 'AUTO_BULL.HK',
      status: 'READY',
      lastSwitchAt: 1000,
      lastSearchAt: 1000,
      lastSeatReadyAt: 1000,
      callPrice: 20_500,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    expect(store.getSeatState('HSI.HK', 'LONG')).toMatchObject({
      symbol: 'AUTO_BULL.HK',
      status: 'READY',
      callPrice: 20_500,
    });

    expect(registry.bumpSeatVersion('HSI.HK', 'LONG')).toBe(2);

    expect(store.getSeatVersion('HSI.HK', 'LONG')).toBe(2);

    expect(registry.resolveSeatBySymbol('AUTO_BULL.HK')).toEqual({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      seatState: store.getSeatState('HSI.HK', 'LONG'),
      seatVersion: 2,
    });
  });
});
