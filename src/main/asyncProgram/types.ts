/**
 * asyncProgram 模块共享类型定义
 *
 * 本模块提供异步交易处理的公共类型，包括：
 * - Processor: 处理器通用接口（start/stop）
 * - BaseProcessorConfig: 基础任务处理器配置
 * - BuyTaskQueue / SellTaskQueue: 任务队列类型别名
 */
import type { Signal } from '../../types/index.js';
import type { BuyTaskType, SellTaskType, Task, TaskQueue } from './tradeTaskQueue/types.js';

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

/**
 * 基础任务处理器配置
 * @template TType 任务类型字符串字面量
 */
export type BaseProcessorConfig<TType extends string> = {
  /** 日志前缀（如 BuyProcessor、SellProcessor） */
  readonly loggerPrefix: string;
  /** 任务队列 */
  readonly taskQueue: TaskQueue<TType>;
  /** 处理单个任务的异步函数 */
  readonly processTask: (task: Task<TType>) => Promise<boolean>;
  /** 任务完成后释放资源的回调（如释放信号到对象池） */
  readonly releaseAfterProcess: (signal: Signal) => void;
};
