/**
 * orderMonitor/settlementFlow 业务测试
 *
 * 覆盖：
 * - 买单与卖单终态结算的幂等、副作用与关联单语义
 * - 缺少归属上下文时拒绝结算，避免错误记账
 */
import { describe, expect, it, mock } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import {
  createDailyLossTrackerDouble,
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
} from '../../../helpers/testDoubles.js';
import type { OrderRecord, OrderStateChangedEvent } from '../../../../src/types/services.js';
import type { OrderHoldRegistry } from '../../../../src/core/trader/types.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';

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
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceOutcomeByOrderId: new Map(),
    orderStateChangedListeners: new Set(),
    trackedOrderIdsBySymbol: new Map(),
    routeStatesBySymbol: new Map(),
    latestRouteGenerationBySymbol: new Map(),
    runtimeState: 'ACTIVE',
    running: false,
    unsubscribeQuoteUpdated: null,
  };
}

function createOrderHoldRegistry(): OrderHoldRegistry {
  return {
    trackOrder: () => {},
    markOrderClosed: () => {},
    seedFromOrders: () => {},
    getHoldSymbols: () => new Set<string>(),
    onOrderHoldSymbolsChanged: () => () => {},
    clear: () => {},
  };
}

describe('settlementFlow business flow', () => {
  it('settles FILLED buy order once and records a post-trade refresh need plus order state event without closeSync runtime state', () => {
    const runtime = createRuntime();
    let localBuyCalls = 0;
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        recordLocalBuy: () => {
          localBuyCalls += 1;
        },
      }),
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
      },
      emitOrderStateChanged: (event) => {
        orderStateEvents.push(event);
      },
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
    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);

    expect(orderStateEvents).toEqual([
      {
        orderId: 'BUY-SETTLEMENT-IDEMPOTENT',
        symbol: 'BULL.HK',
        side: 'BUY',
        source: 'WS',
        status: 'FILLED',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedPrice: 1.02,
        executedQuantity: 100,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      },
    ]);
    expect(runtime.closedOrderIds.has('BUY-SETTLEMENT-IDEMPOTENT')).toBe(true);
    expect('closeSyncQueue' in runtime).toBe(false);
  });

  it('settles partially-filled canceled sell with quantity fallback and records a post-trade refresh need', () => {
    const runtime = createRuntime();
    const orderStateEvents: OrderStateChangedEvent[] = [];
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
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
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
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
      },
      emitOrderStateChanged: (event) => {
        orderStateEvents.push(event);
      },
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
    expect(localSellRelatedIds).toEqual([null]);
    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);

    expect(orderStateEvents).toEqual([
      {
        orderId: 'SELL-PARTIAL-FALLBACK',
        symbol: 'BULL.HK',
        side: 'SELL',
        source: 'WS',
        status: 'CANCELED',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedPrice: 1.05,
        executedQuantity: 100,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      },
    ]);
  });

  it('保留 timeout->market follow-up 占用时会在旧 orderId 下重建连续 placeholder', () => {
    const runtime = createRuntime();
    const submittedFollowUpSells: Array<{
      readonly orderId: string;
      readonly quantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellCancelled: () => ({
          orderId: 'SELL-HANDOFF-PLACEHOLDER',
          symbol: 'BULL.HK',
          direction: 'LONG',
          submittedQuantity: 200,
          filledQuantity: 0,
          relatedBuyOrderIds: ['BUY-A', 'BUY-B'],
          status: 'cancelled',
          submittedAt: Date.parse('2026-02-25T03:09:00.000Z'),
        }),
        getBuyOrdersForSymbol: () => [
          {
            orderId: 'BUY-A',
            symbol: 'BULL.HK',
            executedPrice: 1,
            executedQuantity: 100,
            executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
            submittedAt: undefined,
            updatedAt: undefined,
          },
          {
            orderId: 'BUY-B',
            symbol: 'BULL.HK',
            executedPrice: 1.1,
            executedQuantity: 100,
            executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
            submittedAt: undefined,
            updatedAt: undefined,
          },
        ],
        submitSellOrder: (orderId, _symbol, _direction, quantity, relatedBuyOrderIds) => {
          submittedFollowUpSells.push({
            orderId,
            quantity,
            relatedBuyOrderIds,
          });
        },
      }),
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      emitOrderStateChanged: () => {},
    });

    const result = settlementFlow.settleOrder({
      orderId: 'SELL-HANDOFF-PLACEHOLDER',
      closedReason: 'CANCELED',
      source: 'WS',
      symbol: 'BULL.HK',
      side: 'SELL',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      executedPrice: null,
      executedQuantity: null,
      executedTimeMs: null,
      pendingSellDisposition: {
        kind: 'HANDOFF_TO_FOLLOW_UP_SELL',
        followUpQuantity: 200,
      },
    });

    expect(result.handled).toBe(true);
    expect(result.relatedBuyOrderIds).toEqual(['BUY-A', 'BUY-B']);
    expect(submittedFollowUpSells).toEqual([
      {
        orderId: 'SELL-HANDOFF-PLACEHOLDER',
        quantity: 200,
        relatedBuyOrderIds: ['BUY-A', 'BUY-B'],
      },
    ]);
  });

  it('rejects settlement when executed close lacks attribution context', () => {
    const runtime = createRuntime();
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      emitOrderStateChanged: () => {},
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

  it('records original liquidation symbol when protective sell settlement updates episode progress', () => {
    const runtime = createRuntime();
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const recordedProgressPayloads: Array<{
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      symbol: string;
      executedTimeMs: number;
    }> = [];
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellFilled: () => null,
      }),
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
        recordProtectiveFillProgress: (params) => {
          recordedProgressPayloads.push(params);
        },
      }),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      emitOrderStateChanged: (event) => {
        orderStateEvents.push(event);
      },
    });

    const result = settlementFlow.settleOrder({
      orderId: 'PL-SETTLEMENT-001',
      closedReason: 'FILLED',
      source: 'WS',
      symbol: 'BULL.OLD.HK',
      side: 'SELL',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: true,
      executedPrice: 1.03,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(recordedProgressPayloads).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.OLD.HK',
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      },
    ]);

    expect(orderStateEvents).toEqual([
      {
        orderId: 'PL-SETTLEMENT-001',
        symbol: 'BULL.OLD.HK',
        side: 'SELL',
        source: 'WS',
        status: 'FILLED',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: true,
        executedPrice: 1.03,
        executedQuantity: 100,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      },
    ]);
  });

  it('settlement 在关闭最后一个订单时移除 symbol bucket 并销毁 route state', () => {
    const runtime = createRuntime();
    runtime.trackedOrders.set('SELL-ROUTE-CLOSE-1', {
      orderId: 'SELL-ROUTE-CLOSE-1',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      liquidationTriggerLimit: 1,
      liquidationCooldownConfig: null,
      orderType: OrderType.ELO,
      submittedPrice: 1,
      initialSubmittedPrice: 1,
      submittedQuantity: 100,
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      status: OrderStatus.New,
      submittedAt: Date.parse('2026-02-25T03:00:00.000Z'),
      lastPriceUpdateAt: Date.parse('2026-02-25T03:00:00.000Z'),
      convertedToMarket: false,
      nextCancelAttemptAt: Date.parse('2026-02-25T03:00:00.000Z'),
      cancelRetryCount: 0,
      replaceCapability: 'SUPPORTED',
      replaceBlockedUntilAt: null,
      quoteRetryAttempts: 0,
      quoteRetryNextAt: null,
      quoteRetryExhausted: false,
      replaceTempBlockedCount: 0,
      replaceResumeMode: 'TIME_BACKOFF',
      timeoutMarketConversionPending: false,
      timeoutMarketConversionTerminalState: null,
    });
    runtime.trackedOrderIdsBySymbol.set('BULL.HK', new Set(['SELL-ROUTE-CLOSE-1']));
    runtime.routeStatesBySymbol.set('BULL.HK', {
      symbol: 'BULL.HK',
      generation: 1,
      inFlight: false,
      dirty: false,
      latestQuote: null,
      pendingWakeupKind: null,
      timerHandles: new Map(),
    });
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellCancelled: () => ({
          orderId: 'SELL-ROUTE-CLOSE-1',
          symbol: 'BULL.HK',
          direction: 'LONG',
          submittedQuantity: 100,
          filledQuantity: 0,
          relatedBuyOrderIds: [],
          status: 'cancelled',
          submittedAt: Date.parse('2026-02-25T03:00:00.000Z'),
        }),
      }),
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      emitOrderStateChanged: () => {},
    });

    const result = settlementFlow.settleOrder({
      orderId: 'SELL-ROUTE-CLOSE-1',
      closedReason: 'CANCELED',
      source: 'WS',
    });

    expect(result.handled).toBe(true);
    expect(runtime.trackedOrderIdsBySymbol.has('BULL.HK')).toBe(false);
    expect(runtime.routeStatesBySymbol.has('BULL.HK')).toBe(false);
  });
});
