/**
 * delayedSignalVerifier 业务测试
 *
 * 功能：
 * - 验证延迟验证通过/拒绝场景与指标边界及业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { createIndicatorCache } from '../../../../src/main/asyncProgram/indicatorCache/index.js';
import { createDelayedSignalVerifier } from '../../../../src/main/asyncProgram/delayedSignalVerifier/index.js';
import { createSignal } from '../../../../mock/factories/signalFactory.js';
import type { VerificationIndicator } from '../../../../src/types/state.js';

const K_VERIFICATION_INDICATORS: ReadonlyArray<VerificationIndicator> = ['K'];
const ADX_VERIFICATION_INDICATORS: ReadonlyArray<VerificationIndicator> = ['ADX'];

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
    adx: null,
  };
}

function createSnapshotAdx(adx: number) {
  return {
    price: 100,
    changePercent: 0,
    ema: null,
    rsi: null,
    psy: null,
    mfi: null,
    kdj: { k: 50, d: 50, j: 50 },
    macd: { macd: 0, dif: 0, dea: 0 },
    adx,
  };
}

describe('delayedSignalVerifier business flow', () => {
  it('passes BUYCALL when T0/T+5/T+10 are all above initial value', async () => {
    const baseTime = 100_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
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
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
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
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);
    expect(verified).toBe(1);
  });

  it('passes BUYPUT when T0/T+5/T+10 are all below initial value', async () => {
    const baseTime = 250_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
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
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);
    expect(verified).toBe(1);
  });

  it('passes SELLPUT when T0/T+5/T+10 are all above initial value', async () => {
    const baseTime = 350_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
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
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);
    expect(verified).toBe(1);
  });

  it('rejects signal when one required time point is missing', async () => {
    const baseTime = 200_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    withMockedNowSync(baseTime, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(11));
    });

    withMockedNowSync(baseTime + 4_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotK(12));
    });

    let verifiedCount = 0;
    verifier.onVerified(() => {
      verifiedCount += 1;
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: baseTime,
      indicators1: { K: 10 },
    });

    withMockedNowSync(baseTime + 10000, () => {
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);

    expect(verifiedCount).toBe(0);
  });

  it('accepts data points within +/-5s tolerance window', async () => {
    const baseTime = 300_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
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
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);

    expect(passed).toBe(1);
  });

  it('passes SELLCALL + ADX when three points decline (positive path)', async () => {
    const baseTime = 400_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    withMockedNowSync(baseTime, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(28));
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(27));
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(26));
    });

    let verified = 0;
    verifier.onVerified(() => {
      verified += 1;
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: baseTime,
      indicators1: { ADX: 30 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: ADX_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);
    expect(verified).toBe(1);
  });

  it('passes BUYPUT + ADX when three points decline (positive path)', async () => {
    const baseTime = 450_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    withMockedNowSync(baseTime, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(25));
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(24));
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(23));
    });

    let verified = 0;
    verifier.onVerified(() => {
      verified += 1;
    });

    const signal = createSignal({
      symbol: 'BEAR.HK',
      action: 'BUYPUT',
      triggerTimeMs: baseTime,
      indicators1: { ADX: 27 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: ADX_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);
    expect(verified).toBe(1);
  });

  it('passes BUYCALL + ADX when three points decline (negative mapping path)', async () => {
    const baseTime = 500_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    withMockedNowSync(baseTime, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(22));
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(21));
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(20));
    });

    let verified = 0;
    verifier.onVerified(() => {
      verified += 1;
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: baseTime,
      indicators1: { ADX: 25 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: ADX_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);
    expect(verified).toBe(1);
  });

  it('passes SELLPUT + ADX when three points decline (negative mapping path)', async () => {
    const baseTime = 550_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    withMockedNowSync(baseTime, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(18));
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(17));
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(16));
    });

    let verified = 0;
    verifier.onVerified(() => {
      verified += 1;
    });

    const signal = createSignal({
      symbol: 'BEAR.HK',
      action: 'SELLPUT',
      triggerTimeMs: baseTime,
      indicators1: { ADX: 20 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: ADX_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);
    expect(verified).toBe(1);
  });

  it('rejects ADX when any time point has not declined', async () => {
    const baseTime = 600_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    // T0+5s ADX 上升而非下降
    withMockedNowSync(baseTime, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(28));
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(31));
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSnapshotAdx(26));
    });

    let verified = 0;
    verifier.onVerified(() => {
      verified += 1;
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: baseTime,
      indicators1: { ADX: 30 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: ADX_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);
    expect(verified).toBe(0);
  });

  it('clears pending signals by direction on symbol switch', () => {
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    const now = 500_000;
    withMockedNowSync(now, () => {
      verifier.addSignal(
        {
          signal: createSignal({
            symbol: 'BULL.HK',
            action: 'BUYCALL',
            triggerTimeMs: now,
            indicators1: { K: 10 },
          }),
          monitorSymbol: 'HSI.HK',
          verificationIndicators: K_VERIFICATION_INDICATORS,
        },
      );

      verifier.addSignal(
        {
          signal: createSignal({
            symbol: 'BEAR.HK',
            action: 'BUYPUT',
            triggerTimeMs: now,
            indicators1: { K: 10 },
          }),
          monitorSymbol: 'HSI.HK',
          verificationIndicators: K_VERIFICATION_INDICATORS,
        },
      );
    });

    const cancelledLong = verifier.cancelAllForDirection('HSI.HK', 'LONG');

    expect(cancelledLong).toBe(1);
    expect(verifier.getPendingCount()).toBe(1);
    verifier.destroy();
  });
});

