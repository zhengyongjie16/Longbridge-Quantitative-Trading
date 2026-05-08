/**
 * app/startupSnapshot 单元测试
 *
 * 覆盖：
 * - 启动快照成功时保留原始快照并不切换恢复状态
 * - 启动快照 API 失败时切换 pendingOpenRebuild 分支且不返回空事实
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { loadStartupSnapshot } from '../../../src/app/startup/startupSnapshot.js';
import { createExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import { applyStartupSnapshotFailureState } from '../../../src/main/lifecycle/startupFailureState.js';
import type { Quote } from '../../../src/types/quote.js';
import type { LastState } from '../../../src/types/state.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';

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

    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') {
      throw new Error('预期启动快照成功');
    }

    expect(result.allOrders).toEqual(allOrders);
    expect(result.quotesMap).toEqual(quotesMap);
    expect(lastState.pendingOpenRebuild).toBe(false);
    expect(lastState.lifecycleState).toBe('ACTIVE');
  });

  it('switches to pending open rebuild without empty facts when API loading fails', async () => {
    const now = new Date('2026-03-09T09:32:00.000Z');
    const lastState = createMinimalLastState();
    const errorMessages: string[] = [];

    const result = await loadStartupSnapshot({
      now,
      lastState,
      loadTradingDayRuntimeSnapshot: async () => {
        throw createExternalApiRequestError({
          operation: 'test.snapshot',
          attempts: 1,
          cause: new Error('snapshot failed'),
        });
      },
      applyStartupSnapshotFailureState,
      logger: {
        error: (message) => {
          errorMessages.push(message);
        },
      },
      formatError: String,
    });

    expect(result.kind).toBe('API_RETRY_PENDING');
    expect(lastState.pendingOpenRebuild).toBe(true);
    expect(lastState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
    expect(lastState.isTradingEnabled).toBe(false);
    expect(lastState.targetTradingDayKey).toBe('2026-03-09');
    expect(errorMessages).toEqual(['启动快照 API 请求失败：已阻断交易并切换为开盘重建重试模式']);
  });

  it('throws non API loading errors instead of entering rebuild retry', async () => {
    const now = new Date('2026-03-09T09:33:00.000Z');
    const lastState = createMinimalLastState();

    expect(
      loadStartupSnapshot({
        now,
        lastState,
        loadTradingDayRuntimeSnapshot: async () => {
          throw new TypeError('snapshot contract broken');
        },
        applyStartupSnapshotFailureState,
        logger: {
          error: () => {},
        },
        formatError: String,
      }),
    ).rejects.toThrow(/snapshot contract broken/);
  });
});
