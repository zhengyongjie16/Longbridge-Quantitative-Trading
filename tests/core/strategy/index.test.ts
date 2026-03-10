import { describe, expect, it } from 'bun:test';
import { parseSignalConfig } from '../../../src/config/utils.js';
import { createHangSengMultiIndicatorStrategy } from '../../../src/core/strategy/index.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import { createIndicatorUsageProfileDouble, createOrderRecorderDouble } from '../../helpers/testDoubles.js';

function requireSignalConfig(configText: string) {
  const signalConfig = parseSignalConfig(configText);
  if (signalConfig === null) {
    throw new Error(`failed to parse signal config: ${configText}`);
  }

  return signalConfig;
}

function createSnapshot(
  overrides: Partial<IndicatorSnapshot> = {},
): IndicatorSnapshot {
  return {
    price: 1,
    changePercent: null,
    ema: null,
    rsi: null,
    psy: null,
    mfi: null,
    kdj: {
      k: 90,
      d: 60,
      j: 120,
    },
    macd: null,
    adx: 30,
    ...overrides,
  };
}

describe('createHangSengMultiIndicatorStrategy', () => {
  it('routes immediate and delayed signals by action-specific verification mode', () => {
    const strategy = createHangSengMultiIndicatorStrategy({
      signalConfig: {
        buycall: requireSignalConfig('(K>80)'),
        sellcall: requireSignalConfig('(D>50)'),
        buyput: null,
        sellput: null,
      },
      verificationConfig: {
        buy: {
          delaySeconds: 0,
          indicators: ['K'],
        },
        sell: {
          delaySeconds: 10,
          indicators: ['K'],
        },
      },
    });
    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [
        {
          orderId: 'BUY-1',
          symbol: 'BULL.HK',
          executedPrice: 1,
          executedQuantity: 100,
          executedTime: Date.now(),
          submittedAt: undefined,
          updatedAt: undefined,
        },
      ],
    });

    const result = strategy.generateCloseSignals(
      createSnapshot(),
      'BULL.HK',
      '',
      orderRecorder,
      createIndicatorUsageProfileDouble({
        verificationIndicatorsBySide: {
          buy: ['K'],
          sell: ['D'],
        },
      }),
    );

    expect(result.immediateSignals.map((signal) => signal.action)).toEqual(['BUYCALL']);
    expect(result.delayedSignals.map((signal) => signal.action)).toEqual(['SELLCALL']);
  });

  it('does not generate sell signals when no matching buy orders exist', () => {
    const strategy = createHangSengMultiIndicatorStrategy({
      signalConfig: {
        buycall: null,
        sellcall: requireSignalConfig('(K>80)'),
        buyput: null,
        sellput: null,
      },
      verificationConfig: {
        buy: {
          delaySeconds: 0,
          indicators: [],
        },
        sell: {
          delaySeconds: 0,
          indicators: [],
        },
      },
    });

    const result = strategy.generateCloseSignals(
      createSnapshot(),
      'BULL.HK',
      '',
      createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [],
      }),
      createIndicatorUsageProfileDouble(),
    );

    expect(result.immediateSignals).toHaveLength(0);
    expect(result.delayedSignals).toHaveLength(0);
  });

  it('drops delayed signals when compiled verification indicator list is empty', () => {
    const strategy = createHangSengMultiIndicatorStrategy({
      signalConfig: {
        buycall: requireSignalConfig('(K>80)'),
        sellcall: null,
        buyput: null,
        sellput: null,
      },
      verificationConfig: {
        buy: {
          delaySeconds: 10,
          indicators: ['K'],
        },
        sell: {
          delaySeconds: 0,
          indicators: [],
        },
      },
    });

    const result = strategy.generateCloseSignals(
      createSnapshot(),
      'BULL.HK',
      '',
      createOrderRecorderDouble(),
      createIndicatorUsageProfileDouble({
        verificationIndicatorsBySide: {
          buy: [],
          sell: [],
        },
      }),
    );

    expect(result.immediateSignals).toHaveLength(0);
    expect(result.delayedSignals).toHaveLength(0);
  });

  it('releases pooled indicator records after delayed validation setup fails', () => {
    const strategy = createHangSengMultiIndicatorStrategy({
      signalConfig: {
        buycall: requireSignalConfig('(K>80)'),
        sellcall: null,
        buyput: null,
        sellput: null,
      },
      verificationConfig: {
        buy: {
          delaySeconds: 10,
          indicators: ['K', 'ADX'],
        },
        sell: {
          delaySeconds: 0,
          indicators: [],
        },
      },
    });
    const orderRecorder = createOrderRecorderDouble();

    const failedResult = strategy.generateCloseSignals(
      createSnapshot({
        adx: null,
      }),
      'BULL.HK',
      '',
      orderRecorder,
      createIndicatorUsageProfileDouble({
        verificationIndicatorsBySide: {
          buy: ['K', 'ADX'],
          sell: [],
        },
      }),
    );

    expect(failedResult.immediateSignals).toHaveLength(0);
    expect(failedResult.delayedSignals).toHaveLength(0);

    const successfulResult = strategy.generateCloseSignals(
      createSnapshot(),
      'BULL.HK',
      '',
      orderRecorder,
      createIndicatorUsageProfileDouble({
        verificationIndicatorsBySide: {
          buy: ['D'],
          sell: [],
        },
      }),
    );

    expect(successfulResult.delayedSignals).toHaveLength(1);
    expect(successfulResult.delayedSignals[0]?.indicators1).toEqual({ D: 60 });
  });
});
