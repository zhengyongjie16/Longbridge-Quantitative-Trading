/**
 * indicators/profile 业务测试
 *
 * 功能：
 * - 验证指标画像编译的场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { compileIndicatorUsageProfile } from '../../../../src/services/indicators/profile/index.js';
import type { SignalConfigSet } from '../../../../src/types/config.js';

describe('indicators/profile business flow', () => {
  it('compiles indicator profile with exact strategy and verification indicators', () => {
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

    const indicatorProfile = compileIndicatorUsageProfile({
      signalConfig,
      verificationConfig: {
        buy: { delaySeconds: 10, indicators: ['EMA:7', 'DIF'] },
        sell: { delaySeconds: 10, indicators: ['EMA:21', 'K'] },
      },
    });

    expect(indicatorProfile.requiredPeriods.rsi).toEqual([6, 14, 20]);
    expect(indicatorProfile.requiredPeriods.psy).toEqual([5, 13]);
    expect(indicatorProfile.requiredPeriods.ema).toEqual([7, 21]);
    expect(indicatorProfile.requiredFamilies.kdj).toBeTrue();
    expect(indicatorProfile.requiredFamilies.macd).toBeTrue();
    expect(indicatorProfile.actionSignalIndicators.BUYCALL).toEqual(['RSI:14', 'RSI:6', 'PSY:13']);
    expect(indicatorProfile.actionSignalIndicators.SELLCALL).toEqual(['RSI:6', 'RSI:20', 'PSY:5']);
    expect(indicatorProfile.verificationIndicatorsBySide.buy).toEqual(['EMA:7', 'DIF']);
    expect(indicatorProfile.verificationIndicatorsBySide.sell).toEqual(['EMA:21', 'K']);
    expect(indicatorProfile.displayPlan).toEqual([
      'price',
      'changePercent',
      'EMA:7',
      'EMA:21',
      'RSI:6',
      'RSI:14',
      'RSI:20',
      'PSY:5',
      'PSY:13',
      'K',
      'D',
      'J',
      'MACD',
      'DIF',
      'DEA',
    ]);
  });

  it('keeps ADX as verification-only and rejects it from signal indicators', () => {
    const indicatorProfile = compileIndicatorUsageProfile({
      signalConfig: {
        buycall: {
          conditionGroups: [
            {
              conditions: [{ indicator: 'K', operator: '>', threshold: 80 }],
              requiredCount: 1,
            },
          ],
        },
        sellcall: null,
        buyput: null,
        sellput: null,
      },
      verificationConfig: {
        buy: { delaySeconds: 10, indicators: ['ADX'] },
        sell: { delaySeconds: 10, indicators: [] },
      },
    });

    expect(indicatorProfile.actionSignalIndicators.BUYCALL).toEqual(['K']);
    expect(indicatorProfile.verificationIndicatorsBySide.buy).toEqual(['ADX']);
    expect(indicatorProfile.requiredFamilies.adx).toBeTrue();
    expect(indicatorProfile.displayPlan).toContain('ADX');

    expect(() =>
      compileIndicatorUsageProfile({
        signalConfig: {
          buycall: {
            conditionGroups: [
              {
                conditions: [{ indicator: 'ADX', operator: '>', threshold: 25 }],
                requiredCount: 1,
              },
            ],
          },
          sellcall: null,
          buyput: null,
          sellput: null,
        },
        verificationConfig: {
          buy: { delaySeconds: 0, indicators: [] },
          sell: { delaySeconds: 0, indicators: [] },
        },
      }),
    ).toThrow('[配置错误] 信号条件不支持指标: ADX');
  });
});
