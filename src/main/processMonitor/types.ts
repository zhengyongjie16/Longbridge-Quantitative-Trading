/**
 * @module processMonitor/types
 * @description processMonitor 模块的类型定义
 *
 * 定义单个监控标的处理所需的参数类型
 */
import type { MonitorContext } from '../../types/state.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { SeatState } from '../../types/seat.js';
import type { Signal } from '../../types/signal.js';
import type { MainProgramContext } from '../mainProgram/types.js';

/**
 * processMonitor 函数参数类型
 *
 * 包含处理单个监控标的所需的所有依赖：
 * - monitorContext: 当前监控标的的上下文（配置、状态、策略等）
 * - 外部服务：marketDataClient、trader、marketMonitor 等
 * - 运行状态：currentTime、isHalfDay、canTradeNow、openProtectionActive
 * - 异步架构：indicatorCache、buyTaskQueue、sellTaskQueue
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
 * 队列清理结果
 */
export type QueueClearResult = Readonly<{
  removedDelayed: number;
  removedBuy: number;
  removedSell: number;
  removedMonitorTasks: number;
}>;

/**
 * AUTO_SYMBOL 任务调度参数
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
 * 席位同步参数
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
 * 席位同步结果
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
 * 风险任务调度参数
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
 * 指标流水线参数
 */
export type IndicatorPipelineParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
  mainContext: MainProgramContext;
  monitorQuote: Quote | null;
}>;

/**
 * 信号流水线参数
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
