/**
 * processMonitor/index 业务测试
 *
 * 功能：
 * - 验证 processMonitor 主流程相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createIndicatorCache } from '../../../src/main/asyncProgram/indicatorCache/index.js';
import type { CandleData } from '../../../src/types/data.js';
import type { Quote } from '../../../src/types/quote.js';
import type { ProcessMonitorParams } from '../../../src/main/processMonitor/types.js';
import type { MonitorContext } from '../../../src/types/state.js';
import {
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

type ProcessMonitorFn = (
  context: ProcessMonitorParams,
  quotesMap: ReadonlyMap<string, Quote | null>,
) => Promise<void>;

async function loadProcessMonitor(): Promise<ProcessMonitorFn> {
  const modulePath = '../../../src/main/processMonitor/index.js?real-process-monitor';
  const module = await import(modulePath);
  return module.processMonitor as ProcessMonitorFn;
}

function createCandles(length: number, start: number, step: number): ReadonlyArray<CandleData> {
  const candles: CandleData[] = [];
  for (let i = 0; i < length; i += 1) {
    const close = start + i * step;
    candles.push({
      open: close - 0.1,
      high: close + 0.2,
      low: close - 0.3,
      close,
      volume: 1_000 + i,
    });
  }
  return candles;
}

function createMonitorContext(params: {
  readonly autoSearchEnabled: boolean;
  readonly strategyGenerate: () => { immediateSignals: []; delayedSignals: [] };
}): MonitorContext {
  const config = createMonitorConfigDouble({
    monitorSymbol: 'HSI.HK',
    autoSearchConfig: {
      autoSearchEnabled: params.autoSearchEnabled,
      autoSearchMinDistancePctBull: 0.35,
      autoSearchMinDistancePctBear: -0.35,
      autoSearchMinTurnoverPerMinuteBull: 100_000,
      autoSearchMinTurnoverPerMinuteBear: 100_000,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 0,
      switchIntervalMinutes: 0,
      switchDistanceRangeBull: { min: 0.2, max: 1.5 },
      switchDistanceRangeBear: { min: -1.5, max: -0.2 },
    },
  });

  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: config.monitorSymbol,
    longSeat: {
      symbol: 'BULL.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatReadyAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'READY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatReadyAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longVersion: 2,
    shortVersion: 3,
  });

  return {
    config,
    state: {
      monitorSymbol: config.monitorSymbol,
      monitorPrice: 20_000,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingDelayedSignals: [],
      monitorValues: null,
      lastMonitorSnapshot: null,
      lastCandleFingerprint: null,
    },
    symbolRegistry,
    seatState: {
      long: symbolRegistry.getSeatState(config.monitorSymbol, 'LONG'),
      short: symbolRegistry.getSeatState(config.monitorSymbol, 'SHORT'),
    },
    seatVersion: {
      long: symbolRegistry.getSeatVersion(config.monitorSymbol, 'LONG'),
      short: symbolRegistry.getSeatVersion(config.monitorSymbol, 'SHORT'),
    },
    autoSymbolManager: {
      maybeSearchOnTick: async () => {},
      maybeSwitchOnInterval: async () => {},
      maybeSwitchOnDistance: async () => {},
      hasPendingSwitch: () => false,
      resetAllState: () => {},
    },
    strategy: {
      generateCloseSignals: params.strategyGenerate,
    },
    orderRecorder: createOrderRecorderDouble(),
    dailyLossTracker: {
      resetAll: () => {},
      recalculateFromAllOrders: () => {},
      recordFilledOrder: () => {},
      getLossOffset: () => 0,
    },
    riskChecker: createRiskCheckerDouble(),
    unrealizedLossMonitor: {
      monitorUnrealizedLoss: async () => {},
    },
    delayedSignalVerifier: {
      addSignal: () => {},
      cancelAllForSymbol: () => {},
      cancelAllForDirection: () => 0,
      cancelAll: () => 0,
      getPendingCount: () => 0,
      onVerified: () => {},
      destroy: () => {},
    },
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    monitorSymbolName: 'HSI.HK',
    normalizedMonitorSymbol: 'HSI.HK',
    rsiPeriods: [6],
    emaPeriods: [7],
    psyPeriods: [13],
    longQuote: createQuoteDouble('BULL.HK', 1.1, 100),
    shortQuote: createQuoteDouble('BEAR.HK', 0.9, 100),
    monitorQuote: createQuoteDouble('HSI.HK', 20_000, 1),
  } as unknown as MonitorContext;
}

describe('processMonitor end-to-end orchestration', () => {
  it('returns early when indicator pipeline cannot build snapshot', async () => {
    const processMonitor = await loadProcessMonitor();
    let strategyCalls = 0;
    const monitorContext = createMonitorContext({
      autoSearchEnabled: false,
      strategyGenerate: () => {
        strategyCalls += 1;
        return { immediateSignals: [], delayedSignals: [] };
      },
    });

    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue();

    const params: ProcessMonitorParams = {
      context: {
        marketDataClient: {
          getRealtimeCandlesticks: async () => [],
        },
        indicatorCache: createIndicatorCache(),
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        lastState: {
          positionCache: createPositionCacheDouble(),
        },
      } as never,
      monitorContext,
      runtimeFlags: {
        currentTime: new Date('2026-02-16T01:00:00.000Z'),
        isHalfDay: false,
        canTradeNow: true,
        openProtectionActive: false,
        isTradingEnabled: true,
      },
    };

    await processMonitor(params, new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_010)]]));

    expect(strategyCalls).toBe(0);
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });

  it('runs indicator+signal chain when candles are available and updates monitor price', async () => {
    const processMonitor = await loadProcessMonitor();
    let strategyCalls = 0;
    const monitorContext = createMonitorContext({
      autoSearchEnabled: false,
      strategyGenerate: () => {
        strategyCalls += 1;
        return { immediateSignals: [], delayedSignals: [] };
      },
    });

    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue();
    const candles = createCandles(60, 100, 0.2);

    const params: ProcessMonitorParams = {
      context: {
        marketDataClient: {
          getRealtimeCandlesticks: async () => candles,
        },
        indicatorCache: createIndicatorCache(),
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        lastState: {
          positionCache: createPositionCacheDouble(),
        },
      } as never,
      monitorContext,
      runtimeFlags: {
        currentTime: new Date('2026-02-16T01:00:01.000Z'),
        isHalfDay: false,
        canTradeNow: true,
        openProtectionActive: false,
        isTradingEnabled: true,
      },
    };

    await processMonitor(
      params,
      new Map([
        ['HSI.HK', createQuoteDouble('HSI.HK', 20_050)],
        ['BULL.HK', createQuoteDouble('BULL.HK', 1.1)],
        ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9)],
      ]),
    );

    expect(strategyCalls).toBe(1);
    expect(monitorContext.state.monitorPrice).toBe(20_050);
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });
});
