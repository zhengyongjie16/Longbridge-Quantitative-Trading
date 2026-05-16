/**
 * dailyIndicatorAnalysis 工具业务测试
 *
 * 功能：
 * - 验证日内分析工具按当前分钟 high/low 变体计算低滞后 ER10 指标。
 */
import { describe, expect, it } from 'bun:test';
import { TradeSession, type Candlestick } from 'longbridge';

import { toMockDecimal } from '../../../mock/longbridge/decimal.js';
import { calculateEfficiencyRatio } from '../../../tools/dailyIndicatorAnalysis/indicatorCalculators.js';
import { computeMinuteRows } from '../../../tools/dailyIndicatorAnalysis/utils.js';
import type { CandleData } from '../../../src/types/data.js';
import type { ComputeMinuteRowsOptions } from '../../../tools/dailyIndicatorAnalysis/types.js';

const COMPUTE_OPTIONS: ComputeMinuteRowsOptions = {
  rsiPeriod: 6,
  kdjPeriod: 9,
  mfiPeriod: 14,
  adxPeriod: 14,
  ema5Period: 5,
  er10Period: 10,
  vpVaPercent: 0.7,
  vpBins: 20,
};

function createCandle(close: number): CandleData {
  return {
    open: close,
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume: 1_000,
  };
}

function createCandlestick(params: {
  readonly timestamp: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}): Candlestick {
  return {
    close: toMockDecimal(params.close),
    open: toMockDecimal(params.open),
    low: toMockDecimal(params.low),
    high: toMockDecimal(params.high),
    volume: params.volume,
    turnover: toMockDecimal(0),
    timestamp: params.timestamp,
    tradeSession: TradeSession.Intraday,
    toString: () => JSON.stringify(params),
    toJSON: () => params,
  };
}

describe('dailyIndicatorAnalysis utils business flow', () => {
  it('computes Kaufman ER10 from net close movement divided by path movement', () => {
    const closes = [100, 101, 100.5, 102, 101.5, 103, 102, 104, 103.5, 105, 104];
    const candles = closes.map(createCandle);

    const result = calculateEfficiencyRatio(candles, 10);

    expect(result).toBeCloseTo(4 / 11, 8);
  });

  it('projects ER10 into high and low daily indicator rows', () => {
    const baseTime = Date.UTC(2026, 4, 14, 1, 30);
    const candles: Candlestick[] = [];
    for (let index = 0; index < 10; index += 1) {
      const close = 100 + index;
      candles.push(
        createCandlestick({
          timestamp: new Date(baseTime + index * 60_000),
          open: close - 0.2,
          high: close + 0.4,
          low: close - 0.4,
          close,
          volume: 1_000 + index,
        }),
      );
    }

    candles.push(
      createCandlestick({
        timestamp: new Date(baseTime + 10 * 60_000),
        open: 109.8,
        high: 110.6,
        low: 108.2,
        close: 110,
        volume: 2_000,
      }),
    );

    const result = computeMinuteRows(candles, COMPUTE_OPTIONS);

    const lastHighRow = result.rows.at(-2);
    const lastLowRow = result.rows.at(-1);
    expect(lastHighRow?.er10).toBe(1);
    expect(lastLowRow?.er10).toBeCloseTo(8.2 / 9.8, 8);
  });
});
