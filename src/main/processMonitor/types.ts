import type { MonitorContext } from '../../types/state.js';
import type { SeatState } from '../../types/seat.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../asyncProgram/monitorTaskProcessor/types.js';

/**
 * monitor 级共享运行时上下文。
 * 类型用途：为 timeDriverProgram 驱动的 processMonitor 与 autoSymbolTasks 提供共同依赖边界。
 * 数据来源：由 timeDriverProgram 在每次 tick 内组装。
 * 使用范围：仅 main/processMonitor 时间循环链路使用。
 */
export type MonitorRuntimeContext = Readonly<{
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
}>;

/**
 * processMonitor 函数参数类型（单标的处理入口的入参）。
 * 类型用途：处理单个监控标的所需的任务队列、监控上下文与当前时间。
 * 数据来源：由 timeDriverProgram 按每个 monitorContext 与当前时间组装传入。
 * 使用范围：仅 processMonitor 及其调用方（timeDriverProgram）使用，内部使用。
 */
export type ProcessMonitorParams = {
  readonly context: MonitorRuntimeContext;
  readonly monitorContext: MonitorContext;
  readonly currentTime: Date;
};

/**
 * AUTO_SYMBOL 任务调度参数。
 * 类型用途：scheduleAutoSymbolTasks 的入参，封装自动换标任务调度所需的监控标的、上下文与状态；距离换标执行时行情统一在状态机内获取。
 * 数据来源：由 processMonitor 从 ProcessMonitorParams 与席位状态组装传入。
 * 使用范围：仅 processMonitor 内部（autoSymbolTasks）使用。
 */
export type AutoSymbolTasksParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
  mainContext: MonitorRuntimeContext;
  autoSearchEnabled: boolean;
  currentTimeMs: number;
}>;

/**
 * 普通信号席位投影参数。
 * 类型用途：封装 resolveSignalSeatInfo 所需的监控标的与监控上下文。
 * 数据来源：由 businessEventProgram 按当前 monitor 组装。
 * 使用范围：仅 K 线信号链路使用。
 */
export type SignalSeatProjectionParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
}>;

/**
 * 信号流水线席位信息。
 * 类型用途：封装普通 K 线信号入队前所需的席位身份，不包含行情，确保 K 线信号链路不依赖 quote。
 * 数据来源：由 resolveSignalSeatInfo 根据 symbolRegistry 派生。
 * 使用范围：仅 signalPipeline 使用。
 */
export type SignalSeatInfo = Readonly<{
  longSeatState: SeatState;
  shortSeatState: SeatState;
  longSeatVersion: number;
  shortSeatVersion: number;
  longSymbol: string;
  shortSymbol: string;
}>;
