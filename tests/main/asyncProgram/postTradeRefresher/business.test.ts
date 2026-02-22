/**
 * postTradeRefresher 业务测试
 *
 * 功能：
 * - 验证交易后刷新器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createPostTradeRefresher } from '../../../../src/main/asyncProgram/postTradeRefresher/index.js';
import { createRefreshGate } from '../../../../src/utils/refreshGate/index.js';
import { API } from '../../../../src/constants/index.js';

import type { LastState, MonitorContext } from '../../../../src/types/state.js';

import {
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  };
}

describe('postTradeRefresher business flow', () => {
  it('refreshes account/positions/unrealized cache and marks refresh gate fresh', async () => {
    const refreshGate = createRefreshGate();
    const staleVersion = refreshGate.markStale();
    const lastState = createLastState();

    const riskRefreshCalls: Array<{ symbol: string; isLongSymbol: boolean }> = [];

    const monitorContext = {
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        maxUnrealizedLossPerSymbol: 2_000,
      }),
      symbolRegistry: createSymbolRegistryDouble({
        monitorSymbol: 'HSI.HK',
        longSeat: {
          symbol: 'BULL.HK',
          status: 'READY',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatReadyAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        shortSeat: {
          symbol: 'BEAR.HK',
          status: 'READY',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatReadyAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
      }),
      longSymbolName: 'BULL',
      shortSymbolName: 'BEAR',
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 12,
      },
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async (_orderRecorder, symbol, isLongSymbol) => {
          riskRefreshCalls.push({ symbol, isLongSymbol });
          return { r1: 100, n1: 10 };
        },
      }),
    } as unknown as MonitorContext;

    const trader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(80_000),
      getStockPositions: async () => [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 500,
          availableQuantity: 500,
        }),
      ],
    });

    let displayCalls = 0;

    const refresher = createPostTradeRefresher({
      refreshGate,
      trader,
      lastState,
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      displayAccountAndPositions: async () => {
        displayCalls += 1;
      },
    });

    refresher.enqueue({
      pending: [
        {
          symbol: 'BULL.HK',
          isLongSymbol: true,
          refreshAccount: true,
          refreshPositions: true,
        },
      ],
      quotesMap: new Map([
        [
          'BULL.HK',
          { symbol: 'BULL.HK', name: 'BULL', price: 1.1, prevClose: 1, timestamp: Date.now() },
        ],
      ]),
    });

    await Bun.sleep(60);
    await refresher.stopAndDrain();

    expect(lastState.cachedAccount?.buyPower).toBe(80_000);
    expect(lastState.cachedPositions).toHaveLength(1);
    expect(riskRefreshCalls).toEqual([{ symbol: 'BULL.HK', isLongSymbol: true }]);
    expect(displayCalls).toBe(1);

    const status = refreshGate.getStatus();
    expect(status.staleVersion).toBe(staleVersion);
    expect(status.currentVersion).toBe(staleVersion);
  });

  it('retries failed refresh and eventually marks refresh gate fresh', async () => {
    const refreshGate = createRefreshGate();
    const staleVersion = refreshGate.markStale();
    const lastState = createLastState();

    let accountCalls = 0;

    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        accountCalls += 1;
        if (accountCalls === 1) {
          throw new Error('account temporary unavailable');
        }
        return createAccountSnapshotDouble(66_000);
      },
      getStockPositions: async () => [],
    });

    const refresher = createPostTradeRefresher({
      refreshGate,
      trader,
      lastState,
      monitorContexts: new Map(),
      displayAccountAndPositions: async () => {},
    });

    refresher.enqueue({
      pending: [
        {
          symbol: 'BULL.HK',
          isLongSymbol: true,
          refreshAccount: true,
          refreshPositions: false,
        },
      ],
      quotesMap: new Map(),
    });

    await Bun.sleep(80);
    const statusAfterFirstFailure = refreshGate.getStatus();
    expect(statusAfterFirstFailure.currentVersion).toBeLessThan(staleVersion);

    await Bun.sleep(API.DEFAULT_RETRY_DELAY_MS + 140);
    await refresher.stopAndDrain();

    expect(accountCalls).toBeGreaterThanOrEqual(2);
    expect(lastState.cachedAccount?.buyPower).toBe(66_000);

    const finalStatus = refreshGate.getStatus();
    expect(finalStatus.currentVersion).toBe(staleVersion);
  });
});
