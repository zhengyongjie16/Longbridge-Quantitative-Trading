import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIndicatorCache } from '../src/main/asyncProgram/indicatorCache/index.js';
import { createDelayedSignalVerifier } from '../src/main/asyncProgram/delayedSignalVerifier/index.js';
import { createIndicatorSnapshot, createSignal, withMockedNow } from './utils.js';

const createVerifier = () => {
  const indicatorCache = createIndicatorCache({ maxEntries: 50 });
  const verifier = createDelayedSignalVerifier({
    indicatorCache,
    verificationConfig: {
      buy: { delaySeconds: 1, indicators: ['K'] },
      sell: { delaySeconds: 1, indicators: ['K'] },
    },
  });
  return { indicatorCache, verifier };
};

test('DelayedSignalVerifier rejects when triggerTime is missing', () => {
  const { verifier } = createVerifier();
  const signal = createSignal({
    triggerTime: null,
    indicators1: { K: 10 },
  });
  verifier.addSignal(signal, 'HSI.HK');
  assert.equal(verifier.getPendingCount(), 0);
});

test('DelayedSignalVerifier rejects when indicators config is empty', () => {
  const indicatorCache = createIndicatorCache({ maxEntries: 50 });
  const verifier = createDelayedSignalVerifier({
    indicatorCache,
    verificationConfig: {
      buy: { delaySeconds: 1, indicators: [] },
      sell: { delaySeconds: 1, indicators: [] },
    },
  });
  const signal = createSignal({
    indicators1: { K: 10 },
  });
  verifier.addSignal(signal, 'HSI.HK');
  assert.equal(verifier.getPendingCount(), 0);
});

test('DelayedSignalVerifier calls onVerified when verification passes', async () => {
  const { indicatorCache, verifier } = createVerifier();
  const baseTime = 1_000_000;
  const triggerTime = new Date(baseTime);

  withMockedNow(baseTime, () => {
    indicatorCache.push('HSI.HK', createIndicatorSnapshot({ kdj: { k: 11, d: 0, j: 0 } }));
  });
  withMockedNow(baseTime + 5_000, () => {
    indicatorCache.push('HSI.HK', createIndicatorSnapshot({ kdj: { k: 12, d: 0, j: 0 } }));
  });
  withMockedNow(baseTime + 10_000, () => {
    indicatorCache.push('HSI.HK', createIndicatorSnapshot({ kdj: { k: 13, d: 0, j: 0 } }));
  });

  const signal = createSignal({
    action: 'BUYCALL',
    triggerTime,
    indicators1: { K: 10 },
  });

  let verified = false;
  let rejected = false;
  let verifiedSignal: typeof signal | null = null;

  verifier.onVerified((sig) => {
    verified = true;
    verifiedSignal = sig;
  });
  verifier.onRejected(() => {
    rejected = true;
  });

  withMockedNow(baseTime + 10_000, () => {
    verifier.addSignal(signal, 'HSI.HK');
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(verified, true);
  assert.equal(rejected, false);
  assert.equal(verifiedSignal, signal);
});

test('DelayedSignalVerifier calls onRejected when verification fails', async () => {
  const { indicatorCache, verifier } = createVerifier();
  const baseTime = 2_000_000;
  const triggerTime = new Date(baseTime);

  withMockedNow(baseTime, () => {
    indicatorCache.push('HSI.HK', createIndicatorSnapshot({ kdj: { k: 9, d: 0, j: 0 } }));
  });
  withMockedNow(baseTime + 5_000, () => {
    indicatorCache.push('HSI.HK', createIndicatorSnapshot({ kdj: { k: 11, d: 0, j: 0 } }));
  });
  withMockedNow(baseTime + 10_000, () => {
    indicatorCache.push('HSI.HK', createIndicatorSnapshot({ kdj: { k: 12, d: 0, j: 0 } }));
  });

  const signal = createSignal({
    action: 'SELLCALL',
    triggerTime,
    indicators1: { K: 10 },
  });

  let rejected = false;
  verifier.onRejected(() => {
    rejected = true;
  });

  withMockedNow(baseTime + 10_000, () => {
    verifier.addSignal(signal, 'HSI.HK');
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(rejected, true);
});
