import type { MonitorContext, LastState } from '../../../types/state.js';
import type { Trader } from '../../../types/services.js';
import type { RefreshGate } from '../../../utils/types.js';
import type { TaskQueue, SellTaskType } from '../tradeTaskQueue/types.js';
import type { SignalProcessor } from '../../../core/signalProcessor/types.js';

/**
 * 卖出处理器依赖类型（创建 SellProcessor 时的参数）。
 * 类型用途：创建 SellProcessor 时的依赖注入对象，包含任务队列、监控上下文、信号处理器、交易执行器等。
 * 数据来源：由主程序/启动流程在创建 SellProcessor 时组装并传入工厂。
 * 使用范围：仅 sellProcessor 及启动流程使用，内部使用。
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
