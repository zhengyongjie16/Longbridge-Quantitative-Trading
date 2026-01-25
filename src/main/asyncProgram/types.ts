/**
 * asyncProgram 模块共享类型定义
 *
 * 本模块提供异步交易处理的公共类型，包括：
 * - ProcessorStats: 处理器统计信息（买入/卖出处理器共用）
 * - BuyTaskQueue / SellTaskQueue: 任务队列类型别名
 */

import type { BuyTask, SellTask, TaskQueue } from './tradeTaskQueue/types.js';

/** 处理器统计信息（买入/卖出处理器共用） */
export type ProcessorStats = {
  /** 已处理任务总数 */
  readonly processedCount: number;
  /** 处理成功数 */
  readonly successCount: number;
  /** 处理失败数 */
  readonly failedCount: number;
  /** 最后处理时间戳（毫秒），未处理过则为 null */
  readonly lastProcessTime: number | null;
};

/**
 * 处理器通用接口
 */
export interface Processor {
  /** 启动处理器，开始消费任务队列 */
  start(): void;
  /** 停止处理器 */
  stop(): void;
  /** 立即处理队列中所有任务（同步等待完成） */
  processNow(): Promise<void>;
  /** 检查处理器是否正在运行 */
  isRunning(): boolean;
  /** 获取处理器统计信息 */
  getStats(): ProcessorStats;
}

/** 买入任务队列类型别名 */
export type BuyTaskQueue = TaskQueue<BuyTask>;

/** 卖出任务队列类型别名 */
export type SellTaskQueue = TaskQueue<SellTask>;
