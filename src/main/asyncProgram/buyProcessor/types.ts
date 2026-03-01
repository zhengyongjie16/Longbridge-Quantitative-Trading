import type { MonitorContext, LastState } from '../../../types/state.js';
import type { Trader } from '../../../types/services.js';
import type { TaskQueue, BuyTaskType } from '../tradeTaskQueue/types.js';
import type { SignalProcessor } from '../../../core/signalProcessor/types.js';
import type { DoomsdayProtection } from '../../../core/doomsdayProtection/types.js';

/**
 * 买入处理器依赖类型（创建 BuyProcessor 时的参数）。
 * 类型用途：创建 BuyProcessor 时的依赖注入对象，包含任务队列、监控上下文、信号处理器、交易执行器、末日保护等。
 * 数据来源：由主程序/启动流程在创建 BuyProcessor 时组装并传入工厂。
 * 使用范围：仅 buyProcessor 及启动流程使用，内部使用。
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
