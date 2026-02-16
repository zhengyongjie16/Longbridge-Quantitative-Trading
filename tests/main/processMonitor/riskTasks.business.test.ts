import { describe, expect, it } from 'bun:test';

import { scheduleRiskTasks } from '../../../src/main/processMonitor/riskTasks.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import type { MainProgramContext } from '../../../src/main/mainProgram/types.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { SeatSyncResult } from '../../../src/main/processMonitor/types.js';
import type { MonitorTaskData, MonitorTaskType } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

import {
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
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeatState: {
      symbol: 'BEAR.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
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
      }),
      longSymbolName: 'BULL',
      shortSymbolName: 'BEAR',
    } as unknown as MonitorContext;

    const mainContext = {
      marketMonitor: {
        monitorPriceChanges: () => true,
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
  });

  it('skips liquidation-distance scheduling when auto-search is enabled', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();

    const monitorContext = {
      state: {
        monitorSymbol: 'HSI.HK',
      },
      riskChecker: createRiskCheckerDouble(),
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
