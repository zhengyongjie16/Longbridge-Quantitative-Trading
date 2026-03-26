/**
 * strategy utils 业务测试
 *
 * 功能：
 * - 验证指标展示字符串的输出顺序、格式和空值过滤语义
 */
import { describe, expect, it } from 'bun:test';

import { buildIndicatorDisplayString } from '../../../src/core/strategy/utils.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';

function createSnapshot(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    price: 1,
    changePercent: null,
    ema: null,
    rsi: { 14: 61.2345, 6: 52.3456 },
    psy: { 24: 40.6789, 12: 55.4321 },
    mfi: 48.8888,
    kdj: { k: 70.1234, d: 60.5678, j: 89.9999 },
    macd: null,
    adx: 22.2222,
    ...overrides,
  };
}

describe('strategy utils display semantics', () => {
  it('formats RSI and PSY in ascending period order with fixed output sequence', () => {
    const text = buildIndicatorDisplayString(createSnapshot());
    expect(text).toBe(
      'RSI6(52.346)、RSI14(61.234)、MFI(48.889)、PSY12(55.432)、PSY24(40.679)、KDJ(K=70.123,D=60.568,J=90.000)、ADX(22.222)',
    );
  });

  it('filters invalid values and omits empty indicator segments', () => {
    const text = buildIndicatorDisplayString(
      createSnapshot({
        rsi: { 6: Number.NaN, 14: 61.2345 },
        psy: { 12: Number.POSITIVE_INFINITY, 24: 40.6789 },
        mfi: null,
        kdj: { k: Number.NaN, d: 60.5678, j: Number.NaN },
        adx: null,
      }),
    );

    expect(text).toBe('RSI14(61.234)、PSY24(40.679)、KDJ(D=60.568)');
  });

  it('returns empty string when all displayable indicators are absent', () => {
    const text = buildIndicatorDisplayString({
      price: 1,
      changePercent: null,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: null,
      macd: null,
      adx: null,
    });

    expect(text).toBe('');
  });
});
