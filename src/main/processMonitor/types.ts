import type { LastState, MonitorContext } from '../../types/state.js';
import type { Quote } from '../../types/quote.js';
import type { SeatState } from '../../types/seat.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { MarketDataClient } from '../../types/services.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { BuyTaskType, SellTaskType, TaskQueue } from '../asyncProgram/tradeTaskQueue/types.js';

/**
 * monitor 级共享运行时上下文。
 * 类型用途：为 timeDriverProgram 驱动的 processMonitor、seatSync 与 autoSymbolTasks 提供共同依赖边界。
 * 数据来源：由 timeDriverProgram 在每次 tick 内组装。
 * 使用范围：仅 main/processMonitor 时间循环链路使用。
 */
export type MonitorRuntimeContext = Readonly<{
  marketDataClient: MarketDataClient;
  lastState: LastState;
  tradingConfig: MultiMonitorTradingConfig;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
}>;

/**
 * processMonitor 函数参数类型（单标的处理入口的入参）。
 * 类型用途：处理单个监控标的所需的主上下文、监控上下文与运行时标志（门禁、半日市、是否可交易等）。
 * 数据来源：由 timeDriverProgram 按每个 monitorContext 与当前时间等组装传入。
 * 使用范围：仅 processMonitor 及其调用方（timeDriverProgram）使用，内部使用。
 */
export type ProcessMonitorParams = {
  readonly context: MonitorRuntimeContext;
  readonly monitorContext: MonitorContext;
  readonly runtimeFlags: {
    readonly currentTime: Date;
    readonly isHalfDay: boolean;
    readonly canTradeNow: boolean;
    readonly openProtectionActive: boolean;

    /** 交易门禁透传：仅保留运行时门禁快照，不表达 release 语义 */
    readonly isTradingEnabled: boolean;
  };
};

/**
 * AUTO_SYMBOL 任务调度参数。
 * 类型用途：scheduleAutoSymbolTasks 的入参，封装自动换标任务调度所需的监控标的、上下文与状态；距离换标执行时行情统一在状态机内获取。
 * 数据来源：由 processMonitor 从 ProcessMonitorParams、行情与席位等组装传入。
 * 使用范围：仅 processMonitor 内部（autoSymbolTasks）使用。
 */
export type AutoSymbolTasksParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
  mainContext: MonitorRuntimeContext;
  autoSearchEnabled: boolean;
  currentTimeMs: number;
  canTradeNow: boolean;
  openProtectionActive: boolean;
}>;

/**
 * 席位同步参数（同步席位状态函数的入参）。
 * 类型用途：封装 syncSeatState 所需的监控标的、行情与主上下文。
 * 数据来源：由 processMonitor 从当前上下文与行情等组装传入。
 * 使用范围：仅 processMonitor 内部使用。
 */
export type SeatSyncParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
  mainContext: MonitorRuntimeContext;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

/**
 * 无行情席位同步参数。
 * 类型用途：封装 syncSignalSeatState 所需的监控标的与队列上下文。
 * 数据来源：由 businessEventProgram 或 syncSeatState 按当前 monitor 组装。
 * 使用范围：仅 K 线信号链路与 timeDriverProgram 席位同步入口使用。
 */
export type SignalSeatSyncParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
  mainContext: Pick<MonitorRuntimeContext, 'buyTaskQueue' | 'sellTaskQueue' | 'monitorTaskQueue'>;
}>;

/**
 * 席位同步结果（syncSeatState 的返回值）。
 * 类型用途：包含双向席位状态、版本、就绪标志与标的代码，供普通信号流水线使用。
 * 数据来源：由 syncSeatState(SeatSyncParams) 根据 symbolRegistry 计算返回。
 * 使用范围：仅 processMonitor 内部及下游普通信号流水线使用。
 */
export type SeatSyncResult = Readonly<{
  longSeatState: SeatState;
  shortSeatState: SeatState;
  longSeatVersion: number;
  shortSeatVersion: number;
  longSeatActive: boolean;
  shortSeatActive: boolean;
  longSymbol: string;
  shortSymbol: string;
}>;

/**
 * 信号流水线席位信息。
 * 类型用途：封装普通 K 线信号入队前所需的席位身份，不包含行情，确保 K 线信号链路不依赖 quote。
 * 数据来源：由 syncSignalSeatState 根据 symbolRegistry 派生。
 * 使用范围：仅 signalPipeline 使用。
 */
export type SignalSeatInfo = Readonly<{
  longSeatState: SeatState;
  shortSeatState: SeatState;
  longSeatVersion: number;
  shortSeatVersion: number;
  longSeatActive: boolean;
  shortSeatActive: boolean;
  longSymbol: string;
  shortSymbol: string;
}>;
