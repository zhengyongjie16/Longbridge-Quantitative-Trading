/**
 * protective-liquidation 集成测试
 *
 * 功能：
 * - 验证保护性清仓端到端场景与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import {
  OrderSide,
  OrderStatus,
  OrderType,
  type PushOrderChanged,
  type TradeContext,
} from 'longport';
import { createOrderMonitor } from '../../src/core/trader/orderMonitor.js';
import type { OrderMonitorDeps } from '../../src/core/trader/types.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createPushOrderChanged } from '../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../mock/longport/tradeContextMock.js';
import {
  createLiquidationCooldownTrackerDouble,
  createOrderRecorderDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

describe('protective-liquidation integration', () => {
  it('records cooldown + local sell update after protective liquidation fill event', async () => {
    let capturedHandler: (event: PushOrderChanged) => void = (_event: PushOrderChanged) => {
      throw new Error('order changed handler was not captured');
    };
    let recordLocalSellCount = 0;
    let markSellFilledCount = 0;
    let cooldownRecords = 0;
    let staleMarks = 0;

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
      orderRecorder: createOrderRecorderDouble({
        recordLocalSell: () => {
          recordLocalSellCount += 1;
        },
        markSellFilled: () => {
          markSellFilledCount += 1;
          return null;
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {},
        recordFilledOrder: () => {},
        getLossOffset: () => 0,
      },
      orderHoldRegistry: {
        trackOrder: () => {},
        markOrderClosed: () => {},
        seedFromOrders: () => {},
        getHoldSymbols: () => new Set<string>(),
        clear: () => {},
      },
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        recordCooldown: () => {
          cooldownRecords += 1;
        },
      }),
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      refreshGate: {
        markStale: () => {
          staleMarks += 1;
          return staleMarks;
        },
        markFresh: () => {},
        waitForFresh: async () => {},
        getStatus: () => ({
          currentVersion: staleMarks,
          staleVersion: staleMarks,
        }),
      },
      testHooks: {
        setHandleOrderChanged: (handler) => {
          capturedHandler = handler;
        },
      },
      isExecutionAllowed: () => true,
    };

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'PL-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      quantity: 200,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.MO,
    });

    capturedHandler(
      createPushOrderChanged({
        orderId: 'PL-001',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        orderType: OrderType.MO,
        submittedQuantity: 200,
        executedQuantity: 200,
        submittedPrice: 1,
        executedPrice: 1,
      }),
    );

    expect(recordLocalSellCount).toBe(1);
    expect(markSellFilledCount).toBe(1);
    expect(cooldownRecords).toBe(1);
    expect(staleMarks).toBe(1);

    const pendingRefresh = monitor.getAndClearPendingRefreshSymbols();
    expect(pendingRefresh).toHaveLength(1);
    expect(pendingRefresh[0]?.symbol).toBe('BULL.HK');
  });
});
