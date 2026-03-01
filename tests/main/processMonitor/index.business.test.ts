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
  createPositionCacheDouble,
  createQuoteDouble,
} from '../../helpers/testDoubles.js';
import { createMonitorContext as createMonitorContextFromAsync } from '../asyncProgram/utils.js';

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
  return createMonitorContextFromAsync({
    config: createMonitorConfigDouble({
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
    }),
    state: {
      monitorSymbol: 'HSI.HK',
      monitorPrice: 20_000,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingDelayedSignals: [],
      monitorValues: null,
      lastMonitorSnapshot: null,
      lastCandleFingerprint: null,
    },
    strategy: {
      generateCloseSignals: params.strategyGenerate,
    },
  });
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
