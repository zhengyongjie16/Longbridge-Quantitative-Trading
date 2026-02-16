import { describe, expect, it } from 'bun:test';
import { createIndicatorCache } from '../../../../src/main/asyncProgram/indicatorCache/index.js';
import { createDelayedSignalVerifier } from '../../../../src/main/asyncProgram/delayedSignalVerifier/index.js';
import { createSignal } from '../../../../mock/factories/signalFactory.js';

function withMockedNowSync<T>(nowMs: number, run: () => T): T {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return run();
  } finally {
    Date.now = originalNow;
  }
}

function createSnapshotK(k: number) {
  return {
    price: 100,
    changePercent: 0,
    ema: null,
    rsi: null,
    psy: null,
    mfi: null,
    kdj: { k, d: k, j: k },
    macd: { macd: 0, dif: 0, dea: 0 },
  };
}

describe('delayedSignalVerifier business flow', () => {
  it('passes BUYCALL when T0/T+5/T+10 are all above initial value', async () => {
    const baseTime = 100_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
      verificationConfig: {
        buy: {
          delaySeconds: 10,
          indicators: ['K'],
        },
        sell: {
          delaySeconds: 10,
          indicators: ['K'],
        },
      },
    });

    withMockedNowSync(baseTime, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(11));
    });
    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(12));
    });
    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(13));
    });

    let verified = 0;
    verifier.onVerified(() => {
      verified += 1;
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: baseTime,
      indicators1: { K: 10 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal(signal, 'HSI.HK');
    });

    await Bun.sleep(20);

    expect(verified).toBe(1);
    expect(verifier.getPendingCount()).toBe(0);
  });

  it('rejects signal when one required time point is missing', async () => {
    const baseTime = 200_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
      verificationConfig: {
        buy: {
          delaySeconds: 10,
          indicators: ['K'],
        },
        sell: {
          delaySeconds: 10,
          indicators: ['K'],
        },
      },
    });

    withMockedNowSync(baseTime, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(11));
    });
    withMockedNowSync(baseTime + 4_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(12));
    });

    const rejectedReasons: string[] = [];
    verifier.onRejected((_signal, _symbol, reason) => {
      rejectedReasons.push(reason);
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: baseTime,
      indicators1: { K: 10 },
    });

    withMockedNowSync(baseTime + 10000, () => {
      verifier.addSignal(signal, 'HSI.HK');
    });

    await Bun.sleep(20);

    expect(rejectedReasons).toHaveLength(1);
    expect(rejectedReasons[0]).toContain('缺少时间点数据');
  });

  it('accepts data points within +/-5s tolerance window', async () => {
    const baseTime = 300_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
      verificationConfig: {
        buy: {
          delaySeconds: 10,
          indicators: ['K'],
        },
        sell: {
          delaySeconds: 10,
          indicators: ['K'],
        },
      },
    });

    withMockedNowSync(baseTime + 4_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(11));
    });
    withMockedNowSync(baseTime + 5_000 + 4_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(12));
    });
    withMockedNowSync(baseTime + 10_000 + 4_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(13));
    });

    let passed = 0;
    verifier.onVerified(() => {
      passed += 1;
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: baseTime,
      indicators1: { K: 10 },
    });

    withMockedNowSync(baseTime + 10000, () => {
      verifier.addSignal(signal, 'HSI.HK');
    });

    await Bun.sleep(20);

    expect(passed).toBe(1);
  });

  it('clears pending signals by direction on symbol switch', () => {
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
      verificationConfig: {
        buy: {
          delaySeconds: 10,
          indicators: ['K'],
        },
        sell: {
          delaySeconds: 10,
          indicators: ['K'],
        },
      },
    });

    const now = 500_000;
    withMockedNowSync(now, () => {
      verifier.addSignal(createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        triggerTimeMs: now,
        indicators1: { K: 10 },
      }), 'HSI.HK');
      verifier.addSignal(createSignal({
        symbol: 'BEAR.HK',
        action: 'BUYPUT',
        triggerTimeMs: now,
        indicators1: { K: 10 },
      }), 'HSI.HK');
    });

    const cancelledLong = verifier.cancelAllForDirection('HSI.HK', 'LONG');

    expect(cancelledLong).toBe(1);
    expect(verifier.getPendingCount()).toBe(1);
    verifier.destroy();
  });
});
