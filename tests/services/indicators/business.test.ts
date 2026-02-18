/**
 * indicators 业务测试
 *
 * 功能：
 * - 围绕 business.test.ts 场景验证 tests/services/indicators 相关业务行为与边界条件。
 */
import { describe, expect, it } from 'bun:test';

import { buildIndicatorSnapshot } from '../../../src/services/indicators/index.js';
import { calculateEMA } from '../../../src/services/indicators/ema.js';
import { calculateKDJ } from '../../../src/services/indicators/kdj.js';
import { calculateMACD } from '../../../src/services/indicators/macd.js';
import { calculateMFI } from '../../../src/services/indicators/mfi.js';
import { calculatePSY } from '../../../src/services/indicators/psy.js';
import { calculateRSI } from '../../../src/services/indicators/rsi.js';
import { getCandleFingerprint, toNumber } from '../../../src/services/indicators/utils.js';
import { toMockDecimal } from '../../../mock/longport/decimal.js';
import type { CandleData } from '../../../src/types/data.js';

function createTrendCandles(
  length: number,
  startClose: number,
  step: number,
): ReadonlyArray<CandleData> {
  const candles: CandleData[] = [];
  for (let i = 0; i < length; i += 1) {
    const close = startClose + i * step;
    candles.push({
      open: close - 0.2,
      high: close + 0.4,
      low: close - 0.6,
      close,
      volume: 10_000 + i * 10,
    });
  }
  return candles;
}

describe('indicators business flow', () => {
  it('builds a full indicator snapshot for signal engine with configured periods', () => {
    const candles = createTrendCandles(80, 100, 0.5);
    const snapshot = buildIndicatorSnapshot(
      'HSI.HK',
      candles,
      [6, 14, 0, 101],
      [5, 20, 251],
      [13, 0, 101],
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.symbol).toBe('HSI.HK');
    expect(snapshot?.price).toBe(139.5);
    expect(snapshot?.changePercent).toBeCloseTo((0.5 / 139) * 100, 8);

    expect(snapshot?.rsi?.[6]).toBeFinite();
    expect(snapshot?.rsi?.[14]).toBeFinite();
    expect(snapshot?.rsi?.[0]).toBeUndefined();
    expect(snapshot?.rsi?.[101]).toBeUndefined();

    expect(snapshot?.ema?.[5]).toBeFinite();
    expect(snapshot?.ema?.[20]).toBeFinite();
    expect(snapshot?.ema?.[251]).toBeUndefined();

    expect(snapshot?.psy?.[13]).toBeFinite();
    expect(snapshot?.mfi).toBeFinite();
    expect(snapshot?.kdj).not.toBeNull();
    expect(snapshot?.macd).not.toBeNull();
  });

  it('returns null when candles are empty or no valid close exists', () => {
    expect(buildIndicatorSnapshot('HSI.HK', [])).toBeNull();
    expect(
      buildIndicatorSnapshot('HSI.HK', [
        { close: 0, high: 1, low: 1, volume: 1 },
        { close: null, high: 1, low: 1, volume: 1 },
      ]),
    ).toBeNull();
  });

  it('keeps psy as null when configured periods are all invalid', () => {
    const candles = createTrendCandles(40, 90, 0.2);
    const snapshot = buildIndicatorSnapshot('HSI.HK', candles, [6], [5], [0, 101]);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.psy).toBeNull();
  });

  it('supports number conversion and candle fingerprint checks used by pipeline cache', () => {
    expect(toNumber(1.2)).toBe(1.2);
    expect(toNumber('2.3')).toBe(2.3);
    expect(toNumber(toMockDecimal(3.4))).toBe(3.4);
    expect(toNumber(null)).toBe(0);

    const candles = createTrendCandles(3, 10, 1);
    expect(getCandleFingerprint(candles)).toBe('3_12');
    expect(getCandleFingerprint([{ close: 0 }])).toBeNull();
  });

  it('enforces guard rails for individual indicators on invalid inputs', () => {
    expect(calculateRSI([1, 2, 3], 6)).toBeNull();
    expect(calculateEMA([1, 2, 3], 251)).toBeNull();
    expect(calculatePSY([1, 2, 3], 0)).toBeNull();
    expect(calculateKDJ(createTrendCandles(3, 10, 1), 9)).toBeNull();
    expect(calculateMACD([1, 2, 3, 4], 12, 26, 9)).toBeNull();
    expect(calculateMFI([{ high: 1, low: 1, close: 1, volume: 1 }], 14)).toBeNull();
  });
});
