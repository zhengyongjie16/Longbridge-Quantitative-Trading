/**
 * runtime facade 业务测试
 *
 * 功能：
 * - 验证新 runtime stores 作为真相源时，legacy LastState facade 仍能保持旧读写语义
 * - 验证 market data runtime store 能承载旧 allTradingSymbols 投影
 */
import { describe, expect, it } from 'bun:test';
import { createSystemRuntimeStateStore } from '../../../src/app/runtime/systemRuntimeStateStore.js';
import { createTradingDayReadModelStore } from '../../../src/app/runtime/tradingDayReadModelStore.js';
import { createMonitorRuntimeStore } from '../../../src/app/runtime/monitorRuntimeStore.js';
import { createMarketDataRuntimeStore } from '../../../src/app/runtime/marketDataRuntimeStore.js';
import { createLegacyLastStateFacade } from '../../../src/app/runtime/legacyStateFacade.js';
import { createPositionCacheDouble } from '../../helpers/testDoubles.js';
import type { MonitorState } from '../../../src/types/state.js';

function createMonitorState(monitorSymbol: string): MonitorState {
  return {
    monitorSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
    lastCandleFingerprint: null,
  };
}

describe('legacy state facade business flow', () => {
  it('forwards LastState writes into runtime stores', () => {
    const systemRuntimeStateStore = createSystemRuntimeStateStore({
      canTrade: null,
      isHalfDay: null,
      openProtectionActive: null,
      currentDayKey: '2026-03-08',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      targetTradingDayKey: null,
      isTradingEnabled: true,
      cachedAccount: null,
      cachedPositions: [],
      positionCache: createPositionCacheDouble(),
      gatePolicySnapshot: null,
    });
    const tradingDayReadModelStore = createTradingDayReadModelStore({
      cachedTradingDayInfo: null,
      tradingCalendarSnapshot: new Map(),
    });
    const monitorRuntimeStore = createMonitorRuntimeStore(
      new Map([['HSI.HK', createMonitorState('HSI.HK')]]),
    );
    const marketDataRuntimeStore = createMarketDataRuntimeStore();
    const lastState = createLegacyLastStateFacade({
      systemRuntimeStateStore,
      tradingDayReadModelStore,
      monitorRuntimeStore,
      marketDataRuntimeStore,
    });

    lastState.canTrade = true;
    lastState.isHalfDay = false;
    lastState.openProtectionActive = true;
    lastState.cachedTradingDayInfo = {
      isTradingDay: true,
      isHalfDay: false,
    };
    lastState.allTradingSymbols = new Set(['HSI.HK', 'BULL.HK']);

    expect(systemRuntimeStateStore.getState().canTrade).toBe(true);
    expect(systemRuntimeStateStore.getState().openProtectionActive).toBe(true);
    expect(tradingDayReadModelStore.getState().cachedTradingDayInfo?.isTradingDay).toBe(true);
    expect([...marketDataRuntimeStore.getState().activeTradingSymbols]).toEqual([
      'HSI.HK',
      'BULL.HK',
    ]);
    expect(lastState.monitorStates.get('HSI.HK')?.monitorSymbol).toBe('HSI.HK');
  });
});
