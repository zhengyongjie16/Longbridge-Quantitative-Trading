/**
 * indicatorPipeline 业务测试
 *
 * 功能：
 * - 验证缓存 version 复用与每秒 indicatorCache push 语义
 * - 验证缓存缺失时返回 null
 * - 验证 version 变化时能推进增量 runtime 并更新状态
 */
import { describe, expect, it } from 'bun:test';
import { Period } from 'longbridge';

import type { CandleData } from '../../../src/types/data.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { IndicatorPipelineParams } from '../../../src/main/processMonitor/types.js';
import type { MonitorIndicatorChangesParams } from '../../../src/services/marketMonitor/types.js';
import {
  createIndicatorUsageProfileDouble,
  createMonitorConfigDouble,
  createQuoteDouble,
} from '../../helpers/testDoubles.js';

function createCandles(length: number, start: number, step: number): ReadonlyArray<CandleData> {
  const candles: CandleData[] = [];
  const baseTimestamp = 1_708_000_000_000;
  for (let i = 0; i < length; i += 1) {
    const close = start + i * step;
    candles.push({
      open: close - 0.2,
      high: close + 0.3,
      low: close - 0.4,
      close,
      volume: 1_000 + i,
      timestamp: baseTimestamp + i * 60_000,
    });
  }

  return candles;
}

function createSnapshot(price: number): IndicatorSnapshot {
  return {
    price,
    changePercent: 0,
    ema: { 7: price - 1 },
    rsi: { 6: 55 },
    psy: { 13: 52 },
    mfi: 48,
    kdj: { k: 50, d: 49, j: 52 },
    macd: { macd: 1, dif: 0.5, dea: 0.4 },
    adx: null,
  };
}

function createCacheSnapshot(params: {
  readonly symbol?: string;
  readonly candles: ReadonlyArray<CandleData>;
  readonly version: number;
  readonly initialized?: boolean;
  readonly lastBarConfirmed?: boolean | null;
}) {
  const symbol = params.symbol ?? 'HSI.HK';
  const latest = params.candles.at(-1);
  const timestamp =
    latest && typeof latest.timestamp === 'number' && Number.isFinite(latest.timestamp)
      ? latest.timestamp
      : null;
  return {
    symbol,
    period: Period.Min_1,
    version: params.version,
    candles: params.candles,
    lastBarTimestamp: timestamp,
    lastBarConfirmed: params.lastBarConfirmed ?? false,
    initialized: params.initialized ?? true,
  };
}

function createMonitorContext(overrides: Partial<MonitorContext> = {}): MonitorContext {
  const config = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
  return {
    config,
    state: {
      monitorSymbol: config.monitorSymbol,
      monitorPrice: null,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingDelayedSignals: [],
      monitorValues: null,
      lastMonitorSnapshot: null,
      lastCandlestickCacheVersion: null,
      incrementalIndicatorRuntime: null,
    },
    monitorSymbolName: config.monitorSymbol,
    indicatorProfile: createIndicatorUsageProfileDouble(),
    ...overrides,
  } as unknown as MonitorContext;
}

type RunIndicatorPipelineFn = (
  params: IndicatorPipelineParams,
) => Promise<IndicatorSnapshot | null>;

async function loadRunIndicatorPipeline(): Promise<RunIndicatorPipelineFn> {
  const modulePath =
    '../../../src/main/processMonitor/indicatorPipeline.js?real-indicator-pipeline-v2';
  const module = await import(modulePath);
  return module.runIndicatorPipeline as RunIndicatorPipelineFn;
}

describe('processMonitor indicatorPipeline business flow', () => {
  it('returns null when local candlestick cache is missing or not initialized', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    let cachePushCount = 0;
    let monitorChangesCount = 0;

    const monitorContext = createMonitorContext();
    const result = await runIndicatorPipeline({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      monitorQuote: createQuoteDouble('HSI.HK', 20_000),
      mainContext: {
        marketDataClient: {
          getCandlestickSnapshot: () => null,
        },
        indicatorCache: {
          push: () => {
            cachePushCount += 1;
          },
          getAt: () => null,
          clearAll: () => {},
        },
        marketMonitor: {
          monitorIndicatorChanges: () => {
            monitorChangesCount += 1;
            return false;
          },
        },
      } as never,
    });

    expect(result).toBeNull();
    expect(cachePushCount).toBe(0);
    expect(monitorChangesCount).toBe(0);
  });

  it('reuses last snapshot when cache version is unchanged and still pushes indicatorCache', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    const lastSnapshot = createSnapshot(111);
    const cacheSnapshot = createCacheSnapshot({
      candles: createCandles(60, 100, 0.2),
      version: 7,
    });

    const monitorContext = createMonitorContext({
      state: {
        monitorSymbol: 'HSI.HK',
        monitorPrice: null,
        longPrice: null,
        shortPrice: null,
        signal: null,
        pendingDelayedSignals: [],
        monitorValues: null,
        lastMonitorSnapshot: lastSnapshot,
        lastCandlestickCacheVersion: 7,
        incrementalIndicatorRuntime: null,
      },
    });

    const pushed: IndicatorSnapshot[] = [];
    const monitorChanges: IndicatorSnapshot[] = [];
    const result = await runIndicatorPipeline({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      monitorQuote: createQuoteDouble('HSI.HK', 20_000),
      mainContext: {
        marketDataClient: {
          getCandlestickSnapshot: () => cacheSnapshot,
        },
        indicatorCache: {
          push: (_symbol: string, snapshot: IndicatorSnapshot) => {
            pushed.push(snapshot);
          },
          getAt: () => null,
          clearAll: () => {},
        },
        marketMonitor: {
          monitorIndicatorChanges: (params: MonitorIndicatorChangesParams) => {
            const monitorSnapshot = params.monitorSnapshot;
            if (monitorSnapshot === null) {
              throw new Error('expected indicator snapshot');
            }

            monitorChanges.push(monitorSnapshot);
            return false;
          },
        },
      } as never,
    });

    expect(result).toBe(lastSnapshot);
    expect(pushed).toEqual([lastSnapshot]);
    expect(monitorChanges).toEqual([lastSnapshot]);
  });

  it('rebuilds snapshot from incremental runtime when cache version changes', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    const cacheSnapshot = createCacheSnapshot({
      candles: createCandles(80, 120, 0.3),
      version: 11,
    });
    const monitorContext = createMonitorContext();

    const pushed: IndicatorSnapshot[] = [];
    let monitorChangesCount = 0;
    const result = await runIndicatorPipeline({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      monitorQuote: createQuoteDouble('HSI.HK', 20_100),
      mainContext: {
        marketDataClient: {
          getCandlestickSnapshot: () => cacheSnapshot,
        },
        indicatorCache: {
          push: (_symbol: string, snapshot: IndicatorSnapshot) => {
            pushed.push(snapshot);
          },
          getAt: () => null,
          clearAll: () => {},
        },
        marketMonitor: {
          monitorIndicatorChanges: () => {
            monitorChangesCount += 1;
            return true;
          },
        },
      } as never,
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('expected indicator snapshot');
    }

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toBe(result);
    expect(monitorContext.state.lastMonitorSnapshot).toBe(result);
    expect(monitorContext.state.lastCandlestickCacheVersion).toBe(11);
    expect(monitorContext.state.incrementalIndicatorRuntime).not.toBeNull();
    expect(monitorChangesCount).toBe(1);
  });
});
