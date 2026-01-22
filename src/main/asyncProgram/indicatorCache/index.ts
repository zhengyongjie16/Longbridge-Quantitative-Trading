/**
 * IndicatorCache 实现
 * 使用环形缓冲区管理内存，存储每秒的指标快照
 *
 * 数据独立性设计：
 * - push 时对 snapshot 进行深拷贝，确保存储的数据独立于外部对象池
 * - 这样主循环可以安全地释放 kdj/macd 等对象池对象，不影响缓存数据
 * - 延迟验证器查询历史数据时，数据保持完整有效
 */

import type { IndicatorSnapshot } from '../../../types/index.js';
import type { IndicatorCache, IndicatorCacheEntry, IndicatorCacheOptions, RingBuffer } from './types.js';
import {
  createRingBuffer,
  pushToBuffer,
  getBufferEntries,
  getLatestFromBuffer,
  cloneIndicatorSnapshot,
} from './utils.js';

/**
 * 默认最大缓存条目数
 * 计算公式：max(buyDelay, sellDelay) + 15 + 10，默认 100
 */
const DEFAULT_MAX_ENTRIES = 100;

/**
 * 创建指标缓存
 * @param options 配置选项
 * @returns 指标缓存实例
 */
export const createIndicatorCache = (options: IndicatorCacheOptions = {}): IndicatorCache => {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const buffers = new Map<string, RingBuffer>();

  /**
   * 获取或创建指定标的的缓冲区
   */
  const getOrCreateBuffer = (monitorSymbol: string): RingBuffer => {
    let buffer = buffers.get(monitorSymbol);
    if (!buffer) {
      buffer = createRingBuffer(maxEntries);
      buffers.set(monitorSymbol, buffer);
    }
    return buffer;
  };

  return {
    push(monitorSymbol: string, snapshot: IndicatorSnapshot): void {
      const buffer = getOrCreateBuffer(monitorSymbol);
      // 克隆快照，确保存储的数据独立于外部对象池管理
      // 这样即使主循环释放了 kdj/macd 对象，IndicatorCache 中的数据也不受影响
      const entry: IndicatorCacheEntry = {
        timestamp: Date.now(),
        snapshot: cloneIndicatorSnapshot(snapshot),
      };
      pushToBuffer(buffer, entry);
    },

    getAt(monitorSymbol: string, targetTime: number, toleranceMs: number): IndicatorCacheEntry | null {
      const buffer = buffers.get(monitorSymbol);
      if (!buffer || buffer.size === 0) return null;

      const entries = getBufferEntries(buffer);
      let closestEntry: IndicatorCacheEntry | null = null;
      let minDiff = Infinity;

      for (const entry of entries) {
        const diff = Math.abs(entry.timestamp - targetTime);
        if (diff <= toleranceMs && diff < minDiff) {
          minDiff = diff;
          closestEntry = entry;
        }
      }

      return closestEntry;
    },

    getLatest(monitorSymbol: string): IndicatorCacheEntry | null {
      const buffer = buffers.get(monitorSymbol);
      if (!buffer) return null;
      return getLatestFromBuffer(buffer);
    },

    getRange(monitorSymbol: string, startTime: number, endTime: number): IndicatorCacheEntry[] {
      const buffer = buffers.get(monitorSymbol);
      if (!buffer || buffer.size === 0) return [];

      const entries = getBufferEntries(buffer);
      return entries.filter((entry) => entry.timestamp >= startTime && entry.timestamp <= endTime);
    },

    clear(monitorSymbol: string): void {
      buffers.delete(monitorSymbol);
    },

    clearAll(): void {
      buffers.clear();
    },
  };
};
