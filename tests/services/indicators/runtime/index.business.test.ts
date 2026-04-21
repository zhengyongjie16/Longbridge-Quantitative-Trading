/**
 * indicators/runtime 业务测试
 *
 * 功能：
 * - 验证指标运行时计算相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import {
  calculateEMA,
  calculateKDJ,
  calculateMFI,
  calculateRSI,
} from '../../../../tools/dailyIndicatorAnalysis/indicatorCalculators.js';
import { buildIndicatorSnapshot } from '../../../../tools/dailyKlineMonitor/runtimeSnapshot.js';
import { toNumber } from '../../../../src/services/indicators/runtime/utils.js';
import { toMockDecimal } from '../../../../mock/longbridge/decimal.js';
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

  it('supports number conversion used by runtime helpers', () => {
    expect(toNumber(1.2)).toBe(1.2);
    expect(toNumber('2.3')).toBe(2.3);
    expect(toNumber(toMockDecimal(3.4))).toBe(3.4);
    expect(toNumber(null)).toBe(0);
  });

  it('enforces guard rails for tool-owned full indicator calculators', () => {
    const shortCandles = createTrendCandles(3, 1, 1);
    expect(calculateRSI(shortCandles, 6)).toBeNull();
    expect(calculateEMA(shortCandles, 251)).toBeNull();
    expect(calculateKDJ(createTrendCandles(3, 10, 1), 9)).toBeNull();
    expect(calculateMFI([{ high: 1, low: 1, close: 1, volume: 1 }], 14)).toBeNull();
  });

  it('includes ADX in full indicator snapshot', () => {
    const candles = createTrendCandles(80, 100, 0.5);
    const snapshot = buildIndicatorSnapshot('HSI.HK', candles, createIndicatorUsageProfileDouble());

    expect(snapshot).not.toBeNull();
    expect(snapshot?.adx).toBeFinite();
  });

  it('computes KDJ with TradingView-style rolling SMA 9,3,3', () => {
    const candles: ReadonlyArray<CandleData> = [
      { high: 11, low: 9, close: 10, volume: 1000 },
      { high: 12, low: 9.5, close: 11, volume: 1000 },
      { high: 13, low: 10, close: 12, volume: 1000 },
      { high: 14, low: 10.5, close: 13, volume: 1000 },
      { high: 15, low: 11, close: 14, volume: 1000 },
      { high: 16, low: 11.5, close: 15, volume: 1000 },
      { high: 17, low: 12, close: 16, volume: 1000 },
      { high: 18, low: 12.5, close: 17, volume: 1000 },
      { high: 19, low: 13, close: 18, volume: 1000 },
      { high: 20, low: 13.5, close: 19, volume: 1000 },
      { high: 21, low: 14, close: 20, volume: 1000 },
      { high: 22, low: 14.5, close: 21, volume: 1000 },
      { high: 23, low: 15, close: 22, volume: 1000 },
    ];
    const profile = createIndicatorUsageProfileDouble({
      requiredFamilies: {
        mfi: false,
        kdj: true,
        macd: false,
        adx: false,
      },
      requiredPeriods: {
        rsi: [],
        ema: [],
        psy: [],
      },
      displayPlan: ['price', 'changePercent', 'K', 'D', 'J'],
    });

    const snapshot = buildIndicatorSnapshot('HSI.HK', candles, profile);
    const calculated = calculateKDJ(candles, 9);

    expect(snapshot?.kdj).toEqual({
      k: 91.293,
      d: 90.884,
      j: 92.112,
    });

    expect(calculated).toEqual({
      k: 91.293,
      d: 90.884,
      j: 92.112,
    });
  });

  it('rounds all indicator outputs to three decimals in runtime', () => {
    const candles: ReadonlyArray<CandleData> = [
      { open: 100.1, high: 100.8, low: 99.7, close: 100.23, volume: 1000 },
      { open: 100.25, high: 101.04, low: 99.94, close: 100.67, volume: 1137 },
      { open: 100.6, high: 101.33, low: 100.12, close: 101.11, volume: 1261 },
      { open: 101.03, high: 101.68, low: 100.51, close: 100.88, volume: 1199 },
      { open: 100.9, high: 101.52, low: 100.22, close: 101.42, volume: 1411 },
      { open: 101.37, high: 102.05, low: 100.9, close: 101.76, volume: 1355 },
      { open: 101.7, high: 102.31, low: 101.02, close: 101.58, volume: 1522 },
      { open: 101.61, high: 102.42, low: 101.11, close: 102.07, volume: 1603 },
      { open: 102, high: 102.76, low: 101.47, close: 102.44, volume: 1497 },
      { open: 102.37, high: 103.01, low: 101.8, close: 102.18, volume: 1702 },
      { open: 102.2, high: 102.91, low: 101.64, close: 102.69, volume: 1658 },
      { open: 102.64, high: 103.36, low: 102.02, close: 103.08, volume: 1804 },
      { open: 103, high: 103.71, low: 102.33, close: 102.85, volume: 1729 },
      { open: 102.9, high: 103.55, low: 102.2, close: 103.31, volume: 1886 },
      { open: 103.27, high: 104.02, low: 102.73, close: 103.79, volume: 1944 },
      { open: 103.74, high: 104.38, low: 103.08, close: 103.51, volume: 1863 },
      { open: 103.56, high: 104.21, low: 102.91, close: 103.94, volume: 2017 },
      { open: 103.9, high: 104.63, low: 103.29, close: 104.27, volume: 2099 },
      { open: 104.22, high: 104.95, low: 103.56, close: 104.05, volume: 1988 },
      { open: 104.1, high: 104.82, low: 103.47, close: 104.49, volume: 2140 },
      { open: 104.45, high: 105.18, low: 103.83, close: 104.88, volume: 2201 },
      { open: 104.8, high: 105.42, low: 104.11, close: 104.63, volume: 2115 },
      { open: 104.67, high: 105.36, low: 103.99, close: 105.07, volume: 2259 },
      { open: 105, high: 105.73, low: 104.33, close: 105.44, volume: 2312 },
      { open: 105.38, high: 106.06, low: 104.77, close: 105.2, volume: 2196 },
      { open: 105.24, high: 105.91, low: 104.58, close: 105.66, volume: 2366 },
      { open: 105.61, high: 106.34, low: 104.97, close: 106.03, volume: 2421 },
      { open: 105.98, high: 106.62, low: 105.28, close: 105.78, volume: 2337 },
      { open: 105.82, high: 106.48, low: 105.1, close: 106.21, volume: 2489 },
      { open: 106.17, high: 106.91, low: 105.54, close: 106.57, volume: 2530 },
      { open: 106.5, high: 107.19, low: 105.85, close: 106.34, volume: 2448 },
      { open: 106.39, high: 107.07, low: 105.69, close: 106.82, volume: 2611 },
      { open: 106.77, high: 107.51, low: 106.14, close: 107.16, volume: 2667 },
      { open: 107.11, high: 107.76, low: 106.39, close: 106.93, volume: 2578 },
      { open: 106.98, high: 107.66, low: 106.26, close: 107.39, volume: 2730 },
      { open: 107.35, high: 108.08, low: 106.71, close: 107.73, volume: 2793 },
      { open: 107.7, high: 108.41, low: 107.03, close: 107.48, volume: 2675 },
      { open: 107.53, high: 108.2, low: 106.82, close: 107.95, volume: 2838 },
      { open: 107.9, high: 108.65, low: 107.28, close: 108.31, volume: 2899 },
      { open: 108.28, high: 108.95, low: 107.57, close: 108.09, volume: 2788 },
    ];

    const snapshot = buildIndicatorSnapshot(
      'HSI.HK',
      candles,
      createIndicatorUsageProfileDouble({
        requiredFamilies: {
          mfi: true,
          kdj: true,
          macd: true,
          adx: true,
        },
        requiredPeriods: {
          ema: [5],
          rsi: [6],
          psy: [13],
        },
      }),
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.ema?.[5]).toBe(Number(snapshot?.ema?.[5]?.toFixed(3)));
    expect(snapshot?.rsi?.[6]).toBe(Number(snapshot?.rsi?.[6]?.toFixed(3)));
    expect(snapshot?.psy?.[13]).toBe(Number(snapshot?.psy?.[13]?.toFixed(3)));
    expect(snapshot?.mfi).toBe(Number(snapshot?.mfi?.toFixed(3)));
    expect(snapshot?.adx).toBe(Number(snapshot?.adx?.toFixed(3)));
    expect(snapshot?.kdj?.k).toBe(Number(snapshot?.kdj?.k.toFixed(3)));
    expect(snapshot?.kdj?.d).toBe(Number(snapshot?.kdj?.d.toFixed(3)));
    expect(snapshot?.kdj?.j).toBe(Number(snapshot?.kdj?.j.toFixed(3)));
    expect(snapshot?.macd?.dif).toBe(Number(snapshot?.macd?.dif.toFixed(3)));
    expect(snapshot?.macd?.dea).toBe(Number(snapshot?.macd?.dea.toFixed(3)));
    expect(snapshot?.macd?.macd).toBe(Number(snapshot?.macd?.macd.toFixed(3)));
  });
});
