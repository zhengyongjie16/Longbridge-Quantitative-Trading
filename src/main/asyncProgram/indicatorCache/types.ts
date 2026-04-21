import type { VerificationIndicator } from '../../../types/indicatorProfile.js';

/**
 * 延迟验证样本点。
 * 类型用途：表示单个验证指标在某个采样时刻的三态结果。
 * 数据来源：由 timeDriverProgram 基于 lastMonitorSnapshot 投影生成。
 * 使用范围：indicatorCache 与 delayedSignalVerifier 内部使用。
 */
export type VerificationSamplePoint =
  | Readonly<{ kind: 'value'; value: number }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid' }>;

/**
 * 延迟验证样本值映射。
 * 类型用途：按验证指标名保存单个采样时刻的三态值，供延迟验证直接消费。
 * 数据来源：由 timeDriverProgram 基于 lastMonitorSnapshot 和 verificationIndicators 投影生成。
 * 使用范围：indicatorCache 与 delayedSignalVerifier 内部使用。
 */
export type VerificationSampleValues = Readonly<
  Partial<Record<VerificationIndicator, VerificationSamplePoint>>
>;

/**
 * 延迟验证样本条目。
 * 类型用途：存储单个时间点的延迟验证最小样本，供延迟验证按时间点回溯历史值。
 * 数据来源：由 IndicatorCache.push() 创建并存入环形缓冲区。
 * 使用范围：仅 indicatorCache 模块内部使用。
 */
export type IndicatorCacheEntry = {
  /** 记录时间戳（毫秒） */
  readonly timestamp: number;

  /** 延迟验证样本值 */
  readonly values: VerificationSampleValues;
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
 * 数据来源：主程序创建，indicatorCache 模块实现；push 数据来自 timeDriverProgram 的 tick 采样。
 * 使用范围：timeDriverProgram、delayedSignalVerifier、lifecycle 等使用，仅内部使用。
 */
export interface IndicatorCache {
  /**
   * 推送新的延迟验证样本。
   * @param monitorSymbol 监控标的代码
   * @param values 延迟验证三态样本
   * @param sampleTimestampMs 采样时间戳（毫秒）
   */
  push: (
    monitorSymbol: string,
    values: VerificationSampleValues,
    sampleTimestampMs: number,
  ) => void;

  /**
   * 获取最接近目标时间的延迟验证样本条目。
   * @param monitorSymbol 监控标的代码
   * @param targetTime 目标时间戳（毫秒）
   * @param toleranceMs 容忍度（毫秒）
   * @returns 最接近的样本条目，若无匹配则返回 null
   */
  getAt: (
    monitorSymbol: string,
    targetTime: number,
    toleranceMs: number,
  ) => IndicatorCacheEntry | null;

  /**
   * 清除所有缓存
   */
  clearAll: () => void;
}
