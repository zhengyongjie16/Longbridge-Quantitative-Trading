import type { MonitorContext } from '../../types/state.js';
import type { IndicatorSnapshot, Quote } from '../../types/quote.js';
import type { Position } from '../../types/account.js';
import type { SeatState } from '../../types/seat.js';
import type { Signal } from '../../types/signal.js';
import type { MainProgramContext } from '../mainProgram/types.js';

/**
 * processMonitor 函数参数类型（单标的处理入口的入参）。
 * 类型用途：处理单个监控标的所需的主上下文、监控上下文与运行时标志（门禁、半日市、是否可交易等）。
 * 数据来源：由 mainProgram 主循环按每个 monitorContext 与当前时间等组装传入。
 * 使用范围：仅 processMonitor 及其调用方（mainProgram）使用，内部使用。
 */
export type ProcessMonitorParams = {
  readonly context: MainProgramContext;
  readonly monitorContext: MonitorContext;
  readonly runtimeFlags: {
    readonly currentTime: Date;
    readonly isHalfDay: boolean;
    readonly canTradeNow: boolean;
    readonly openProtectionActive: boolean;
    /** 交易门禁透传：false 时不入队，直接释放信号 */
    readonly isTradingEnabled: boolean;
  };
};

/**
 * 队列清理结果。
 * 类型用途：clearQueuesForDirection 等队列清理函数的返回结果，供主程序或调用方统计移除数量。
 * 数据来源：由 clearQueuesForDirection(params) 计算并返回。
 * 使用范围：仅 processMonitor 内部及 seatSync 等调用方使用。
 */
export type QueueClearResult = Readonly<{
  removedDelayed: number;
  removedBuy: number;
  removedSell: number;
  removedMonitorTasks: number;
}>;

/**
 * AUTO_SYMBOL 任务调度参数。
 * 类型用途：scheduleAutoSymbolTasks 的入参，封装自动换标任务调度所需的监控标的、上下文、行情与状态。
 * 数据来源：由 processMonitor 从 ProcessMonitorParams、行情与席位等组装传入。
 * 使用范围：仅 processMonitor 内部（autoSymbolTasks）使用。
 */
export type AutoSymbolTasksParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
  mainContext: MainProgramContext;
  autoSearchEnabled: boolean;
  currentTimeMs: number;
  canTradeNow: boolean;
  monitorPriceChanged: boolean;
  resolvedMonitorPrice: number | null;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

/**
 * 席位同步参数（同步席位信息函数的入参）。
 * 类型用途：封装 syncSeatInfo 所需的监控标的、行情、主上下文及信号/持仓释放回调。
 * 数据来源：由 processMonitor 从当前上下文与行情等组装传入。
 * 使用范围：仅 processMonitor 内部使用。
 */
export type SeatSyncParams = Readonly<{
  monitorSymbol: string;
  monitorQuote: Quote | null;
  monitorContext: MonitorContext;
  mainContext: MainProgramContext;
  quotesMap: ReadonlyMap<string, Quote | null>;
  releaseSignal: (signal: Signal) => void;
}>;

/**
 * 席位同步结果（syncSeatInfo 的返回值）。
 * 类型用途：包含双向席位状态、版本、就绪标志、标的与行情，供信号流水线与风险任务等使用。
 * 数据来源：由 syncSeatInfo(SeatSyncParams) 根据 symbolRegistry 与行情计算返回。
 * 使用范围：仅 processMonitor 内部及下游流水线使用。
 */
export type SeatSyncResult = Readonly<{
  longSeatState: SeatState;
  shortSeatState: SeatState;
  longSeatVersion: number;
  shortSeatVersion: number;
  longSeatReady: boolean;
  shortSeatReady: boolean;
  longSymbol: string;
  shortSymbol: string;
  longQuote: Quote | null;
  shortQuote: Quote | null;
}>;

/**
 * 风险任务调度参数（调度强平距离/浮亏检查等监控任务时的入参）。
 * 类型用途：封装调度 LIQUIDATION_DISTANCE_CHECK、UNREALIZED_LOSS_CHECK 等任务所需的上下文与席位信息。
 * 数据来源：由 processMonitor 从 ProcessMonitorParams、seatInfo 等组装。
 * 使用范围：仅 processMonitor 内部使用。
 */
export type RiskTasksParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
  mainContext: MainProgramContext;
  seatInfo: SeatSyncResult;
  autoSearchEnabled: boolean;
  monitorPriceChanged: boolean;
  resolvedMonitorPrice: number | null;
  monitorCurrentPrice: number | null;
}>;

/**
 * 指标流水线参数（执行指标计算与缓存推送时的入参）。
 * 类型用途：封装指标流水线所需的监控标的、监控上下文、主上下文与行情。
 * 数据来源：由 processMonitor 从 ProcessMonitorParams、seatInfo 等组装。
 * 使用范围：仅 processMonitor 内部使用。
 */
export type IndicatorPipelineParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
  mainContext: MainProgramContext;
  monitorQuote: Quote | null;
}>;

/**
 * 信号流水线参数（执行信号生成、延迟验证入队等时的入参）。
 * 类型用途：封装信号流水线所需的监控标的、上下文、席位信息、指标快照与释放回调。
 * 数据来源：由 processMonitor 从 ProcessMonitorParams、seatInfo、指标流水线输出等组装。
 * 使用范围：仅 processMonitor 内部使用。
 */
export type SignalPipelineParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
  mainContext: MainProgramContext;
  runtimeFlags: ProcessMonitorParams['runtimeFlags'];
  seatInfo: SeatSyncResult;
  monitorSnapshot: IndicatorSnapshot;
  releaseSignal: (signal: Signal) => void;
  releasePosition: (position: Position) => void;
}>;
