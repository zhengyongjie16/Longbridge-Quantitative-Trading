/**
 * orderMonitor/routingIndex 业务测试
 *
 * 覆盖：
 * - symbol bucket 与 route state 的创建、复用与销毁
 * - route 移除/重置时只清理 route 自己的 timer 句柄
 */
import { describe, expect, it } from 'bun:test';
import {
  attachTrackedOrder,
  detachTrackedOrder,
  resetRoutingIndex,
} from '../../../../src/core/trader/orderMonitor/routingIndex.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';

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

describe('orderMonitor routingIndex', () => {
  it('attachTrackedOrder 会把 orderId 挂到 symbol bucket 并确保 route state 存在', () => {
    const runtime = createRuntime();

    attachTrackedOrder(runtime, 'BULL.HK', 'ORDER-1');
    attachTrackedOrder(runtime, 'BULL.HK', 'ORDER-2');

    expect([...(runtime.trackedOrderIdsBySymbol.get('BULL.HK') ?? new Set()).values()]).toEqual([
      'ORDER-1',
      'ORDER-2',
    ]);

    expect(runtime.routeStatesBySymbol.get('BULL.HK')).toEqual({
      symbol: 'BULL.HK',
      generation: 1,
      inFlight: false,
      dirty: false,
      latestQuote: null,
      pendingWakeupKind: null,
      timerHandles: new Map(),
    });
  });

  it('detachTrackedOrder 在最后一个订单关闭时移除 bucket 与 route state，并清理 route timer', async () => {
    const runtime = createRuntime();
    attachTrackedOrder(runtime, 'BULL.HK', 'ORDER-1');
    const routeState = runtime.routeStatesBySymbol.get('BULL.HK');
    if (!routeState) {
      throw new Error('routeState should exist after attachTrackedOrder');
    }

    let timerFired = false;
    const timerHandle = setTimeout(() => {
      timerFired = true;
    }, 20);
    routeState.timerHandles.set('ORDER-1:SELL_TIMEOUT', {
      atMs: Date.now() + 20,
      handle: timerHandle,
    });

    detachTrackedOrder(runtime, 'BULL.HK', 'ORDER-1');

    expect(runtime.trackedOrderIdsBySymbol.has('BULL.HK')).toBe(false);
    expect(runtime.routeStatesBySymbol.has('BULL.HK')).toBe(false);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 40);
    });
    expect(timerFired).toBe(false);
  });

  it('同一 symbol route 重建时会推进 generation，避免旧 continuation 命中新 route', () => {
    const runtime = createRuntime();

    attachTrackedOrder(runtime, 'BULL.HK', 'ORDER-1');
    detachTrackedOrder(runtime, 'BULL.HK', 'ORDER-1');
    attachTrackedOrder(runtime, 'BULL.HK', 'ORDER-2');

    expect(runtime.routeStatesBySymbol.get('BULL.HK')?.generation).toBe(2);
    expect(runtime.latestRouteGenerationBySymbol.get('BULL.HK')).toBe(2);
  });

  it('resetRoutingIndex 会清空所有 symbol 索引与 route states', async () => {
    const runtime = createRuntime();
    attachTrackedOrder(runtime, 'BULL.HK', 'ORDER-1');
    attachTrackedOrder(runtime, 'BEAR.HK', 'ORDER-2');
    const bullRouteState = runtime.routeStatesBySymbol.get('BULL.HK');
    const bearRouteState = runtime.routeStatesBySymbol.get('BEAR.HK');
    if (!bullRouteState || !bearRouteState) {
      throw new Error('route states should exist after attachTrackedOrder');
    }

    let bullTimerFired = false;
    let bearTimerFired = false;
    bullRouteState.timerHandles.set('ORDER-1:BUY_TIMEOUT', {
      atMs: Date.now() + 20,
      handle: setTimeout(() => {
        bullTimerFired = true;
      }, 20),
    });

    bearRouteState.timerHandles.set('ORDER-2:SELL_TIMEOUT', {
      atMs: Date.now() + 20,
      handle: setTimeout(() => {
        bearTimerFired = true;
      }, 20),
    });

    resetRoutingIndex(runtime);

    expect(runtime.trackedOrderIdsBySymbol.size).toBe(0);
    expect(runtime.routeStatesBySymbol.size).toBe(0);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 40);
    });
    expect(bullTimerFired).toBe(false);
    expect(bearTimerFired).toBe(false);
  });
});
