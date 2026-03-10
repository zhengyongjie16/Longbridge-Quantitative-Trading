/**
 * indicators/runtime 业务测试
 *
 * 功能：
 * - 验证指标运行时计算相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { calculateADX } from '../../../../src/services/indicators/runtime/adx.js';
import { calculateEMA } from '../../../../src/services/indicators/runtime/ema.js';
import { calculateKDJ } from '../../../../src/services/indicators/runtime/kdj.js';
import { calculateMACD } from '../../../../src/services/indicators/runtime/macd.js';
import { calculateMFI } from '../../../../src/services/indicators/runtime/mfi.js';
import { calculatePSY } from '../../../../src/services/indicators/runtime/psy.js';
import { calculateRSI } from '../../../../src/services/indicators/runtime/rsi.js';
import {
  buildIndicatorSnapshot,
  getCandleFingerprint,
} from '../../../../src/services/indicators/runtime/index.js';
import { toNumber } from '../../../../src/services/indicators/runtime/utils.js';
import { toMockDecimal } from '../../../../mock/longport/decimal.js';
import type { CandleData } from '../../../../src/types/data.js';
import { createIndicatorUsageProfileDouble } from '../../../helpers/testDoubles.js';

function createTrendCandles(
  length: number,
  startClose: number,
  step: number,
): ReadonlyArray<CandleData> {
  const candles: CandleData[] = [];
  for (let index = 0; index < length; index += 1) {
    const close = startClose + index * step;
    candles.push({
      open: close - 0.2,
      high: close + 0.4,
      low: close - 0.6,
      close,
      volume: 10_000 + index * 10,
    });
  }

  return candles;
}

describe('indicators/runtime business flow', () => {
  it('builds a full indicator snapshot for signal engine with configured periods', () => {
    const candles = createTrendCandles(80, 100, 0.5);
    const indicatorProfile = createIndicatorUsageProfileDouble({
      requiredFamilies: {
        mfi: true,
        kdj: true,
        macd: true,
        adx: true,
      },
      requiredPeriods: {
        rsi: [6, 14, 0, 101],
        ema: [5, 20, 251],
        psy: [13, 0, 101],
      },
    });
    const snapshot = buildIndicatorSnapshot('HSI.HK', candles, indicatorProfile);

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
    expect(buildIndicatorSnapshot('HSI.HK', [], createIndicatorUsageProfileDouble())).toBeNull();
    expect(
      buildIndicatorSnapshot(
        'HSI.HK',
        [
          { close: 0, high: 1, low: 1, volume: 1 },
          { close: null, high: 1, low: 1, volume: 1 },
        ],
        createIndicatorUsageProfileDouble({
          requiredFamilies: {
            mfi: false,
            kdj: false,
            macd: false,
            adx: false,
          },
          requiredPeriods: {
            rsi: [],
            ema: [],
            psy: [],
          },
          displayPlan: ['price', 'changePercent'],
        }),
      ),
    ).toBeNull();
  });

  it('keeps psy as null when configured periods are all invalid', () => {
    const candles = createTrendCandles(40, 90, 0.2);
    const snapshot = buildIndicatorSnapshot(
      'HSI.HK',
      candles,
      createIndicatorUsageProfileDouble({
        requiredPeriods: {
          rsi: [6],
          ema: [5],
          psy: [0, 101],
        },
      }),
    );

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
    const shortCandles = createTrendCandles(3, 1, 1);
    expect(calculateRSI(shortCandles, 6)).toBeNull();
    expect(calculateEMA(shortCandles, 251)).toBeNull();
    expect(calculatePSY(shortCandles, 0)).toBeNull();
    expect(calculateKDJ(createTrendCandles(3, 10, 1), 9)).toBeNull();
    expect(calculateMACD(createTrendCandles(4, 1, 1), 12, 26, 9)).toBeNull();
    expect(calculateMFI([{ high: 1, low: 1, close: 1, volume: 1 }], 14)).toBeNull();
  });

  it('computes ADX as finite number when sufficient candles are provided', () => {
    const candles = createTrendCandles(60, 100, 0.5);
    const adx = calculateADX(candles, 14);

    expect(adx).not.toBeNull();
    expect(adx).toBeFinite();
    if (adx !== null) {
      expect(adx).toBeGreaterThanOrEqual(0);
      expect(adx).toBeLessThanOrEqual(100);
    }
  });

  it('returns null for ADX when candles are insufficient', () => {
    const shortCandles = createTrendCandles(20, 100, 1);
    expect(calculateADX(shortCandles, 14)).toBeNull();
    expect(calculateADX([], 14)).toBeNull();
  });

  it('includes ADX in full indicator snapshot', () => {
    const candles = createTrendCandles(80, 100, 0.5);
    const snapshot = buildIndicatorSnapshot('HSI.HK', candles, createIndicatorUsageProfileDouble());

    expect(snapshot).not.toBeNull();
    expect(snapshot?.adx).toBeFinite();
  });

  it('keeps zero-value MACD as valid output on flat closes', () => {
    const candles = createTrendCandles(60, 100, 0);
    const macd = calculateMACD(candles);

    expect(macd).not.toBeNull();
    expect(macd?.dif).toBeCloseTo(0, 10);
    expect(macd?.dea).toBeCloseTo(0, 10);
    expect(macd?.macd).toBeCloseTo(0, 10);
  });
});
