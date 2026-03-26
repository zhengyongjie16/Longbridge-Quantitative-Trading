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
  pushToBuffer,
} from '../../../../src/main/asyncProgram/indicatorCache/utils.js';

function createEntry(timestamp: number, price: number): IndicatorCacheEntry {
  return {
    timestamp,
    snapshot: {
      price,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: null,
      macd: null,
      adx: null,
    },
  };
}

describe('indicatorCache utils', () => {
  it('returns the closest entry within tolerance from a partially filled buffer', () => {
    const buffer = createRingBuffer(5);
    pushToBuffer(buffer, createEntry(1000, 1));
    pushToBuffer(buffer, createEntry(2000, 2));
    pushToBuffer(buffer, createEntry(3000, 3));

    const result = findClosestEntry(buffer, 2400, 500);
    expect(result?.timestamp).toBe(2000);
    expect(result?.snapshot.price).toBe(2);
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
    expect(nearOldestRetained?.timestamp).toBe(4000);
    expect(nearOldestRetained?.snapshot.price).toBe(4);

    const nearNewest = findClosestEntry(buffer, 4900, 200);
    expect(nearNewest?.timestamp).toBe(5000);
    expect(nearNewest?.snapshot.price).toBe(5);
  });
});
