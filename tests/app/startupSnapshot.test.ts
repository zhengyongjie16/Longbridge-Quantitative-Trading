/**
 * app/startupSnapshot 单元测试
 *
 * 覆盖：
 * - 启动快照成功时保留原始快照并不切换恢复状态
 * - 启动快照失败时切换 pendingOpenRebuild 分支并继续返回空快照
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longport';
import { loadStartupSnapshot } from '../../src/app/startupSnapshot.js';
import { applyStartupSnapshotFailureState } from '../../src/main/lifecycle/startupFailureState.js';
import type { Quote } from '../../src/types/quote.js';
import type { LastState } from '../../src/types/state.js';
import type { RawOrderFromAPI } from '../../src/types/services.js';

function createMinimalLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-03-09',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: {
      update: () => {},
      get: () => null,
    },
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  };
}

describe('app startup snapshot branch', () => {
  it('returns startup snapshot directly when loading succeeds', async () => {
    const now = new Date('2026-03-09T09:31:00.000Z');
    const lastState = createMinimalLastState();
    const allOrders: ReadonlyArray<RawOrderFromAPI> = [
      {
        orderId: 'A',
        symbol: 'HSI-BULL.HK',
        stockName: 'HSI BULL',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        orderType: OrderType.LO,
        price: '1',
        quantity: '100',
        executedPrice: '1',
        executedQuantity: '100',
      },
    ];
    const quotesMap = new Map<string, Quote | null>([['HSI.HK', null]]);

    const result = await loadStartupSnapshot({
      now,
      lastState,
      loadTradingDayRuntimeSnapshot: async () => ({
        allOrders,
        quotesMap,
      }),
      applyStartupSnapshotFailureState,
      logger: {
        error: () => {},
      },
      formatError: String,
    });

    expect(result.startupRebuildPending).toBe(false);
    expect(result.allOrders).toEqual(allOrders);
    expect(result.quotesMap).toEqual(quotesMap);
    expect(lastState.pendingOpenRebuild).toBe(false);
    expect(lastState.lifecycleState).toBe('ACTIVE');
  });

  it('switches to pending open rebuild and returns empty snapshot when loading fails', async () => {
    const now = new Date('2026-03-09T09:32:00.000Z');
    const lastState = createMinimalLastState();
    const errorMessages: string[] = [];

    const result = await loadStartupSnapshot({
      now,
      lastState,
      loadTradingDayRuntimeSnapshot: async () => {
        throw new Error('snapshot failed');
      },
      applyStartupSnapshotFailureState,
      logger: {
        error: (message) => {
          errorMessages.push(message);
        },
      },
      formatError: String,
    });

    expect(result.startupRebuildPending).toBe(true);
    expect(result.allOrders).toEqual([]);
    expect(result.quotesMap).toEqual(new Map());
    expect(lastState.pendingOpenRebuild).toBe(true);
    expect(lastState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
    expect(lastState.isTradingEnabled).toBe(false);
    expect(lastState.targetTradingDayKey).toBe('2026-03-09');
    expect(errorMessages).toEqual(['启动快照加载失败：已阻断交易并切换为开盘重建重试模式']);
  });
});
