/**
 * api-flaky-recovery 混沌测试
 *
 * 功能：
 * - 围绕 api-flaky-recovery.test.ts 场景验证 tests/chaos 相关业务行为与边界条件。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderType, type TradeContext } from 'longport';

import { API } from '../../src/constants/index.js';
import { createOrderMonitor } from '../../src/core/trader/orderMonitor.js';
import type { OrderMonitorDeps } from '../../src/core/trader/types.js';
import { createPostTradeRefresher } from '../../src/main/asyncProgram/postTradeRefresher/index.js';
import type { MonitorContext, LastState } from '../../src/types/state.js';
import { createRefreshGate } from '../../src/utils/refreshGate/index.js';

import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createTradeContextMock } from '../../mock/longport/tradeContextMock.js';
import {
  createAccountSnapshotDouble,
  createLiquidationCooldownTrackerDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createQuoteDouble,
} from '../helpers/testDoubles.js';

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

function createOrderMonitorDeps(params?: {
  readonly sellTimeoutSeconds?: number;
  readonly orderRecorder?: ReturnType<typeof createOrderRecorderDouble>;
}): { deps: OrderMonitorDeps; tradeCtx: ReturnType<typeof createTradeContextMock> } {
  const tradeCtx = createTradeContextMock();
  const deps: OrderMonitorDeps = {
    ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
    rateLimiter: {
      throttle: async () => {},
    },
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => [],
    },
    orderRecorder: params?.orderRecorder ?? createOrderRecorderDouble(),
    dailyLossTracker: {
      resetAll: () => {},
      recalculateFromAllOrders: () => {},
      recordFilledOrder: () => {},
      getLossOffset: () => 0,
    },
    orderHoldRegistry: {
      trackOrder: () => {},
      markOrderFilled: () => {},
      seedFromOrders: () => {},
      getHoldSymbols: () => new Set<string>(),
      clear: () => {},
    },
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    tradingConfig: createTradingConfig({
      global: {
        ...createTradingConfig().global,
        buyOrderTimeout: {
          enabled: true,
          timeoutSeconds: 999,
        },
        sellOrderTimeout: {
          enabled: true,
          timeoutSeconds: params?.sellTimeoutSeconds ?? 0,
        },
        orderMonitorPriceUpdateInterval: 0,
      },
    }),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
  };

  return { deps, tradeCtx };
}

describe('chaos: api flaky recovery', () => {
  it('retries timeout conversion on next tick after transient cancelOrder failure', async () => {
    const orderRecorder = createOrderRecorderDouble({
      markSellCancelled: (orderId) => ({
        orderId,
        symbol: 'BULL.HK',
        direction: 'LONG',
        submittedQuantity: 100,
        filledQuantity: 0,
        relatedBuyOrderIds: ['BUY-001'],
        status: 'cancelled',
        submittedAt: Date.now(),
      }),
    });
    const { deps, tradeCtx } = createOrderMonitorDeps({
      sellTimeoutSeconds: 0,
      orderRecorder,
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'transient cancelOrder failure',
    });

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    monitor.trackOrder({
      orderId: 'SELL-CHAOS-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    const quotesMap = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.01)]]);
    await monitor.processWithLatestQuotes(quotesMap);
    await monitor.processWithLatestQuotes(quotesMap);

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(2);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
  });

  it('keeps pending refresh symbols and drains merged backlog after API recovery', async () => {
    const refreshGate = createRefreshGate();
    const staleVersion = refreshGate.markStale();
    const lastState = createLastState();

    let accountCallCount = 0;
    const refreshedSymbols: string[] = [];

    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        accountCallCount += 1;
        if (accountCallCount === 1) {
          throw new Error('account API temporary unavailable');
        }
        return createAccountSnapshotDouble(66_000);
      },
      getStockPositions: async () => [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 300,
          availableQuantity: 300,
        }),
      ],
    });

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
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        shortSeat: {
          symbol: 'BEAR.HK',
          status: 'READY',
          lastSwitchAt: null,
          lastSearchAt: null,
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
        getLossOffset: () => 0,
      },
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async (_orderRecorder, symbol) => {
          refreshedSymbols.push(symbol);
          return { r1: 100, n1: 100 };
        },
      }),
    } as unknown as MonitorContext;

    const refresher = createPostTradeRefresher({
      refreshGate,
      trader,
      lastState,
      monitorContexts: new Map([['HSI.HK', monitorContext]]),
      displayAccountAndPositions: async () => {},
    });

    refresher.enqueue({
      pending: [{
        symbol: 'BULL.HK',
        isLongSymbol: true,
        refreshAccount: true,
        refreshPositions: true,
      }],
      quotesMap: new Map([
        ['BULL.HK', createQuoteDouble('BULL.HK', 1.01)],
      ]),
    });

    await Bun.sleep(80);

    refresher.enqueue({
      pending: [{
        symbol: 'BEAR.HK',
        isLongSymbol: false,
        refreshAccount: false,
        refreshPositions: false,
      }],
      quotesMap: new Map([
        ['BULL.HK', createQuoteDouble('BULL.HK', 1.01)],
        ['BEAR.HK', createQuoteDouble('BEAR.HK', 1.02)],
      ]),
    });

    await Bun.sleep(API.DEFAULT_RETRY_DELAY_MS + 180);
    await refresher.stopAndDrain();

    expect(accountCallCount).toBeGreaterThanOrEqual(2);
    expect(new Set(refreshedSymbols)).toEqual(new Set(['BULL.HK', 'BEAR.HK']));
    expect(lastState.cachedAccount?.buyPower).toBe(66_000);

    const gateStatus = refreshGate.getStatus();
    expect(gateStatus.currentVersion).toBe(staleVersion);
  });
});
