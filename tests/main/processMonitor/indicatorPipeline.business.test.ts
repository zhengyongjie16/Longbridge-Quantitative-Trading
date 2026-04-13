/**
 * indicatorPipeline 业务测试
 *
 * 功能：
 * - 验证缓存缺失时返回 null
 * - 验证事件到达时能推进增量 runtime 并更新状态
 * - 验证重复调用会基于已存在 runtime 继续推进，而不再依赖主循环缓存版本短路
 */
import { describe, expect, it } from 'bun:test';
import { Period } from 'longbridge';

import type { CandleData } from '../../../src/types/data.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { IndicatorPipelineParams } from '../../../src/main/businessEventProgram/types.js';
import {
  createIndicatorUsageProfileDouble,
  createMonitorConfigDouble,
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
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingDelayedSignals: [],
      monitorValues: null,
      lastMonitorSnapshot: null,
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
    '../../../src/main/businessEventProgram/indicatorPipeline.js?real-indicator-pipeline-v2';
  const module = await import(modulePath);
  return module.runIndicatorPipeline as RunIndicatorPipelineFn;
}

describe('processMonitor indicatorPipeline business flow', () => {
  it('returns null when local candlestick cache is missing or not initialized', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();

    const monitorContext = createMonitorContext();
    const result = await runIndicatorPipeline({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      mainContext: {
        marketDataClient: {
          getCandlestickSnapshot: () => null,
        },
      } as never,
    });

    expect(result).toBeNull();
  });

  it('advances from existing incremental runtime on repeated calls', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    const cacheSnapshot = createCacheSnapshot({
      candles: createCandles(60, 100, 0.2),
      version: 7,
    });
    const previousSnapshot = createSnapshot(111);

    const monitorContext = createMonitorContext({
      state: {
        monitorSymbol: 'HSI.HK',
        longPrice: null,
        shortPrice: null,
        signal: null,
        pendingDelayedSignals: [],
        monitorValues: null,
        lastMonitorSnapshot: previousSnapshot,
        incrementalIndicatorRuntime: null,
      },
    });

    const result = await runIndicatorPipeline({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      mainContext: {
        marketDataClient: {
          getCandlestickSnapshot: () => cacheSnapshot,
        },
      } as never,
    });

    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error('expected indicator snapshot');
    }

    expect(result).not.toBe(previousSnapshot);
  });

  it('rebuilds snapshot from candlestick cache and更新 state', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    const cacheSnapshot = createCacheSnapshot({
      candles: createCandles(80, 120, 0.3),
      version: 11,
    });
    const monitorContext = createMonitorContext();

    const result = await runIndicatorPipeline({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      mainContext: {
        marketDataClient: {
          getCandlestickSnapshot: () => cacheSnapshot,
        },
      } as never,
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('expected indicator snapshot');
    }

    expect(monitorContext.state.lastMonitorSnapshot).toBe(result);
    expect(monitorContext.state.incrementalIndicatorRuntime).not.toBeNull();
  });
});
