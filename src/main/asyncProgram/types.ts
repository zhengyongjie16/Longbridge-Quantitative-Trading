import type { Signal } from '../../types/signal.js';
import type { Task, TaskQueue } from './tradeTaskQueue/types.js';

/**
 * 处理器通用接口
 */
export interface Processor {
  /** 启动处理器，开始消费任务队列 */
  start(): void;
  /** 停止处理器 */
  stop(): void;
  /** 停止并等待在途任务完成 */
  stopAndDrain(): Promise<void>;
  /** 重启处理器（先 stop 后 start） */
  restart(): void;
}

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
  /** 可选：是否可处理任务的门禁，false 时仅释放并跳过 */
  readonly getCanProcessTask?: () => boolean;
};
