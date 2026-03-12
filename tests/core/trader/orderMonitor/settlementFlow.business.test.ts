/**
 * orderMonitor/settlementFlow 业务测试
 *
 * 覆盖：
 * - 买单与卖单终态结算的幂等、副作用与关联单语义
 * - 缺少归属上下文时拒绝结算，避免错误记账
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  createLiquidationCooldownTrackerDouble,
  createOrderRecorderDouble,
} from '../../../helpers/testDoubles.js';
import type { TradeRecord } from '../../../../src/types/trader.js';
import type { OrderRecord } from '../../../../src/types/services.js';
import type { OrderHoldRegistry } from '../../../../src/core/trader/types.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';

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

import { createSettlementFlow } from '../../../../src/core/trader/orderMonitor/settlementFlow.js';

function createRuntime(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    pendingRefreshSymbols: [],
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceOutcomeByOrderId: new Map(),
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

describe('settlementFlow business flow', () => {
  beforeEach(() => {
    recordedTrades.length = 0;
  });

  it('settles FILLED buy order once and keeps idempotent without closeSync runtime state', () => {
    const runtime = createRuntime();
    let localBuyCalls = 0;
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        recordLocalBuy: () => {
          localBuyCalls += 1;
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        resetDirectionSegment: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    });

    const settledResult = settlementFlow.settleOrder({
      orderId: 'BUY-SETTLEMENT-IDEMPOTENT',
      closedReason: 'FILLED',
      source: 'WS',
      symbol: 'BULL.HK',
      side: 'BUY',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      executedPrice: 1.02,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
    });
    const duplicateResult = settlementFlow.settleOrder({
      orderId: 'BUY-SETTLEMENT-IDEMPOTENT',
      closedReason: 'FILLED',
      source: 'WS',
      symbol: 'BULL.HK',
      side: 'BUY',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      executedPrice: 1.02,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
    });

    expect(settledResult.handled).toBe(true);
    expect(duplicateResult.handled).toBe(false);
    expect(localBuyCalls).toBe(1);
    expect(recordedTrades).toHaveLength(1);
    expect(runtime.pendingRefreshSymbols).toHaveLength(1);
    expect(runtime.closedOrderIds.has('BUY-SETTLEMENT-IDEMPOTENT')).toBe(true);
    expect('closeSyncQueue' in runtime).toBe(false);
  });

  it('settles partially-filled canceled sell with quantity fallback and null related buy order ids', () => {
    const runtime = createRuntime();
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
    const localSellRelatedIds: Array<ReadonlyArray<string> | null> = [];
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
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
          localSellRelatedIds.push(relatedBuyOrderIds ?? null);
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        resetDirectionSegment: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    });

    const settledResult = settlementFlow.settleOrder({
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

    expect(settledResult.handled).toBe(true);
    expect(settledResult.relatedBuyOrderIds).toBeNull();
    expect(recordedTrades).toHaveLength(1);
    expect(localSellRelatedIds).toEqual([null]);
    expect(runtime.pendingRefreshSymbols).toHaveLength(1);
  });

  it('rejects settlement when executed close lacks attribution context', () => {
    const runtime = createRuntime();
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: {
        resetAll: () => {},
        resetDirectionSegment: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    });

    const result = settlementFlow.settleOrder({
      orderId: 'BUY-PARTIAL-MISSING-ATTR',
      closedReason: 'CANCELED',
      source: 'RECOVERY',
      symbol: 'BULL.HK',
      side: 'BUY',
      executedPrice: 1.02,
      executedQuantity: 20,
      executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
    });

    expect(result.handled).toBe(false);
    expect(runtime.closedOrderIds.has('BUY-PARTIAL-MISSING-ATTR')).toBe(false);
  });
});
