/**
 * asyncProgram 模块共享类型定义
 *
 * 本模块提供异步交易处理的公共类型，包括：
 * - Processor: 处理器通用接口（start/stop）
 * - BuyTaskQueue / SellTaskQueue: 任务队列类型别名
 */
import type { BuyTaskType, SellTaskType, TaskQueue } from './tradeTaskQueue/types.js';

/**
 * 处理器通用接口
 */
export interface Processor {
  /** 启动处理器，开始消费任务队列 */
  start(): void;
  /** 停止处理器 */
  stop(): void;
}

/** 买入任务队列类型别名 */
export type BuyTaskQueue = TaskQueue<BuyTaskType>;

/** 卖出任务队列类型别名 */
export type SellTaskQueue = TaskQueue<SellTaskType>;
