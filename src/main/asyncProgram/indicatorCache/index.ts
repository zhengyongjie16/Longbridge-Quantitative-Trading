/**
 * 指标缓存模块
 *
 * 功能/职责：
 * - 按监控标的维护环形缓冲区，存储真实时间轴上的延迟验证最小样本
 * - 为 DelayedSignalVerifier 提供按时间点回溯的稳定三态值（value/missing/invalid）
 *
 * 执行流程：
 * - timeDriverProgram 每秒 push(monitorSymbol, values, sampleTimestampMs)
 * - 延迟验证器在验证时 getAt(monitorSymbol, targetTime, toleranceMs)
 */
import { INDICATOR_CACHE } from '../../../constants/index.js';
import type {
  IndicatorCache,
  IndicatorCacheEntry,
  IndicatorCacheOptions,
  VerificationSampleValues,
  _RingBuffer,
} from './types.js';
import { createRingBuffer, pushToBuffer, findClosestEntry } from './utils.js';

/**
 * 创建延迟验证样本缓存。未传 options 或 maxEntries 时使用默认容量。
 *
 * @param options 可选配置，maxEntries 为单标的环形缓冲区最大条目数
 * @returns 延迟验证样本缓存实例（push、getAt、clearAll）
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
     * 推送单个采样时刻的延迟验证样本到指定标的缓冲区。
     *
     * @param monitorSymbol 监控标的代码
     * @param values 当前采样时刻的延迟验证三态样本
     * @param sampleTimestampMs 采样时间戳（毫秒）
     */
    push(monitorSymbol: string, values: VerificationSampleValues, sampleTimestampMs: number): void {
      const buffer = getOrCreateBuffer(monitorSymbol);

      const entry: IndicatorCacheEntry = {
        timestamp: sampleTimestampMs,
        values,
      };
      pushToBuffer(buffer, entry);
    },

    /**
     * 查询指定标的在目标时间附近的延迟验证样本。
     * 返回容忍度内最接近 targetTime 的条目，无匹配时返回 null。
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
