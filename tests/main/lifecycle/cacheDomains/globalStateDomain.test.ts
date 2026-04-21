/**
 * 全局状态缓存域单元测试
 *
 * 覆盖：midnightClear 禁止交易、清空 allTradingSymbols、重置各 monitorState；
 * openRebuild 调用 runTradingDayOpenRebuild(ctx.now)
 */
import { describe, it, expect } from 'bun:test';
import { createGlobalStateDomain } from '../../../../src/main/lifecycle/cacheDomains/globalStateDomain.js';
import type { LastState, MonitorState } from '../../../../src/types/state.js';
import { createAccountSnapshotDouble, createPositionDouble } from '../../../helpers/testDoubles.js';

function createMockMonitorState(monitorSymbol: string): MonitorState {
  return {
    monitorSymbol,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
    incrementalIndicatorRuntime: null,
  };
}

describe('createGlobalStateDomain', () => {
  it('midnightClear 设置 canTrade 为 false 并清空 allTradingSymbols 与缓存字段', async () => {
    const monitorStates = new Map<string, MonitorState>([
      ['HSI.HK', createMockMonitorState('HSI.HK')],
    ]);
    const positionCacheUpdateSizes: number[] = [];
    const lastState: LastState = {
      canTrade: true,
      isHalfDay: false,
      openProtectionActive: false,
      currentDayKey: null,
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      targetTradingDayKey: null,
      isTradingEnabled: true,
      cachedAccount: createAccountSnapshotDouble(100000),
      cachedPositions: [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
      ],
      positionCache: {
        update: (positions) => {
          positionCacheUpdateSizes.push(positions.length);
        },
        get: () => null,
      },
      cachedTradingDayInfo: null,
      monitorStates,
      allTradingSymbols: new Set(['12345.HK']),
    };

    let runOpenRebuildCalled = false;
    const domain = createGlobalStateDomain({
      lastState,
      runTradingDayOpenRebuild: async () => {
        runOpenRebuildCalled = true;
      },
    });

    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(lastState.canTrade).toBe(false);
    expect(lastState.allTradingSymbols.size).toBe(0);
    expect(lastState.isHalfDay).toBe(null);
    expect(lastState.openProtectionActive).toBe(null);
    expect(lastState.cachedAccount).toBe(null);
    expect(lastState.cachedPositions).toHaveLength(0);
    expect(positionCacheUpdateSizes).toEqual([0]);
    expect(lastState.cachedTradingDayInfo).toBe(null);
    const state = monitorStates.get('HSI.HK');
    expect(state).toBeDefined();
    if (state) {
      expect(state.longPrice).toBe(null);
      expect(state.signal).toBe(null);
      expect(state.pendingDelayedSignals).toHaveLength(0);
      expect(state.monitorValues).toBe(null);
      expect(state.lastMonitorSnapshot).toBe(null);
    }

    expect(runOpenRebuildCalled).toBe(false);
  });

  it('midnightClear does not mutate detached snapshot objects after resetting monitor state', async () => {
    const detachedSnapshot = {
      price: 20_000,
      changePercent: 0,
      ema: { 7: 19_980 },
      rsi: { 6: 52 },
      psy: { 13: 58 },
      mfi: 45,
      kdj: { k: 51, d: 49, j: 55 },
      macd: { macd: 10, dif: 3, dea: 2 },
      adx: null,
    };
    const monitorStates = new Map<string, MonitorState>([
      [
        'HSI.HK',
        {
          ...createMockMonitorState('HSI.HK'),
          lastMonitorSnapshot: detachedSnapshot,
        },
      ],
    ]);
    const lastState: LastState = {
      canTrade: true,
      isHalfDay: false,
      openProtectionActive: false,
      currentDayKey: null,
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      targetTradingDayKey: null,
      isTradingEnabled: true,
      cachedAccount: createAccountSnapshotDouble(100000),
      cachedPositions: [],
      positionCache: { update: () => {}, get: () => null },
      cachedTradingDayInfo: null,
      monitorStates,
      allTradingSymbols: new Set(),
    };
    const domain = createGlobalStateDomain({
      lastState,
      runTradingDayOpenRebuild: async () => {},
    });

    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(detachedSnapshot.ema[7]).toBe(19_980);
    expect(detachedSnapshot.rsi[6]).toBe(52);
    expect(detachedSnapshot.psy[13]).toBe(58);
    expect(detachedSnapshot.kdj).toEqual({ k: 51, d: 49, j: 55 });
    expect(detachedSnapshot.macd).toEqual({ macd: 10, dif: 3, dea: 2 });
  });

  it('openRebuild 调用 runTradingDayOpenRebuild(ctx.now)', async () => {
    const lastState: LastState = {
      canTrade: false,
      isHalfDay: null,
      openProtectionActive: null,
      currentDayKey: null,
      lifecycleState: 'MIDNIGHT_CLEANED',
      pendingOpenRebuild: true,
      targetTradingDayKey: null,
      isTradingEnabled: false,
      cachedAccount: null,
      cachedPositions: [],
      positionCache: { update: () => {}, get: () => null },
      cachedTradingDayInfo: null,
      monitorStates: new Map(),
      allTradingSymbols: new Set(),
    };
    let capturedNow: Date | null = null as Date | null;
    const domain = createGlobalStateDomain({
      lastState,
      runTradingDayOpenRebuild: async (now: Date) => {
        capturedNow = now;
      },
    });

    const now = new Date('2025-02-15T09:30:00Z');
    await domain.openRebuild({
      now,
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(capturedNow).not.toBe(null);
    if (capturedNow !== null) {
      expect(capturedNow.getTime()).toBe(now.getTime());
    }
  });
});
