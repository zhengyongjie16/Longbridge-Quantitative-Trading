/**
 * delayedSignalVerifier 业务测试
 *
 * 功能：
 * - 围绕 business.test.ts 场景验证 tests/main/asyncProgram/delayedSignalVerifier 相关业务行为与边界条件。
 */
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

  it('passes SELLCALL when T0/T+5/T+10 are all below initial value', async () => {
    const baseTime = 150_000;
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
      indicatorCache.push('HSI.HK', createSnapshotK(9));
    });
    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(8));
    });
    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(7));
    });

    let verified = 0;
    verifier.onVerified(() => {
      verified += 1;
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: baseTime,
      indicators1: { K: 10 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal(signal, 'HSI.HK');
    });

    await Bun.sleep(20);
    expect(verified).toBe(1);
  });

  it('passes BUYPUT when T0/T+5/T+10 are all below initial value', async () => {
    const baseTime = 250_000;
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
      indicatorCache.push('HSI.HK', createSnapshotK(19));
    });
    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(18));
    });
    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(17));
    });

    let verified = 0;
    verifier.onVerified(() => {
      verified += 1;
    });

    const signal = createSignal({
      symbol: 'BEAR.HK',
      action: 'BUYPUT',
      triggerTimeMs: baseTime,
      indicators1: { K: 20 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal(signal, 'HSI.HK');
    });

    await Bun.sleep(20);
    expect(verified).toBe(1);
  });

  it('passes SELLPUT when T0/T+5/T+10 are all above initial value', async () => {
    const baseTime = 350_000;
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
      indicatorCache.push('HSI.HK', createSnapshotK(41));
    });
    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(42));
    });
    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(43));
    });

    let verified = 0;
    verifier.onVerified(() => {
      verified += 1;
    });

    const signal = createSignal({
      symbol: 'BEAR.HK',
      action: 'SELLPUT',
      triggerTimeMs: baseTime,
      indicators1: { K: 40 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal(signal, 'HSI.HK');
    });

    await Bun.sleep(20);
    expect(verified).toBe(1);
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
