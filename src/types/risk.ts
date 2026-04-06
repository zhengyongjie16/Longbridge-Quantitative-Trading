import type { OrderSide } from 'longbridge';
import type { MonitorConfig } from './config.js';
import type { Quote } from './quote.js';
import type {
  OrderRecord,
  OrderRecorder,
  RawOrderFromAPI,
  RiskChecker,
  Trader,
} from './services.js';
import type { OrderFilteringEngine, OrderOwnership } from './orderRecorder.js';

/**
 * 成交回报输入。
 * 类型用途：用于 DailyLossTracker.recordFilledOrder 增量记录单笔成交。
 * 数据来源：OrderMonitor 成交回调，仅在当日日键匹配时写入。
 * 使用范围：风险控制与订单监控链路；全项目可引用。
 */
export type DailyLossFilledOrderInput = {
  readonly monitorSymbol: string;
  readonly symbol: string;
  readonly isLongSymbol: boolean;
  readonly side: OrderSide;
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTimeMs: number;
  readonly orderId?: string | null;
};

/**
 * 开启保护性清仓新周期参数。
 * 类型用途：保护性清仓业务事件完成后推进偏移边界并清空旧周期状态。
 * 数据来源：成交后一致性运行时在保护性清仓完成确认后传入。
 * 使用范围：风险控制链路；全项目可引用。
 */
export type StartNewProtectionEpisodeParams = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';

  /** 最近一次已完成保护性清仓事件边界（毫秒） */
  readonly boundaryExecutedTimeMs: number;
};

/**
 * 当日亏损追踪器接口。
 * 类型用途：按监控标的与方向维护已实现盈亏偏移，供浮亏刷新、成交处理与生命周期重建共享。
 * 数据来源：由 riskController 模块实现并注入。
 * 使用范围：主程序、生命周期、订单监控、浮亏监控；全项目可引用。
 */
export interface DailyLossTracker {
  /** 显式重置 dayKey 与 states（含分段元数据） */
  resetAll: (now: Date) => void;

  /** 使用完整订单列表重新计算当日状态，作为启动初始化或纠偏手段。 */
  recalculateFromAllOrders: (
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
    now: Date,
    protectionBoundaryByDirection?: ReadonlyMap<string, number>,
  ) => void;

  /** 增量记录单笔成交，仅接受 executedTimeMs > 当前保护性边界 且 当日日键匹配的订单 */
  recordFilledOrder: (input: DailyLossFilledOrderInput) => void;

  /** 获取指定标的与方向的当日亏损偏移（仅亏损，<=0），未初始化时返回 0 */
  getLossOffset: (monitorSymbol: string, isLongSymbol: boolean) => number;

  /** 推进保护性边界并开启新周期（幂等且只允许边界单向前进）。 */
  startNewProtectionEpisode: (params: StartNewProtectionEpisodeParams) => void;
}

/**
 * 单方向浮亏监控上下文。
 * 类型用途：TradingRiskEventRuntime 调用单方向浮亏执行器时的入参，只携带当前命中的方向与 seatVersion。
 * 数据来源：由 tradingRiskEventRuntime 基于 symbolRegistry 路由与 quote push 事件组装传入。
 * 使用范围：风险控制与事件驱动浮亏链路；全项目可引用。
 */
export type DirectionalUnrealizedLossMonitorContext = {
  readonly symbol: string;
  readonly isLong: boolean;
  readonly monitorSymbol: string;
  readonly seatVersion: number;
  readonly quote: Quote;
  readonly riskChecker: RiskChecker;
  readonly trader: Trader;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
};

/**
 * 浮亏监控器接口。
 * 类型用途：依赖注入，由 riskController 模块实现，供事件驱动浮亏链路按单方向执行保护性清仓。
 * 数据来源：由 riskController 模块实现并注入。
 * 使用范围：TradingRiskEventRuntime 与 MonitorContext；全项目可引用。
 */
export interface UnrealizedLossMonitor {
  /**
   * 监控单方向标的的浮亏。
   * @param context 单方向浮亏监控上下文
   */
  monitorDirectionalUnrealizedLoss: (
    context: DirectionalUnrealizedLossMonitorContext,
  ) => Promise<void>;
}

/**
 * 当日亏损追踪器依赖注入类型。
 * 类型用途：创建 DailyLossTracker 时约束过滤算法、归属解析与订单转换依赖。
 * 数据来源：由启动层在组装 riskController 子模块时传入。
 * 使用范围：riskController 模块内部创建流程；全项目可引用。
 */
export type DailyLossTrackerDeps = {
  readonly filteringEngine: OrderFilteringEngine;
  readonly resolveOrderOwnership: (
    order: RawOrderFromAPI,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
  ) => OrderOwnership | null;
  readonly classifyAndConvertOrders: (orders: ReadonlyArray<RawOrderFromAPI>) => {
    buyOrders: ReadonlyArray<OrderRecord>;
    sellOrders: ReadonlyArray<OrderRecord>;
  };
  readonly toHongKongTimeIso: (date: Date | null) => string;
};
