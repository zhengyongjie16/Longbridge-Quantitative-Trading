/**
 * indicatorCache utils 测试
 *
 * 功能：
 * - 验证环形缓冲区最近时间点查找在不同写入状态下保持既有语义
 * - 锁定容忍度、最近点优先和环形覆盖后的查找结果
 */
import { describe, expect, it } from 'bun:test';

import type { IndicatorCacheEntry } from '../../../../src/main/asyncProgram/indicatorCache/types.js';
import {
  createRingBuffer,
  findClosestEntry,
  projectVerificationSampleValues,
  pushToBuffer,
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
    const buffer = createRingBuffer(5);
    pushToBuffer(buffer, {
      timestamp: 1000,
      values: {
        K: { kind: 'value', value: 81 },
        ADX: { kind: 'invalid' },
      },
    });

    const entry = findClosestEntry(buffer, 1000, 0);
    expect(entry).toEqual({
      timestamp: 1000,
      values: {
        K: { kind: 'value', value: 81 },
        ADX: { kind: 'invalid' },
      },
    });
  });

  it('returns the closest entry within tolerance from a partially filled buffer', () => {
    const buffer = createRingBuffer(5);
    pushToBuffer(buffer, createEntry(1000, 1));
    pushToBuffer(buffer, createEntry(2000, 2));
    pushToBuffer(buffer, createEntry(3000, 3));

    const result = findClosestEntry(buffer, 2400, 500);
    const resultK = result?.values.K;
    expect(result?.timestamp).toBe(2000);
    expect(resultK?.kind === 'value' ? resultK.value : null).toBe(2);
  });

  it('returns null when every entry is outside tolerance', () => {
    const buffer = createRingBuffer(4);
    pushToBuffer(buffer, createEntry(1000, 1));
    pushToBuffer(buffer, createEntry(2000, 2));
    pushToBuffer(buffer, createEntry(3000, 3));

    const result = findClosestEntry(buffer, 5000, 200);
    expect(result).toBeNull();
  });

  it('matches an entry whose diff equals toleranceMs exactly', () => {
    const buffer = createRingBuffer(3);
    pushToBuffer(buffer, createEntry(1000, 1));
    pushToBuffer(buffer, createEntry(2000, 2));

    // diff = 500 === toleranceMs = 500，应命中（<= 边界）
    const result = findClosestEntry(buffer, 2500, 500);
    expect(result?.timestamp).toBe(2000);
  });

  it('returns the first-scanned entry when two entries are equidistant', () => {
    const buffer = createRingBuffer(3);
    pushToBuffer(buffer, createEntry(1000, 1));
    pushToBuffer(buffer, createEntry(2000, 2));
    pushToBuffer(buffer, createEntry(3000, 3));

    // 目标 2500，与 2000 和 3000 各差 500；实现用 diff < minDiff（严格小于），先扫到的 2000 胜出
    const result = findClosestEntry(buffer, 2500, 500);
    expect(result?.timestamp).toBe(2000);
  });

  it('preserves closest-match semantics after ring buffer wraparound', () => {
    const buffer = createRingBuffer(3);
    pushToBuffer(buffer, createEntry(1000, 1));
    pushToBuffer(buffer, createEntry(2000, 2));
    pushToBuffer(buffer, createEntry(3000, 3));
    pushToBuffer(buffer, createEntry(4000, 4));
    pushToBuffer(buffer, createEntry(5000, 5));

    const nearOldestRetained = findClosestEntry(buffer, 3900, 200);
    const nearOldestRetainedK = nearOldestRetained?.values.K;
    expect(nearOldestRetained?.timestamp).toBe(4000);
    expect(nearOldestRetainedK?.kind === 'value' ? nearOldestRetainedK.value : null).toBe(4);

    const nearNewest = findClosestEntry(buffer, 4900, 200);
    const nearNewestK = nearNewest?.values.K;
    expect(nearNewest?.timestamp).toBe(5000);
    expect(nearNewestK?.kind === 'value' ? nearNewestK.value : null).toBe(5);
  });
});
