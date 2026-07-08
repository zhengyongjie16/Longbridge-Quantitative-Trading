/**
 * 指标缓存模块
 *
 * 功能/职责：
 * - 按监控标的维护时间窗口样本队列，存储真实时间轴上的延迟验证最小样本
 * - 为 DelayedSignalVerifier 提供按目标时间回溯的稳定三态值（value/missing/invalid）
 *
 * 执行流程：
 * - 上游采样方在产生延迟验证样本时 push(monitorSymbol, values, sampleTimestampMs)
 * - 延迟验证器在验证时 getClosest(monitorSymbol, targetTime)
 */
import { INDICATOR_CACHE } from '../../../constants/index.js';
import type {
  IndicatorCache,
  IndicatorCacheEntry,
  IndicatorCacheOptions,
  VerificationSampleValues,
  _SampleQueue,
} from './types.js';
import { createSampleQueue, pushToQueue, findClosestEntry } from './utils.js';

/**
 * 创建延迟验证样本缓存。未传 options 或 retentionWindowMs 时使用默认时间窗口。
 *
 * @param options 可选配置，retentionWindowMs 为单标的样本保留时间窗口
 * @returns 延迟验证样本缓存实例（push、getClosest、clearAll）
 */
export const createIndicatorCache = (options: IndicatorCacheOptions = {}): IndicatorCache => {
  const retentionWindowMs =
    options.retentionWindowMs ?? INDICATOR_CACHE.DEFAULT_RETENTION_WINDOW_MS;
  const queues = new Map<string, _SampleQueue>();

  /**
   * 获取或创建指定标的的样本队列
   */
  const getOrCreateQueue = (monitorSymbol: string): _SampleQueue => {
    let queue = queues.get(monitorSymbol);
    if (!queue) {
      queue = createSampleQueue();
      queues.set(monitorSymbol, queue);
    }

    return queue;
  };

  return {
    /**
     * 推送单个采样时刻的延迟验证样本到指定标的队列。
     *
     * @param monitorSymbol 监控标的代码
     * @param values 当前采样时刻的延迟验证三态样本
     * @param sampleTimestampMs 采样时间戳（毫秒）
     */
    push(monitorSymbol: string, values: VerificationSampleValues, sampleTimestampMs: number): void {
      const queue = getOrCreateQueue(monitorSymbol);

      const entry: IndicatorCacheEntry = {
        timestamp: sampleTimestampMs,
        values,
      };
      pushToQueue(queue, entry, retentionWindowMs);
    },

    /**
     * 查询指定标的最接近目标时间的延迟验证样本。
     */
    getClosest(monitorSymbol: string, targetTime: number): IndicatorCacheEntry | null {
      const queue = queues.get(monitorSymbol);
      if (!queue || queue.entries.length === 0) return null;

      return findClosestEntry(queue, targetTime);
    },

    /**
     * 清空所有标的的样本队列，用于跨日重置
     */
    clearAll(): void {
      queues.clear();
    },
  };
};
