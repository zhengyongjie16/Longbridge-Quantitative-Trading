import type { VerificationIndicator } from '../../../types/indicatorProfile.js';

/**
 * 延迟验证样本点。
 * 类型用途：表示单个验证指标在某个采样时刻的三态结果。
 * 数据来源：由上游业务事件采样方基于最新 monitorSnapshot 投影生成。
 * 使用范围：indicatorCache 与 delayedSignalVerifier 内部使用。
 */
export type VerificationSamplePoint =
  | Readonly<{ kind: 'value'; value: number }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid' }>;

/**
 * 延迟验证样本值映射。
 * 类型用途：按验证指标名保存单个采样时刻的三态值，供延迟验证直接消费。
 * 数据来源：由上游业务事件采样方基于最新 monitorSnapshot 和 verificationIndicators 投影生成。
 * 使用范围：indicatorCache 与 delayedSignalVerifier 内部使用。
 */
export type VerificationSampleValues = Readonly<
  Partial<Record<VerificationIndicator, VerificationSamplePoint>>
>;

/**
 * 延迟验证样本条目。
 * 类型用途：存储单个时间点的延迟验证最小样本，供延迟验证按时间点回溯历史值。
 * 数据来源：由 IndicatorCache.push() 创建并存入时间窗口队列。
 * 使用范围：仅 indicatorCache 模块内部使用。
 */
export type IndicatorCacheEntry = {
  /** 记录时间戳（毫秒） */
  readonly timestamp: number;

  /** 延迟验证样本值 */
  readonly values: VerificationSampleValues;
};

/**
 * 时间窗口样本队列内部结构。
 * 类型用途：IndicatorCache 实现内部使用的数据结构，按时间升序保存保留窗口内的样本。
 * 数据来源：由 IndicatorCache 实现模块在初始化/运行时维护。
 * 使用范围：仅 indicatorCache 模块内部使用（以 _ 前缀表示内部类型）。
 */
export type _SampleQueue = {
  /** 当前保留的样本队列，按时间升序排列 */
  entries: IndicatorCacheEntry[];
};

/**
 * 指标缓存配置选项（创建缓存时的参数）。
 * 类型用途：控制单个标的的样本保留时间窗口。
 * 数据来源：由创建 IndicatorCache 的调用方传入，未传则使用默认值。
 * 使用范围：仅 indicatorCache 模块内部使用。
 */
export type IndicatorCacheOptions = {
  /** 样本保留时间窗口（毫秒），默认 100000 */
  readonly retentionWindowMs?: number;
};

/**
 * 指标缓存行为契约。
 * 类型用途：供 DelayedSignalVerifier 等回溯历史指标（getClosest），由运行时按监控标的创建并注入。
 * 数据来源：运行时创建，indicatorCache 模块实现；push 数据来自上游业务事件采样链路。
 * 使用范围：上游业务事件采样链路、delayedSignalVerifier、lifecycle 等使用，仅内部使用。
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
   * @returns 最接近的样本条目，若无可用样本则返回 null
   */
  getClosest: (monitorSymbol: string, targetTime: number) => IndicatorCacheEntry | null;

  /**
   * 清除所有缓存
   */
  clearAll: () => void;
}
