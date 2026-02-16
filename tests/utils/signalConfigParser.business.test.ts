import { describe, expect, it } from 'bun:test';

import {
  evaluateSignalConfig,
  extractPsyPeriods,
  extractRSIPeriods,
  formatSignalConfig,
  parseSignalConfig,
} from '../../src/utils/helpers/signalConfigParser.js';
import type { SignalConfigSet } from '../../src/types/config.js';
import type { IndicatorState } from '../../src/utils/helpers/types.js';

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

  it('extracts RSI and PSY periods from config set with dedupe and sorting', () => {
    const signalConfig: SignalConfigSet = {
      buycall: {
        conditionGroups: [
          {
            conditions: [
              { indicator: 'RSI:14', operator: '<', threshold: 30 },
              { indicator: 'RSI:6', operator: '<', threshold: 20 },
              { indicator: 'PSY:13', operator: '<', threshold: 25 },
              { indicator: 'PSY:101', operator: '<', threshold: 25 },
            ],
            requiredCount: 1,
          },
        ],
      },
      sellcall: {
        conditionGroups: [
          {
            conditions: [
              { indicator: 'RSI:6', operator: '>', threshold: 70 },
              { indicator: 'RSI:20', operator: '>', threshold: 80 },
              { indicator: 'PSY:5', operator: '>', threshold: 70 },
              { indicator: 'PSY:0', operator: '>', threshold: 70 },
            ],
            requiredCount: 1,
          },
        ],
      },
      buyput: null,
      sellput: null,
    };

    expect(extractRSIPeriods(signalConfig)).toEqual([6, 14, 20]);
    expect(extractPsyPeriods(signalConfig)).toEqual([5, 13]);
  });
});
