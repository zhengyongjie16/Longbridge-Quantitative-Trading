/**
 * indicatorHelpers 业务测试
 *
 * 功能：
 * - 验证指标周期解析的合法/非法输入语义
 * - 验证指标值提取对固定指标、周期指标和非法指标的行为
 */
import { describe, expect, it } from 'bun:test';

import { getIndicatorValue, parseIndicatorPeriod } from '../../src/utils/indicatorHelpers/index.js';
import type { IndicatorState } from '../../src/utils/indicatorHelpers/types.js';

function createIndicatorState(overrides: Partial<IndicatorState> = {}): IndicatorState {
  return {
    ema: { 5: 101.2, 10: 99.8 },
    psy: { 12: 67.5 },
    kdj: { k: 52, d: 48, j: 60 },
    macd: { macd: 1.2, dif: 0.5, dea: 0.3 },
    adx: 28,
    ...overrides,
  };
}

describe('indicatorHelpers business semantics', () => {
  it('parses valid indicator periods and rejects malformed inputs', () => {
    expect(parseIndicatorPeriod({ indicatorName: 'EMA:5', prefix: 'EMA:' })).toBe(5);
    expect(parseIndicatorPeriod({ indicatorName: 'RSI:14', prefix: 'RSI:' })).toBe(14);
    expect(parseIndicatorPeriod({ indicatorName: 'PSY:12', prefix: 'PSY:' })).toBe(12);

    expect(parseIndicatorPeriod({ indicatorName: 'EMA:0', prefix: 'EMA:' })).toBeNull();
    expect(parseIndicatorPeriod({ indicatorName: 'EMA:-1', prefix: 'EMA:' })).toBeNull();
    expect(parseIndicatorPeriod({ indicatorName: 'EMA:14.5', prefix: 'EMA:' })).toBeNull();
    expect(parseIndicatorPeriod({ indicatorName: 'EMA:10px', prefix: 'EMA:' })).toBeNull();
    expect(parseIndicatorPeriod({ indicatorName: 'MACD', prefix: 'EMA:' })).toBeNull();
  });

  it('returns values for supported fixed indicators and null for unsupported names', () => {
    const state = createIndicatorState();

    expect(getIndicatorValue(state, 'K')).toBe(52);
    expect(getIndicatorValue(state, 'D')).toBe(48);
    expect(getIndicatorValue(state, 'J')).toBe(60);
    expect(getIndicatorValue(state, 'MACD')).toBe(1.2);
    expect(getIndicatorValue(state, 'DIF')).toBe(0.5);
    expect(getIndicatorValue(state, 'DEA')).toBe(0.3);
    expect(getIndicatorValue(state, 'ADX')).toBe(28);
    expect(getIndicatorValue(state, 'MFI')).toBeNull();
    expect(getIndicatorValue(state, 'UNKNOWN')).toBeNull();
  });

  it('returns values for supported period indicators and null for invalid or missing periods', () => {
    const state = createIndicatorState();

    expect(getIndicatorValue(state, 'EMA:5')).toBe(101.2);
    expect(getIndicatorValue(state, 'EMA:10')).toBe(99.8);
    expect(getIndicatorValue(state, 'PSY:12')).toBe(67.5);

    expect(getIndicatorValue(state, 'EMA:0')).toBeNull();
    expect(getIndicatorValue(state, 'EMA:251')).toBeNull();
    expect(getIndicatorValue(state, 'EMA:14.5')).toBeNull();
    expect(getIndicatorValue(state, 'PSY:101')).toBeNull();
    expect(getIndicatorValue(state, 'PSY:6')).toBeNull();
  });

  it('returns null when state is absent or indicator values are invalid', () => {
    expect(getIndicatorValue(null, 'K')).toBeNull();

    const invalidState = createIndicatorState({
      ema: { 5: Number.NaN },
      psy: { 12: Number.POSITIVE_INFINITY },
      kdj: null,
      macd: null,
      adx: null,
    });

    expect(getIndicatorValue(invalidState, 'EMA:5')).toBeNull();
    expect(getIndicatorValue(invalidState, 'PSY:12')).toBeNull();
    expect(getIndicatorValue(invalidState, 'K')).toBeNull();
    expect(getIndicatorValue(invalidState, 'MACD')).toBeNull();
    expect(getIndicatorValue(invalidState, 'ADX')).toBeNull();
  });
});
