/**
 * delayedSignalVerifier 业务测试
 *
 * 功能：
 * - 验证延迟验证通过/拒绝场景与指标边界及业务期望
 */
import { describe, expect, it } from 'bun:test';
import { createIndicatorCache } from '../../../../src/main/asyncProgram/indicatorCache/index.js';
import { createDelayedSignalVerifier } from '../../../../src/main/asyncProgram/delayedSignalVerifier/index.js';
import { performVerification } from '../../../../src/main/asyncProgram/delayedSignalVerifier/utils.js';
import { createSignal } from '../../../../mock/factories/signalFactory.js';
import type { VerificationIndicator } from '../../../../src/types/indicatorProfile.js';
import type { IndicatorCache } from '../../../../src/main/asyncProgram/indicatorCache/types.js';

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

function createSampleK(k: number) {
  return {
    K: {
      kind: 'value' as const,
      value: k,
    },
  };
}

function createSampleAdx(adx: number) {
  return {
    ADX: {
      kind: 'value' as const,
      value: adx,
    },
  };
}

describe('delayedSignalVerifier business flow', () => {
  it('passes BUYCALL from minimal verification samples without full snapshot payload', async () => {
    const baseTime = 90_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    for (const sample of [
      { values: createSampleK(11), timestamp: baseTime },
      { values: createSampleK(12), timestamp: baseTime + 5_000 },
      { values: createSampleK(13), timestamp: baseTime + 10_000 },
    ]) {
      indicatorCache.push('HSI.HK', sample.values, sample.timestamp);
    }

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
  });

  it('exposes verification execution errors to fatal handler', async () => {
    const baseTime = 91_000;
    const errors: unknown[] = [];
    const indicatorCache: IndicatorCache = {
      push: () => {},
      getClosest: () => {
        throw new TypeError('indicator cache broken');
      },
      clearAll: () => {},
    };
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
      onFatalError: (error) => {
        errors.push(error);
      },
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

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect((errors[0] as Error).message).toContain('indicator cache broken');
  });

  it('exposes onVerified callback errors to fatal handler', async () => {
    const baseTime = 92_000;
    const indicatorCache = createIndicatorCache();
    const errors: unknown[] = [];
    const verifierDeps = {
      indicatorCache,
      onFatalError: (error: unknown) => {
        errors.push(error);
      },
    };
    const verifier = createDelayedSignalVerifier(verifierDeps);

    for (const sample of [
      { values: createSampleK(11), timestamp: baseTime },
      { values: createSampleK(12), timestamp: baseTime + 5_000 },
      { values: createSampleK(13), timestamp: baseTime + 10_000 },
    ]) {
      indicatorCache.push('HSI.HK', sample.values, sample.timestamp);
    }

    verifier.onVerified(() => {
      throw new Error('queue push failed');
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

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toContain('queue push failed');
  });

  it('passes BUYCALL when T0/T+5/T+10 are all above initial value', async () => {
    const baseTime = 100_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    withMockedNowSync(baseTime, () => {
      indicatorCache.push('HSI.HK', createSampleK(11), Date.now());
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSampleK(12), Date.now());
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSampleK(13), Date.now());
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
      indicatorCache.push('HSI.HK', createSampleK(9), Date.now());
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSampleK(8), Date.now());
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSampleK(7), Date.now());
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
      indicatorCache.push('HSI.HK', createSampleK(19), Date.now());
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSampleK(18), Date.now());
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSampleK(17), Date.now());
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
      indicatorCache.push('HSI.HK', createSampleK(41), Date.now());
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSampleK(42), Date.now());
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSampleK(43), Date.now());
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

  it('rejects signal with invalid sample points and reports 值无效', async () => {
    const baseTime = 200_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    for (const timestamp of [baseTime, baseTime + 5_000, baseTime + 10_000]) {
      indicatorCache.push('HSI.HK', { K: { kind: 'invalid' } }, timestamp);
    }

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

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);

    expect(verifiedCount).toBe(0);
    const timerId = setTimeout(() => {}, 0);
    const result = performVerification(indicatorCache, {
      signal,
      monitorSymbol: 'HSI.HK',
      triggerTime: baseTime,
      initialIndicators: { K: 10 },
      indicatorNames: K_VERIFICATION_INDICATORS,
      timerId,
    });
    clearTimeout(timerId);
    expect(result.reason).toContain('值无效');
  });

  it('fails when cache has no samples for required verification points', async () => {
    const baseTime = 200_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
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

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal({
        signal,
        monitorSymbol: 'HSI.HK',
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);

    expect(verifiedCount).toBe(0);
  });

  it('accepts nearest retained samples even when one old sample covers multiple target points', async () => {
    const baseTime = 300_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
    });

    withMockedNowSync(baseTime + 4_000, () => {
      indicatorCache.push('HSI.HK', createSampleK(11), Date.now());
    });

    withMockedNowSync(baseTime + 9_000, () => {
      indicatorCache.push('HSI.HK', createSampleK(12), Date.now());
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

    withMockedNowSync(baseTime + 10_000, () => {
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
      indicatorCache.push('HSI.HK', createSampleAdx(28), Date.now());
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSampleAdx(27), Date.now());
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSampleAdx(26), Date.now());
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
      indicatorCache.push('HSI.HK', createSampleAdx(25), Date.now());
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSampleAdx(24), Date.now());
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSampleAdx(23), Date.now());
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
      indicatorCache.push('HSI.HK', createSampleAdx(22), Date.now());
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSampleAdx(21), Date.now());
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSampleAdx(20), Date.now());
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
      indicatorCache.push('HSI.HK', createSampleAdx(18), Date.now());
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSampleAdx(17), Date.now());
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSampleAdx(16), Date.now());
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
      indicatorCache.push('HSI.HK', createSampleAdx(28), Date.now());
    });

    withMockedNowSync(baseTime + 5_000, () => {
      indicatorCache.push('HSI.HK', createSampleAdx(31), Date.now());
    });

    withMockedNowSync(baseTime + 10_000, () => {
      indicatorCache.push('HSI.HK', createSampleAdx(26), Date.now());
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
      verifier.addSignal({
        signal: createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: now,
          indicators1: { K: 10 },
        }),
        monitorSymbol: 'HSI.HK',
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });

      verifier.addSignal({
        signal: createSignal({
          symbol: 'BEAR.HK',
          action: 'BUYPUT',
          triggerTimeMs: now,
          indicators1: { K: 10 },
        }),
        monitorSymbol: 'HSI.HK',
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    const cancelledLong = verifier.cancelAllForDirection('HSI.HK', 'LONG');

    expect(cancelledLong).toBe(1);
    expect(verifier.getPendingCount()).toBe(1);
    verifier.destroy();
  });
});
