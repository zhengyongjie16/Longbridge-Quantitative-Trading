/**
 * @module tests/main/processMonitor/indicatorPipeline.business.test.ts
 * @description 测试模块，围绕 indicatorPipeline.business.test.ts 场景验证 tests/main/processMonitor 相关业务行为与边界条件。
 */
import { describe, expect, it } from 'bun:test';

import { getCandleFingerprint } from '../../../src/services/indicators/utils.js';
import type { CandleData } from '../../../src/types/data.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { IndicatorPipelineParams } from '../../../src/main/processMonitor/types.js';
import { createMonitorConfigDouble, createQuoteDouble } from '../../helpers/testDoubles.js';

function createCandles(length: number, start: number, step: number): ReadonlyArray<CandleData> {
  const candles: CandleData[] = [];
  for (let i = 0; i < length; i += 1) {
    const close = start + i * step;
    candles.push({
      open: close - 0.2,
      high: close + 0.3,
      low: close - 0.4,
      close,
      volume: 1_000 + i,
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
      lastCandleFingerprint: null,
    },
    monitorSymbolName: config.monitorSymbol,
    rsiPeriods: [6],
    emaPeriods: [7],
    psyPeriods: [13],
    ...overrides,
  } as unknown as MonitorContext;
}

type RunIndicatorPipelineFn = (
  params: IndicatorPipelineParams,
) => Promise<IndicatorSnapshot | null>;

async function loadRunIndicatorPipeline(): Promise<RunIndicatorPipelineFn> {
  const modulePath = '../../../src/main/processMonitor/indicatorPipeline.js?real-indicator-pipeline';
  const module = await import(modulePath);
  return module.runIndicatorPipeline as RunIndicatorPipelineFn;
}

describe('processMonitor indicatorPipeline business flow', () => {
  it('returns null when realtime candlesticks are unavailable', async () => {
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
          getRealtimeCandlesticks: async () => [],
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

  it('reuses last snapshot when candle fingerprint has not changed', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    const candles = createCandles(60, 100, 0.2);
    const fingerprint = getCandleFingerprint(candles);
    const lastSnapshot = createSnapshot(111);

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
        lastCandleFingerprint: fingerprint,
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
          getRealtimeCandlesticks: async () => candles,
        },
        indicatorCache: {
          push: (_symbol: string, snapshot: IndicatorSnapshot) => {
            pushed.push(snapshot);
          },
          getAt: () => null,
          clearAll: () => {},
        },
        marketMonitor: {
          monitorIndicatorChanges: (snapshot: IndicatorSnapshot) => {
            monitorChanges.push(snapshot);
            return false;
          },
        },
      } as never,
    });

    expect(result).toBe(lastSnapshot);
    expect(pushed).toEqual([lastSnapshot]);
    expect(monitorChanges).toEqual([lastSnapshot]);
  });

  it('builds fresh snapshot, pushes cache and updates state on new candle data', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    const candles = createCandles(80, 120, 0.3);
    const monitorContext = createMonitorContext({
      state: {
        monitorSymbol: 'HSI.HK',
        monitorPrice: null,
        longPrice: null,
        shortPrice: null,
        signal: null,
        pendingDelayedSignals: [],
        monitorValues: null,
        lastMonitorSnapshot: createSnapshot(100),
        lastCandleFingerprint: 'old_fp',
      },
    });

    const pushed: IndicatorSnapshot[] = [];
    let monitorChangesCount = 0;

    const result = await runIndicatorPipeline({
      monitorSymbol: 'HSI.HK',
      monitorContext,
      monitorQuote: createQuoteDouble('HSI.HK', 20_100),
      mainContext: {
        marketDataClient: {
          getRealtimeCandlesticks: async () => candles,
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
    expect(monitorContext.state.lastCandleFingerprint).toBe(getCandleFingerprint(candles));
    expect(monitorChangesCount).toBe(1);
  });
});
