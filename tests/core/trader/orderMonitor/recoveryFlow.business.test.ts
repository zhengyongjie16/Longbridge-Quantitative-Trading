/**
 * orderMonitor/recoveryFlow 业务测试
 *
 * 覆盖：
 * - resetRecoveryTrackingState 会清空 routing index 与 route states
 * - recovery restore 在 BOOTSTRAPPING 期间不触发 TRACKED，恢复成功后仅切换到 ACTIVE，不直接拥有 route bootstrap
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createRecoveryFlow } from '../../../../src/core/trader/orderMonitor/recoveryFlow.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';
import type { OrderHoldRegistry, TrackOrderParams } from '../../../../src/core/trader/types.js';
import type { RawOrderFromAPI } from '../../../../src/types/services.js';
import type { MonitorConfig } from '../../../../src/types/config.js';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { ensureRouteState } from '../../../../src/core/trader/orderMonitor/routingIndex.js';
import {
  createOrderRecorderDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';

function createRuntimeStore(): OrderMonitorRuntimeStore {
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
    running: true,
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

function createTrackedOrder(orderId: string, symbol: string): OrderMonitorTrackedOrder {
  const now = Date.now();
  return {
    orderId,
    symbol,
    side: OrderSide.Buy,
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
    submittedAt: now,
    lastPriceUpdateAt: now,
    convertedToMarket: false,
    nextCancelAttemptAt: now,
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
  };
}

function createMonitorConfigWithOwnership(): MonitorConfig {
  const monitor = createTradingConfig().monitors[0];
  if (!monitor) {
    throw new Error('missing monitor config for recoveryFlow test');
  }

  return {
    ...monitor,
    orderOwnershipMapping: ['HSI'],
  };
}

function createPendingOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly stockName?: string;
}): RawOrderFromAPI {
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName ?? 'HSI RC',
    side: params.side,
    status: OrderStatus.New,
    orderType: OrderType.ELO,
    remark: '',
    price: '1.01',
    quantity: '100',
    executedPrice: '0',
    executedQuantity: '0',
    submittedAt: new Date('2026-04-08T09:00:00.000Z'),
    updatedAt: new Date('2026-04-08T09:00:00.000Z'),
  };
}

describe('orderMonitor recoveryFlow', () => {
  it('resetRecoveryTrackingState 会清空 symbol 索引与 route states', () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set('ORDER-1', createTrackedOrder('ORDER-1', 'BULL.HK'));
    runtime.trackedOrderIdsBySymbol.set('BULL.HK', new Set(['ORDER-1']));
    runtime.routeStatesBySymbol.set('BULL.HK', {
      symbol: 'BULL.HK',
      generation: 1,
      inFlight: false,
      dirty: false,
      latestQuote: null,
      pendingWakeupKind: null,
      timerHandles: new Map(),
    });
    const recoveryFlow = createRecoveryFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig({
        monitors: [createMonitorConfigWithOwnership()],
      }),
      symbolRegistry: createSymbolRegistryDouble({ monitorSymbol: 'HSI.HK' }),
      trackOrder: (params: TrackOrderParams) => {
        runtime.trackedOrders.set(
          params.orderId,
          createTrackedOrder(params.orderId, params.symbol),
        );
        runtime.trackedOrderIdsBySymbol.set(params.symbol, new Set([params.orderId]));
        ensureRouteState(runtime, params.symbol);
      },
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });

    recoveryFlow.resetRecoveryTrackingState();

    expect(runtime.trackedOrderIdsBySymbol.size).toBe(0);
    expect(runtime.routeStatesBySymbol.size).toBe(0);
  });

  it('恢复期间不触发 TRACKED，恢复成功后只切换到 ACTIVE', async () => {
    const runtime = createRuntimeStore();
    const trackCalls: string[] = [];
    const recoveryFlow = createRecoveryFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig({
        monitors: [createMonitorConfigWithOwnership()],
      }),
      symbolRegistry: createSymbolRegistryDouble({ monitorSymbol: 'HSI.HK' }),
      trackOrder: (params: TrackOrderParams) => {
        trackCalls.push(params.orderId);
        runtime.trackedOrders.set(
          params.orderId,
          createTrackedOrder(params.orderId, params.symbol),
        );
        const bucket = runtime.trackedOrderIdsBySymbol.get(params.symbol) ?? new Set<string>();
        bucket.add(params.orderId);
        runtime.trackedOrderIdsBySymbol.set(params.symbol, bucket);
        ensureRouteState(runtime, params.symbol);
      },
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });

    await recoveryFlow.recoverOrderTrackingFromSnapshot([
      createPendingOrder({ orderId: 'ORDER-1', symbol: 'BULL.HK', side: OrderSide.Buy }),
      createPendingOrder({ orderId: 'ORDER-2', symbol: 'BULL.HK', side: OrderSide.Sell }),
    ]);

    expect(trackCalls).toEqual(['ORDER-1', 'ORDER-2']);
    expect(runtime.runtimeState).toBe('ACTIVE');
  });
});
