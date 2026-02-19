import type { IndicatorSnapshot } from '../../../types/quote.js';

/**
 * 指标缓存条目。
 * 类型用途：存储单个时间点的指标快照，供延迟验证时按时间点回溯历史指标值。
 * 数据来源：由 IndicatorCache.push() 创建并存入环形缓冲区。
 * 使用范围：仅 indicatorCache 模块内部使用。
 */
export type IndicatorCacheEntry = {
  /** 记录时间戳（毫秒） */
  readonly timestamp: number;
  /** 指标快照（深拷贝，独立于对象池） */
  readonly snapshot: IndicatorSnapshot;
};

/**
 * 环形缓冲区内部结构。
 * 类型用途：IndicatorCache 实现内部使用的数据结构，固定容量 FIFO，超出时覆盖最旧数据。
 * 数据来源：由 IndicatorCache 实现模块在初始化/运行时维护。
 * 使用范围：仅 indicatorCache 模块内部使用（以 _ 前缀表示内部类型）。
 */
export type _RingBuffer = {
  /** 缓冲区数组 */
  entries: (IndicatorCacheEntry | null)[];
  /** 下一个写入位置的索引 */
  head: number;
  /** 当前有效条目数 */
  size: number;
  /** 缓冲区最大容量 */
  readonly capacity: number;
};

/**
 * 指标缓存配置选项（创建缓存时的参数）。
 * 类型用途：控制环形缓冲区最大容量（maxEntries）。
 * 数据来源：由创建 IndicatorCache 的调用方传入，未传则使用默认值。
 * 使用范围：仅 indicatorCache 模块内部使用。
 */
export type IndicatorCacheOptions = {
  /** 最大缓存条目数，默认 100 */
  readonly maxEntries?: number;
};

/**
 * 指标缓存行为契约。
 * 类型用途：供 DelayedSignalVerifier 等回溯历史指标（getAt），由主程序按监控标的创建并注入。
 * 数据来源：主程序创建，indicatorCache 模块实现；push 数据来自行情/指标流水线。
 * 使用范围：mainProgram、delayedSignalVerifier、lifecycle 等使用，仅内部使用。
 */
export interface IndicatorCache {
  /**
   * 推送新的指标快照
   * @param monitorSymbol 监控标的代码
   * @param snapshot 指标快照
   */
  push(monitorSymbol: string, snapshot: IndicatorSnapshot): void;

  /**
   * 获取最接近目标时间的缓存条目
   * @param monitorSymbol 监控标的代码
   * @param targetTime 目标时间戳（毫秒）
   * @param toleranceMs 容忍度（毫秒）
   * @returns 最接近的缓存条目，若无匹配则返回 null
   */
  getAt(monitorSymbol: string, targetTime: number, toleranceMs: number): IndicatorCacheEntry | null;

  /**
   * 清除所有缓存
   */
  clearAll(): void;
}
