/**
 * Program 模块共享类型定义
 */

import type { BuyTask, SellTask, TaskQueue } from './tradeTaskQueue/types.js';

/**
 * 处理器统计信息（买入/卖出处理器共用）
 */
export type ProcessorStats = {
  readonly processedCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly lastProcessTime: number | null;
};

/**
 * 买入任务队列接口
 */
export type BuyTaskQueue = TaskQueue<BuyTask>;

/**
 * 卖出任务队列接口
 */
export type SellTaskQueue = TaskQueue<SellTask>;
