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
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { ProcessMonitorParams } from '../../../src/main/processMonitor/types.js';
import type { MarketDataClient } from '../../../src/types/services.js';
import type { IndicatorSnapshot, Quote } from '../../../src/types/quote.js';
import type { LastState, MonitorContext } from '../../../src/types/state.js';
import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createPositionCacheDouble,
  createQuoteDouble,
} from '../../helpers/testDoubles.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  createLastState,
  createMonitorContext as createMonitorContextFromAsync,
} from '../asyncProgram/utils.js';

type ProcessMonitorFn = (
  context: ProcessMonitorParams,
  quotesMap: ReadonlyMap<string, Quote | null>,
) => void;

async function loadProcessMonitor(): Promise<ProcessMonitorFn> {
  const modulePath = '../../../src/main/processMonitor/index.js?real-process-monitor';
  const module = await import(modulePath);
  return module.processMonitor as ProcessMonitorFn;
}

function createProcessMonitorParams(params: {
  readonly monitorContext: MonitorContext;
  readonly marketDataClient?: Partial<MarketDataClient>;
}): Readonly<{
  readonly params: ProcessMonitorParams;
  readonly buyTaskQueue: ReturnType<typeof createBuyTaskQueue>;
  readonly sellTaskQueue: ReturnType<typeof createSellTaskQueue>;
  readonly monitorTaskQueue: ReturnType<typeof createMonitorTaskQueue<MonitorTaskDataMap>>;
}> {
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
  const marketDataClient = createMarketDataClientDouble(params.marketDataClient);
  const lastState: LastState = createLastState({
    positionCache: createPositionCacheDouble(),
  });

  return {
    params: {
      context: {
        marketDataClient,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        lastState,
        tradingConfig: createTradingConfig({ monitors: [params.monitorContext.config] }),
      },
      monitorContext: params.monitorContext,
      runtimeFlags: {
        currentTime: new Date('2026-02-16T01:00:00.000Z'),
        isHalfDay: false,
        canTradeNow: true,
        openProtectionActive: false,
        isTradingEnabled: true,
      },
    },
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
  };
}

function createIndicatorSnapshot(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    price: 20_000,
    changePercent: 0,
    ema: { 7: 19_980 },
    rsi: { 6: 52 },
    psy: { 13: 58 },
    mfi: 45,
    kdj: { k: 51, d: 49, j: 55 },
    macd: { macd: 10, dif: 3, dea: 2 },
    adx: null,
    ...overrides,
  };
}

function createMonitorContext(params: {
  readonly autoSearchEnabled: boolean;
  readonly switchIntervalMinutes?: number;
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
        switchIntervalMinutes: params.switchIntervalMinutes ?? 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    }),
    state: {
      monitorSymbol: 'HSI.HK',
      signal: null,
      pendingDelayedSignals: [],
      lastMonitorSnapshot: null,
      incrementalIndicatorRuntime: null,
    },
  });
}

describe('processMonitor end-to-end orchestration', () => {
  it('does not enqueue buy/sell signals when only running auto-symbol and risk scheduling', async () => {
    const processMonitor = await loadProcessMonitor();
    const monitorContext = createMonitorContext({
      autoSearchEnabled: false,
    });

    const { params, buyTaskQueue, sellTaskQueue, monitorTaskQueue } = createProcessMonitorParams({
      monitorContext,
    });

    processMonitor(params, new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_010)]]));

    expect(monitorTaskQueue.isEmpty()).toBeTrue();
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });

  it('schedules periodic auto-symbol tasks and still keeps buy/sell queues untouched', async () => {
    const processMonitor = await loadProcessMonitor();
    const monitorContext = createMonitorContext({
      autoSearchEnabled: true,
      switchIntervalMinutes: 30,
    });

    const { params, buyTaskQueue, sellTaskQueue, monitorTaskQueue } = createProcessMonitorParams({
      monitorContext,
    });

    processMonitor(
      {
        ...params,
        runtimeFlags: {
          ...params.runtimeFlags,
          currentTime: new Date('2026-02-16T01:00:01.000Z'),
        },
      },
      new Map([
        ['HSI.HK', createQuoteDouble('HSI.HK', 20_050)],
        ['BULL.HK', createQuoteDouble('BULL.HK', 1.1)],
        ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9)],
      ]),
    );

    expect(monitorTaskQueue.pop()?.type).toBe('AUTO_SYMBOL_TICK');
    expect(monitorTaskQueue.pop()?.type).toBe('AUTO_SYMBOL_TICK');
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });

  it('does not read candlestick cache or trigger monitor rendering from processMonitor', async () => {
    const processMonitor = await loadProcessMonitor();
    const monitorContext = createMonitorContext({
      autoSearchEnabled: false,
    });
    monitorContext.state.lastMonitorSnapshot = createIndicatorSnapshot();

    const { params, buyTaskQueue, sellTaskQueue } = createProcessMonitorParams({
      monitorContext,
      marketDataClient: {
        getCandlestickSnapshot: () => {
          throw new Error('processMonitor should not read candlestick cache for display');
        },
      },
    });
    const monitorQuote = createQuoteDouble('HSI.HK', 20_010);

    processMonitor(params, new Map([['HSI.HK', monitorQuote]]));

    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });
});
