import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIndicatorCache } from '../src/main/asyncProgram/indicatorCache/index.js';
import { createIndicatorSnapshot, withMockedNow } from './utils.js';

test('IndicatorCache push clones snapshot', () => {
  const cache = createIndicatorCache({ maxEntries: 10 });
  const snapshot = createIndicatorSnapshot({
    kdj: { k: 10, d: 20, j: 30 },
    ema: { 7: 1.1 },
    rsi: { 6: 55 },
  });

  withMockedNow(1_000, () => {
    cache.push('HSI.HK', snapshot);
  });

  const mutableSnapshot = snapshot as unknown as {
    kdj: { k: number; d: number; j: number } | null;
    ema: Record<number, number> | null;
  };
  if (mutableSnapshot.kdj) {
    mutableSnapshot.kdj.k = 99;
  }
  if (mutableSnapshot.ema) {
    mutableSnapshot.ema[7] = 9.9;
  }

  const latest = cache.getLatest('HSI.HK');
  assert.ok(latest);
  assert.equal(latest.snapshot.kdj?.k, 10);
  assert.equal(latest.snapshot.ema?.[7], 1.1);
});

test('IndicatorCache getAt/getRange finds entries by time', () => {
  const cache = createIndicatorCache({ maxEntries: 10 });
  const snapA = createIndicatorSnapshot({ price: 1 });
  const snapB = createIndicatorSnapshot({ price: 2 });
  const snapC = createIndicatorSnapshot({ price: 3 });

  withMockedNow(1_000, () => cache.push('HSI.HK', snapA));
  withMockedNow(2_000, () => cache.push('HSI.HK', snapB));
  withMockedNow(3_000, () => cache.push('HSI.HK', snapC));

  const entry = cache.getAt('HSI.HK', 2_100, 200);
  assert.ok(entry);
  assert.equal(entry.snapshot.price, 2);

  const range = cache.getRange('HSI.HK', 1_500, 3_000);
  assert.equal(range.length, 2);
  assert.deepEqual(range.map((item) => item.snapshot.price), [2, 3]);
});
