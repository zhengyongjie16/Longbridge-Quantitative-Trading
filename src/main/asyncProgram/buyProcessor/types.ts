import type { MonitorContext, LastState } from '../../../types/state.js';
import type { Trader } from '../../../types/services.js';
import type { TaskQueue, BuyTaskType } from '../tradeTaskQueue/types.js';
import type { SignalProcessor } from '../../../core/signalProcessor/types.js';
import type { DoomsdayProtection } from '../../../core/doomsdayProtection/types.js';

/**
 * 买入处理器依赖类型
 *
 * 通过依赖注入获取所需的外部服务和上下文
 */
export type BuyProcessorDeps = {
  /** 买入任务队列 */
  readonly taskQueue: TaskQueue<BuyTaskType>;
  /** 获取监控上下文的函数 */
  readonly getMonitorContext: (monitorSymbol: string) => MonitorContext | undefined;
  /** 信号处理器（风险检查） */
  readonly signalProcessor: SignalProcessor;
  /** 交易执行器 */
  readonly trader: Trader;
  /** 末日保护模块 */
  readonly doomsdayProtection: DoomsdayProtection;
  /** 获取全局状态的函数 */
  readonly getLastState: () => LastState;
  /** 获取是否半日市的函数 */
  readonly getIsHalfDay: () => boolean;
  /** 生命周期门禁：false 时跳过任务执行 */
  readonly getCanProcessTask?: () => boolean;
};
