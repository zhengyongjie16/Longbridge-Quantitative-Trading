/**
 * 席位缓存域单元测试
 *
 * 覆盖：midnightClear 调用 autoSymbolManager.resetAllState、warrantListCache.clear、
 * clearAllSeatBindings、syncMonitorSeatSnapshots；openRebuild 为空操作
 */
import { describe, it, expect } from 'bun:test';
import { createSeatDomain } from '../../../../src/main/lifecycle/cacheDomains/seatDomain.js';
import type { MultiMonitorTradingConfig } from '../../../../src/types/config.js';
import type { SymbolRegistry } from '../../../../src/types/seat.js';
import type { MonitorContext } from '../../../../src/types/state.js';
import type { WarrantListCache } from '../../../../src/services/autoSymbolFinder/types.js';

const emptySeatState = {
  symbol: null,
  status: 'EMPTY' as const,
  lastSwitchAt: null,
  lastSearchAt: null,
  searchFailCountToday: 0,
  frozenTradingDayKey: null,
};

describe('createSeatDomain', () => {
  it('midnightClear 依次调用 resetAllState、warrantListCache.clear、席位清空与同步', async () => {
    let resetAllStateCount = 0;
    let clearCount = 0;
    const updateCalls: Array<{ monitorSymbol: string; direction: string }> = [];
    const bumpCalls: Array<{ monitorSymbol: string; direction: string }> = [];
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        {
          config: { monitorSymbol: 'HSI.HK' },
          seatState: { long: emptySeatState, short: emptySeatState },
          seatVersion: { long: 1, short: 1 },
          autoSymbolManager: {
            resetAllState: () => {
              resetAllStateCount += 1;
            },
          },
        } as unknown as MonitorContext,
      ],
    ]);
    const tradingConfig: MultiMonitorTradingConfig = {
      monitors: [{ monitorSymbol: 'HSI.HK' } as unknown as MultiMonitorTradingConfig['monitors'][0]],
      global: {} as MultiMonitorTradingConfig['global'],
    };
    const symbolRegistry: SymbolRegistry = {
      getSeatState: () => ({ ...emptySeatState }),
      getSeatVersion: () => 1,
      resolveSeatBySymbol: () => null,
      updateSeatState: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => {
        updateCalls.push({ monitorSymbol, direction });
        return { ...emptySeatState };
      },
      bumpSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => {
        bumpCalls.push({ monitorSymbol, direction });
        return 2;
      },
    };
    const warrantListCache: WarrantListCache = {
      clear: () => {
        clearCount += 1;
      },
    } as unknown as WarrantListCache;

    const domain = createSeatDomain({
      tradingConfig,
      symbolRegistry,
      monitorContexts,
      warrantListCache,
    });

    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(resetAllStateCount).toBe(1);
    expect(clearCount).toBe(1);
    expect(updateCalls).toHaveLength(2);
    expect(
      updateCalls
        .map((c) => `${c.monitorSymbol}-${c.direction}`)
        .sort((left, right) => left.localeCompare(right, 'en')),
    ).toEqual(['HSI.HK-LONG', 'HSI.HK-SHORT']);
    expect(bumpCalls).toHaveLength(2);
  });

  it('openRebuild 为空操作，不抛错', async () => {
    const monitorContexts = new Map<string, MonitorContext>();
    const tradingConfig = { monitors: [], global: {} } as unknown as MultiMonitorTradingConfig;
    const symbolRegistry = {
      getSeatState: () => emptySeatState,
      getSeatVersion: () => 0,
      updateSeatState: () => emptySeatState,
      bumpSeatVersion: () => 0,
    } as unknown as SymbolRegistry;
    const warrantListCache = { clear: () => {} } as unknown as WarrantListCache;

    const domain = createSeatDomain({
      tradingConfig,
      symbolRegistry,
      monitorContexts,
      warrantListCache,
    });
    await domain.openRebuild({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });
  });
});
