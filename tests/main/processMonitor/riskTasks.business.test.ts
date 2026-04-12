/**
 * riskTasks 业务测试
 *
 * 功能：
 * - 验证风控任务相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { scheduleRiskTasks } from '../../../src/main/processMonitor/riskTasks.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import type { MonitorContext } from '../../../src/types/state.js';
import type { Quote } from '../../../src/types/quote.js';
import type {
  MonitorRuntimeContext,
  SeatSyncResult,
} from '../../../src/main/processMonitor/types.js';
import type { PriceDisplayInfo } from '../../../src/services/marketMonitor/types.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

import {
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createWarrantDistanceInfoDouble,
} from '../../helpers/testDoubles.js';

function createSeatInfo(): SeatSyncResult {
  return {
    longSeatState: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeatState: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longSeatVersion: 3,
    shortSeatVersion: 4,
    longSeatActive: true,
    shortSeatActive: true,
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longQuote: createQuoteDouble('BULL.HK', 1.1),
    shortQuote: createQuoteDouble('BEAR.HK', 0.8),
  };
}

describe('riskTasks business scheduling', () => {
  it('does not schedule monitor tasks and still updates display info when conditions match', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const capturedDisplayInfo: {
      long: PriceDisplayInfo | null | undefined;
      short: PriceDisplayInfo | null | undefined;
    } = {
      long: null,
      short: null,
    };

    const monitorContext = {
      state: {
        monitorSymbol: 'HSI.HK',
      },
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: (isLong) => {
          return createWarrantDistanceInfoDouble({
            warrantType: isLong ? 'BULL' : 'BEAR',
            distanceToStrikePercent: isLong ? 0.7 : -0.8,
          });
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
          capturedDisplayInfo.long = longDisplayInfo;
          capturedDisplayInfo.short = shortDisplayInfo;
          return true;
        },
      },
      monitorTaskQueue,
    } as unknown as MonitorRuntimeContext;

    scheduleRiskTasks({
      monitorContext,
      mainContext,
      seatInfo: createSeatInfo(),
      monitorCurrentPrice: 20_000,
    });

    expect(monitorTaskQueue.pop()).toBeNull();

    const receivedLongDisplayInfo = capturedDisplayInfo.long;
    const receivedShortDisplayInfo = capturedDisplayInfo.short;

    if (
      receivedLongDisplayInfo === null ||
      receivedLongDisplayInfo === undefined ||
      receivedShortDisplayInfo === null ||
      receivedShortDisplayInfo === undefined
    ) {
      throw new Error('display info should be populated for both directions');
    }

    expect(receivedLongDisplayInfo.warrantDistanceInfo?.warrantType).toBe('BULL');
    expect(receivedLongDisplayInfo.warrantDistanceInfo?.distanceToStrikePercent?.toNumber()).toBe(
      0.7,
    );

    expect(receivedLongDisplayInfo.unrealizedLossMetrics).toEqual({
      r1: 100,
      n1: 100,
      r2: 110,
      unrealizedPnL: 10,
    });
    expect(receivedLongDisplayInfo.orderCount).toBe(2);

    expect(receivedShortDisplayInfo.warrantDistanceInfo?.warrantType).toBe('BEAR');
    expect(receivedShortDisplayInfo.warrantDistanceInfo?.distanceToStrikePercent?.toNumber()).toBe(
      -0.8,
    );

    expect(receivedShortDisplayInfo.unrealizedLossMetrics).toEqual({
      r1: 90,
      n1: 100,
      r2: 80,
      unrealizedPnL: -10,
    });
    expect(receivedShortDisplayInfo.orderCount).toBe(1);
  });

  it('still does not schedule monitor tasks when auto-search is enabled', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();

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
    } as unknown as MonitorRuntimeContext;

    scheduleRiskTasks({
      monitorContext,
      mainContext,
      seatInfo: createSeatInfo(),
      monitorCurrentPrice: 20_000,
    });

    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });
});
