/**
 * IndicatorCache 实现
 * 使用环形缓冲区管理内存，存储每秒的指标快照
 *
 * 数据独立性设计：
 * - push 时对 snapshot 进行深拷贝，确保存储的数据独立于外部对象池
 * - 这样主循环可以安全地释放 kdj/macd 等对象池对象，不影响缓存数据
 * - 延迟验证器查询历史数据时，数据保持完整有效
 */
import { INDICATOR_CACHE } from '../../../constants/index.js';
import type { IndicatorSnapshot } from '../../../types/quote.js';
import type { IndicatorCache, IndicatorCacheEntry, IndicatorCacheOptions, _RingBuffer } from './types.js';
import {
  createRingBuffer,
  pushToBuffer,
  findClosestEntry,
  cloneIndicatorSnapshot,
} from './utils.js';

/**
 * 创建指标缓存
 * @param options 配置选项
 * @returns 指标缓存实例
 */
export const createIndicatorCache = (options: IndicatorCacheOptions = {}): IndicatorCache => {
  const maxEntries = options.maxEntries ?? INDICATOR_CACHE.TIMESERIES_DEFAULT_MAX_ENTRIES;
  const buffers = new Map<string, _RingBuffer>();

  /**
   * 获取或创建指定标的的缓冲区
   */
  const getOrCreateBuffer = (monitorSymbol: string): _RingBuffer => {
    let buffer = buffers.get(monitorSymbol);
    if (!buffer) {
      buffer = createRingBuffer(maxEntries);
      buffers.set(monitorSymbol, buffer);
    }
    return buffer;
  };

  return {
    /**
     * 推送指标快照到指定标的的缓冲区
     * 对 snapshot 进行深拷贝后存储，确保数据独立于外部对象池
     */
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

    /**
     * 查询指定标的在目标时间附近的指标快照
     * 返回容忍度内最接近 targetTime 的条目，无匹配时返回 null
     */
    getAt(monitorSymbol: string, targetTime: number, toleranceMs: number): IndicatorCacheEntry | null {
      const buffer = buffers.get(monitorSymbol);
      if (!buffer || buffer.size === 0) return null;
      return findClosestEntry(buffer, targetTime, toleranceMs);
    },

    /**
     * 清空所有标的的缓冲区，用于跨日重置
     */
    clearAll(): void {
      buffers.clear();
    },
  };
};
