/**
 * 指标缓存模块
 *
 * 功能/职责：
 * - 按监控标的维护环形缓冲区，存储每秒推送的指标快照，供延迟验证器按时间点查询
 * - push 时对 snapshot 深拷贝后入库，使缓存与主循环对象池解耦，主循环释放 kdj/macd 不影响缓存
 *
 * 执行流程：
 * - 主循环每秒 push(monitorSymbol, snapshot)；延迟验证器在验证时 getAt(monitorSymbol, targetTime, toleranceMs)
 */
import { INDICATOR_CACHE } from '../../../constants/index.js';
import type { IndicatorSnapshot } from '../../../types/quote.js';
import type {
  IndicatorCache,
  IndicatorCacheEntry,
  IndicatorCacheOptions,
  _RingBuffer,
} from './types.js';
import {
  createRingBuffer,
  pushToBuffer,
  findClosestEntry,
  cloneIndicatorSnapshot,
} from './utils.js';

/**
 * 创建指标缓存。未传 options 或 maxEntries 时使用默认容量（INDICATOR_CACHE.TIMESERIES_DEFAULT_MAX_ENTRIES）。
 *
 * @param options 可选配置，maxEntries 为单标的环形缓冲区最大条目数
 * @returns 指标缓存实例（push、getAt、clearAll）
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
    getAt(
      monitorSymbol: string,
      targetTime: number,
      toleranceMs: number,
    ): IndicatorCacheEntry | null {
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
