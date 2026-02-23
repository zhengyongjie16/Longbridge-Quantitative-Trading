/**
 * riskTasks 业务测试
 *
 * 功能：
 * - 验证风控任务相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { scheduleRiskTasks } from '../../../src/main/processMonitor/riskTasks.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import type { MainProgramContext } from '../../../src/main/mainProgram/types.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { Quote } from '../../../src/types/quote.js';
import type { SeatSyncResult } from '../../../src/main/processMonitor/types.js';
import type { PriceDisplayInfo } from '../../../src/services/marketMonitor/types.js';
import type {
  MonitorTaskData,
  MonitorTaskType,
} from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

import {
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
} from '../../helpers/testDoubles.js';

function createSeatInfo(): SeatSyncResult {
  return {
    longSeatState: {
      symbol: 'BULL.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatReadyAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeatState: {
      symbol: 'BEAR.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatReadyAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longSeatVersion: 3,
    shortSeatVersion: 4,
    longSeatReady: true,
    shortSeatReady: true,
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longQuote: createQuoteDouble('BULL.HK', 1.1),
    shortQuote: createQuoteDouble('BEAR.HK', 0.8),
  };
}

describe('riskTasks business scheduling', () => {
  it('schedules liquidation-distance and unrealized-loss checks in one tick when conditions match', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
    let receivedLongDisplayInfo: unknown = null;
    let receivedShortDisplayInfo: unknown = null;

    const monitorContext = {
      state: {
        monitorSymbol: 'HSI.HK',
      },
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: (isLong) => {
          return {
            warrantType: isLong ? 'BULL' : 'BEAR',
            distanceToStrikePercent: isLong ? 0.7 : -0.8,
          };
        },
        getUnrealizedLossMetrics: (symbol, currentPrice) => {
          if (symbol === 'BULL.HK' && currentPrice === 1.1) {
            return {
              r1: 100,
              n1: 100,
              r2: 110,
              unrealizedPnL: 10,
            };
          }
          if (symbol === 'BEAR.HK' && currentPrice === 0.8) {
            return {
              r1: 90,
              n1: 100,
              r2: 80,
              unrealizedPnL: -10,
            };
          }
          return null;
        },
      }),
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: (symbol) => {
          if (symbol === 'BULL.HK') {
            return [
              {
                orderId: '1',
                symbol,
                executedPrice: 1,
                executedQuantity: 100,
                executedTime: 1,
                submittedAt: undefined,
                updatedAt: undefined,
              },
              {
                orderId: '2',
                symbol,
                executedPrice: 1,
                executedQuantity: 100,
                executedTime: 2,
                submittedAt: undefined,
                updatedAt: undefined,
              },
            ];
          }
          if (symbol === 'BEAR.HK') {
            return [
              {
                orderId: '3',
                symbol,
                executedPrice: 1,
                executedQuantity: 100,
                executedTime: 3,
                submittedAt: undefined,
                updatedAt: undefined,
              },
            ];
          }
          return [];
        },
      }),
      longSymbolName: 'BULL',
      shortSymbolName: 'BEAR',
    } as unknown as MonitorContext;

    const mainContext = {
      marketMonitor: {
        monitorPriceChanges: (
          _longQuote: Quote | null,
          _shortQuote: Quote | null,
          _longSymbol: string,
          _shortSymbol: string,
          _state: MonitorContext['state'],
          longDisplayInfo: PriceDisplayInfo | null | undefined,
          shortDisplayInfo: PriceDisplayInfo | null | undefined,
        ) => {
          receivedLongDisplayInfo = longDisplayInfo;
          receivedShortDisplayInfo = shortDisplayInfo;
          return true;
        },
      },
      monitorTaskQueue,
    } as unknown as MainProgramContext;

    scheduleRiskTasks({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      mainContext,
      seatInfo: createSeatInfo(),
      autoSearchEnabled: false,
      monitorPriceChanged: true,
      resolvedMonitorPrice: 20_000,
      monitorCurrentPrice: 20_000,
    });

    const first = monitorTaskQueue.pop();
    const second = monitorTaskQueue.pop();

    expect(first?.type).toBe('LIQUIDATION_DISTANCE_CHECK');
    expect(first?.dedupeKey).toBe('HSI.HK:LIQUIDATION_DISTANCE_CHECK');
    expect((first?.data as { monitorPrice: number }).monitorPrice).toBe(20_000);

    expect(second?.type).toBe('UNREALIZED_LOSS_CHECK');
    expect(second?.dedupeKey).toBe('HSI.HK:UNREALIZED_LOSS_CHECK');

    expect(receivedLongDisplayInfo).toEqual({
      warrantDistanceInfo: {
        warrantType: 'BULL',
        distanceToStrikePercent: 0.7,
      },
      unrealizedLossMetrics: {
        r1: 100,
        n1: 100,
        r2: 110,
        unrealizedPnL: 10,
      },
      orderCount: 2,
    });
    expect(receivedShortDisplayInfo).toEqual({
      warrantDistanceInfo: {
        warrantType: 'BEAR',
        distanceToStrikePercent: -0.8,
      },
      unrealizedLossMetrics: {
        r1: 90,
        n1: 100,
        r2: 80,
        unrealizedPnL: -10,
      },
      orderCount: 1,
    });
  });

  it('skips liquidation-distance scheduling when auto-search is enabled', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();

    const monitorContext = {
      state: {
        monitorSymbol: 'HSI.HK',
      },
      riskChecker: createRiskCheckerDouble(),
      orderRecorder: createOrderRecorderDouble(),
      longSymbolName: 'BULL',
      shortSymbolName: 'BEAR',
    } as unknown as MonitorContext;

    const mainContext = {
      marketMonitor: {
        monitorPriceChanges: () => false,
      },
      monitorTaskQueue,
    } as unknown as MainProgramContext;

    scheduleRiskTasks({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      mainContext,
      seatInfo: createSeatInfo(),
      autoSearchEnabled: true,
      monitorPriceChanged: true,
      resolvedMonitorPrice: 20_000,
      monitorCurrentPrice: 20_000,
    });

    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });
});
