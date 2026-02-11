/**
 * SellProcessor 模块类型定义
 *
 * 定义卖出处理器的接口契约和依赖注入类型
 */
import type { MonitorContext, Trader, LastState } from '../../../types/index.js';
import type { RefreshGate } from '../../../utils/refreshGate/types.js';
import type { TaskQueue, SellTaskType } from '../tradeTaskQueue/types.js';
import type { SignalProcessor } from '../../../core/signalProcessor/types.js';

/**
 * 卖出处理器依赖类型
 *
 * 通过依赖注入获取所需的外部服务和上下文
 */
export type SellProcessorDeps = {
  /** 卖出任务队列 */
  readonly taskQueue: TaskQueue<SellTaskType>;
  /** 获取监控上下文的函数 */
  readonly getMonitorContext: (monitorSymbol: string) => MonitorContext | undefined;
  /** 信号处理器（计算卖出数量） */
  readonly signalProcessor: SignalProcessor;
  /** 交易执行器 */
  readonly trader: Trader;
  /** 获取全局状态的函数 */
  readonly getLastState: () => LastState;
  /** 刷新门禁（等待缓存刷新） */
  readonly refreshGate: RefreshGate;
  /** 生命周期门禁：false 时跳过任务执行 */
  readonly getCanProcessTask?: () => boolean;
};
