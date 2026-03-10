/**
 * signalConfigParser 业务测试
 *
 * 功能：
 * - 验证信号配置解析的场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { formatSignalConfig, parseSignalConfig } from '../../src/config/utils.js';
import { evaluateSignalConfig } from '../../src/core/strategy/utils.js';
import type { IndicatorState } from '../../src/utils/indicatorHelpers/types.js';

describe('signalConfigParser business flow', () => {
  it('supports grouped rules with required-count and OR semantics', () => {
    const parsed = parseSignalConfig('(RSI:6<70,MFI>40,D>45)/2|(J<-20)');
    expect(parsed).not.toBeNull();
    expect(parsed?.conditionGroups).toHaveLength(2);
    expect(parsed?.conditionGroups[0]?.requiredCount).toBe(2);

    const stateForGroup1: IndicatorState = {
      rsi: { 6: 65 },
      mfi: 50,
      kdj: { d: 50, j: 5 },
    };
    const group1Result = evaluateSignalConfig(stateForGroup1, parsed);
    expect(group1Result.triggered).toBeTrue();
    expect(group1Result.satisfiedGroupIndex).toBe(0);
    expect(group1Result.satisfiedCount).toBe(3);

    const stateForGroup2: IndicatorState = {
      rsi: { 6: 80 },
      mfi: 20,
      kdj: { d: 10, j: -25 },
    };
    const group2Result = evaluateSignalConfig(stateForGroup2, parsed);
    expect(group2Result.triggered).toBeTrue();
    expect(group2Result.satisfiedGroupIndex).toBe(1);
    expect(group2Result.reason).toContain('满足条件2');
  });

  it('rejects invalid condition syntax and limits parsing to first three groups', () => {
    expect(parseSignalConfig('MACD>0')).toBeNull();
    expect(parseSignalConfig('(RSI:0<20)')).toBeNull();

    const clamped = parseSignalConfig('(K>1,D>1)/5');
    expect(clamped?.conditionGroups[0]?.requiredCount).toBe(2);

    const maxGroups = parseSignalConfig('(K>1)|(D>1)|(J>1)|(MFI>1)');
    expect(maxGroups?.conditionGroups).toHaveLength(3);
  });

  it('rejects ADX in signal conditions because ADX is verification-only', () => {
    expect(parseSignalConfig('(ADX>25)')).toBeNull();
    expect(parseSignalConfig('(ADX<10)|(K>80)')).toBeNull();
  });

  it('formats parsed config into deterministic display text', () => {
    const parsed = parseSignalConfig('(K>1,D>1,J>1)/2|(MFI<20)');
    expect(formatSignalConfig(parsed)).toBe('(K>1,D>1,J>1)/2|(MFI<20)');
    expect(formatSignalConfig(null)).toBe('(无效配置)');
  });

  it('returns explicit reason when config is invalid or no group is satisfied', () => {
    const invalid = evaluateSignalConfig({}, null);
    expect(invalid.triggered).toBeFalse();
    expect(invalid.reason).toBe('无效的信号配置');

    const parsed = parseSignalConfig('(K>80)');
    const unsatisfied = evaluateSignalConfig({ kdj: { k: 70 } }, parsed);
    expect(unsatisfied.triggered).toBeFalse();
    expect(unsatisfied.reason).toBe('未满足任何条件组');
  });
});
