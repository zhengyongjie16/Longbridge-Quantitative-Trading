import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import {
  createLiquidationCooldownTrackerDouble,
  createOrderRecorderDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';
import type { TradeRecord } from '../../../../src/types/trader.js';
import type { OrderRecord } from '../../../../src/types/services.js';
import type { OrderHoldRegistry, TrackedOrder } from '../../../../src/core/trader/types.js';
import type { OrderMonitorRuntimeStore } from '../../../../src/core/trader/orderMonitor/types.js';

const recordedTrades: TradeRecord[] = [];

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun:test mock.module 在导入目标模块前同步注册
mock.module('../../../../src/core/trader/tradeLogger.js', () => ({
  recordTrade: (tradeRecord: TradeRecord) => {
    recordedTrades.push(tradeRecord);
  },
}));

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- 避免测试输出噪音
mock.module('../../../../src/utils/logger/index.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { createCloseFlow } from '../../../../src/core/trader/orderMonitor/closeFlow.js';

function createRuntime(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map<string, TrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    pendingRefreshSymbols: [],
    bootstrappingOrderEvents: new Map(),
    closeSyncQueue: new Map(),
    closedOrderIds: new Set(),
    runtimeState: 'ACTIVE',
  };
}

function createOrderHoldRegistry(): OrderHoldRegistry {
  return {
    trackOrder: () => {},
    markOrderClosed: () => {},
    seedFromOrders: () => {},
    getHoldSymbols: () => new Set<string>(),
    clear: () => {},
  };
}

describe('closeFlow business flow', () => {
  beforeEach(() => {
    recordedTrades.length = 0;
  });

  it('returns null remainingRelatedBuyOrderIds when partial-fill settlement cannot map exact buy orders', () => {
    const buyOrders: ReadonlyArray<OrderRecord> = [
      {
        orderId: 'BUY-A',
        symbol: 'BULL.HK',
        executedPrice: 1,
        executedQuantity: 70,
        executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
        submittedAt: undefined,
        updatedAt: undefined,
      },
      {
        orderId: 'BUY-B',
        symbol: 'BULL.HK',
        executedPrice: 1.2,
        executedQuantity: 70,
        executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
        submittedAt: undefined,
        updatedAt: undefined,
      },
    ];
    const recordLocalSellCalls: Array<ReadonlyArray<string> | null> = [];
    const orderRecorder = createOrderRecorderDouble({
      markSellCancelled: () => ({
        orderId: 'SELL-PARTIAL-FALLBACK',
        symbol: 'BULL.HK',
        direction: 'LONG',
        submittedQuantity: 140,
        filledQuantity: 100,
        relatedBuyOrderIds: ['BUY-A', 'BUY-B'],
        status: 'cancelled',
        submittedAt: Date.parse('2026-02-25T03:09:00.000Z'),
      }),
      getBuyOrdersForSymbol: () => buyOrders,
      recordLocalSell: (
        _symbol,
        _executedPrice,
        _executedQuantity,
        _isLongSymbol,
        _executedTimeMs,
        _orderId,
        relatedBuyOrderIds,
      ) => {
        recordLocalSellCalls.push(relatedBuyOrderIds ?? null);
      },
    });
    const closeFlow = createCloseFlow({
      runtime: createRuntime(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder,
      dailyLossTracker: {
        resetAll: () => {},
        resetDirectionSegment: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
    });

    const result = closeFlow.finalizeOrderClose({
      orderId: 'SELL-PARTIAL-FALLBACK',
      closedReason: 'CANCELED',
      source: 'WS',
      symbol: 'BULL.HK',
      side: 'SELL',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      executedPrice: 1.05,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(result.relatedBuyOrderIds).toBeNull();
    expect(recordLocalSellCalls).toEqual([null]);
  });

  it('records partially-filled canceled or rejected sells as FILLED trades and keeps close reason in reason', () => {
    const closedReasons = ['CANCELED', 'REJECTED'] as const;

    for (const closedReason of closedReasons) {
      recordedTrades.length = 0;
      const orderRecorder = createOrderRecorderDouble({
        markSellCancelled: () => ({
          orderId: `SELL-PARTIAL-${closedReason}`,
          symbol: 'BULL.HK',
          direction: 'LONG',
          submittedQuantity: 200,
          filledQuantity: 100,
          relatedBuyOrderIds: ['BUY-1', 'BUY-2'],
          status: 'cancelled',
          submittedAt: Date.parse('2026-02-25T03:09:00.000Z'),
        }),
        getBuyOrdersForSymbol: () => [
          {
            orderId: 'BUY-1',
            symbol: 'BULL.HK',
            executedPrice: 1,
            executedQuantity: 100,
            executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
            submittedAt: undefined,
            updatedAt: undefined,
          },
          {
            orderId: 'BUY-2',
            symbol: 'BULL.HK',
            executedPrice: 1.2,
            executedQuantity: 100,
            executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
            submittedAt: undefined,
            updatedAt: undefined,
          },
        ],
      });
      const closeFlow = createCloseFlow({
        runtime: createRuntime(),
        orderHoldRegistry: createOrderHoldRegistry(),
        orderRecorder,
        dailyLossTracker: {
          resetAll: () => {},
          resetDirectionSegment: () => {},
          recalculateFromAllOrders: () => {},
          recordFilledOrder: () => {},
          getLossOffset: () => 0,
        },
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        tradingConfig: createTradingConfig(),
        symbolRegistry: createSymbolRegistryDouble(),
      });

      closeFlow.finalizeOrderClose({
        orderId: `SELL-PARTIAL-${closedReason}`,
        closedReason,
        source: 'WS',
        symbol: 'BULL.HK',
        side: 'SELL',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        executedPrice: 1.05,
        executedQuantity: 100,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
        isProtectiveLiquidation: false,
      });

      expect(recordedTrades).toHaveLength(1);
      expect(recordedTrades[0]?.status).toBe('FILLED');
      expect(recordedTrades[0]?.reason).toBe(closedReason);
      expect(recordedTrades[0]?.side).toBe('SELL');
      expect(recordedTrades[0]?.action).toBe('SELLCALL');
    }
  });
});
