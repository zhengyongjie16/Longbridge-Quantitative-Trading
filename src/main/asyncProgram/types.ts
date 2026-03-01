import type { Signal } from '../../types/signal.js';
import type { Task, TaskQueue } from './tradeTaskQueue/types.js';

/**
 * 处理器通用接口（行为契约）。
 * 类型用途：供主程序/启动流程统一调度买卖处理器与监控任务处理器（start/stop/stopAndDrain/restart）。
 * 数据来源：由 BuyProcessor、SellProcessor、MonitorTaskProcessor 等实现并注入。
 * 使用范围：mainProgram、lifecycle 等持有并调用，仅内部使用。
 */
export interface Processor {
  /** 启动处理器，开始消费任务队列 */
  start: () => void;

  /** 停止处理器 */
  stop: () => void;

  /** 停止并等待在途任务完成 */
  stopAndDrain: () => Promise<void>;

  /** 重启处理器（先 stop 后 start） */
  restart: () => void;
}

/**
 * 基础任务处理器配置（创建处理器时的参数）。
 * 类型用途：依赖注入用配置，供 createBuyProcessor / createSellProcessor / createMonitorTaskProcessor 等消费。
 * 数据来源：由主程序/启动流程根据 taskQueue、processTask、releaseAfterProcess 等组装传入。
 * 使用范围：仅 asyncProgram 子模块内部使用。
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
