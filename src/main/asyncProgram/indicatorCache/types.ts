/**
 * IndicatorCache 模块类型定义
 *
 * 指标缓存使用环形缓冲区存储每秒的指标快照，
 * 供延迟信号验证器查询历史数据。
 */

import type { IndicatorSnapshot } from '../../../types/index.js';

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
 * 环形缓冲区内部结构（内部类型）
 *
 * 使用环形缓冲区实现固定容量的 FIFO 缓存，
 * 超出容量时自动覆盖最旧的数据。
 *
 * 注意：此类型不使用 readonly，因为需要在运行时修改
 */
export type _RingBuffer = {
  /** 缓冲区数组 */
  entries: (IndicatorCacheEntry | null)[];
  /** 下一个写入位置的索引 */
  head: number;
  /** 当前有效条目数 */
  size: number;
  /** 缓冲区最大容量 */
  capacity: number;
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
   * 获取最新的缓存条目
   * @param monitorSymbol 监控标的代码
   * @returns 最新的缓存条目，若无数据则返回 null
   */
  getLatest(monitorSymbol: string): IndicatorCacheEntry | null;

  /**
   * 获取时间范围内的所有缓存条目
   * @param monitorSymbol 监控标的代码
   * @param startTime 开始时间戳（毫秒）
   * @param endTime 结束时间戳（毫秒）
   * @returns 时间范围内的缓存条目数组（按时间升序）
   */
  getRange(monitorSymbol: string, startTime: number, endTime: number): IndicatorCacheEntry[];

  /**
   * 清除指定标的的缓存
   * @param monitorSymbol 监控标的代码
   */
  clear(monitorSymbol: string): void;

  /**
   * 清除所有缓存
   */
  clearAll(): void;
}
