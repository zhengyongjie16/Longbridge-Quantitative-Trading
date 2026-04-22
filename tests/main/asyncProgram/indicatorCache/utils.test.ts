import { describe, expect, it } from 'bun:test';

import type { IndicatorCacheEntry } from '../../../../src/main/asyncProgram/indicatorCache/types.js';
import {
  createSampleQueue,
  findClosestEntry,
  projectVerificationSampleValues,
  pushToQueue,
} from '../../../../src/main/asyncProgram/indicatorCache/utils.js';

function createEntry(timestamp: number, value: number): IndicatorCacheEntry {
  return {
    timestamp,
    values: {
      K: {
        kind: 'value',
        value,
      },
    },
  };
}

describe('indicatorCache utils', () => {
  it('projects NaN indicator values to invalid sample points', () => {
    const values = projectVerificationSampleValues(
      {
        price: 100,
        changePercent: 0,
        ema: {
          5: Number.NaN,
        },
        rsi: null,
        psy: null,
        mfi: null,
        kdj: null,
        macd: null,
        adx: null,
      },
      ['EMA:5'],
    );

    expect(values).toEqual({
      'EMA:5': { kind: 'invalid' },
    });
  });

  it('stores verification sample values instead of full snapshot', () => {
    const queue = createSampleQueue();
    pushToQueue(
      queue,
      {
        timestamp: 1000,
        values: {
          K: { kind: 'value', value: 81 },
          ADX: { kind: 'invalid' },
        },
      },
      5000,
    );

    const entry = findClosestEntry(queue, 1000);
    expect(entry).toEqual({
      timestamp: 1000,
      values: {
        K: { kind: 'value', value: 81 },
        ADX: { kind: 'invalid' },
      },
    });
  });

  it('trims samples older than retentionWindowMs after push', () => {
    const queue = createSampleQueue();
    pushToQueue(queue, createEntry(1000, 1), 2500);
    pushToQueue(queue, createEntry(2000, 2), 2500);
    pushToQueue(queue, createEntry(4000, 4), 2500);

    expect(queue.entries).toEqual([createEntry(2000, 2), createEntry(4000, 4)]);
    expect(findClosestEntry(queue, 2000)?.timestamp).toBe(2000);
    expect(findClosestEntry(queue, 4000)?.timestamp).toBe(4000);
  });

  it('returns the later entry when two samples are equally distant', () => {
    const queue = createSampleQueue();
    pushToQueue(queue, createEntry(2000, 2), 5000);
    pushToQueue(queue, createEntry(3000, 3), 5000);

    const result = findClosestEntry(queue, 2500);
    expect(result?.timestamp).toBe(3000);
  });

  it('returns the closest retained entry without tolerance filtering', () => {
    const queue = createSampleQueue();
    pushToQueue(queue, createEntry(1000, 1), 10000);
    pushToQueue(queue, createEntry(2000, 2), 10000);
    pushToQueue(queue, createEntry(3000, 3), 10000);

    const result = findClosestEntry(queue, 5000);
    const resultK = result?.values.K;

    expect(result?.timestamp).toBe(3000);
    expect(resultK?.kind === 'value' ? resultK.value : null).toBe(3);
  });
});
