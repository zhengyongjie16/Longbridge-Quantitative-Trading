/**
 * IndicatorCache 模块类型定义
 *
 * 指标缓存使用环形缓冲区存储每秒的指标快照，
 * 供延迟信号验证器查询历史数据。
 */
import type { IndicatorSnapshot } from '../../../types/quote.js';

/**
 * 指标缓存条目
 */
export type IndicatorCacheEntry = {
  /** 记录时间戳（毫秒） */
  readonly timestamp: number;
  /** 指标快照（深拷贝，独立于对象池） */
  readonly snapshot: IndicatorSnapshot;
};

/**
 * 环形缓冲区内部结构（仅模块内使用）
 *
 * 使用环形缓冲区实现固定容量的 FIFO 缓存，
 * 超出容量时自动覆盖最旧的数据。
 *
 * @remarks capacity 使用 readonly 保证容量不变，其他字段需要在运行时修改
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
 * 指标缓存配置选项
 */
export type IndicatorCacheOptions = {
  /** 最大缓存条目数，默认 100 */
  readonly maxEntries?: number;
};

/**
 * 指标缓存行为契约
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
