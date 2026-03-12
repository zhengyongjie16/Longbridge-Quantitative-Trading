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
 * 重置方向分段的参数。
 * 类型用途：lossOffsetLifecycleCoordinator 在冷却过期后调用 resetDirectionSegment 时传入。
 * 数据来源：由冷却过期事件转换而来。
 * 使用范围：风险控制生命周期协同；全项目可引用。
 */
export type ResetDirectionSegmentParams = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';

  /** 新分段起始时间（冷却结束时间），后续成交必须 >= 此时间才纳入偏移计算 */
  readonly segmentStartMs: number;

  /** 冷却结束时间（用于幂等保护，同一值重复调用无效） */
  readonly cooldownEndMs: number;
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

  /**
   * 使用完整订单列表重新计算当日状态，作为启动初始化或纠偏手段。
   * segmentStartByDirection 可选：按 "monitorSymbol:direction" 为键提供分段起始时间，
   * 仅计入 executedTimeMs >= segmentStartMs 的成交。
   */
  recalculateFromAllOrders: (
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
    now: Date,
    segmentStartByDirection?: ReadonlyMap<string, number>,
  ) => void;

  /** 增量记录单笔成交，仅接受 executedTimeMs >= 当前分段起始时间 且 当日日键匹配的订单 */
  recordFilledOrder: (input: DailyLossFilledOrderInput) => void;

  /** 获取指定标的与方向的当日亏损偏移（仅亏损，<=0），未初始化时返回 0 */
  getLossOffset: (monitorSymbol: string, isLongSymbol: boolean) => number;

  /**
   * 重置指定 monitor+direction 的分段：清空旧段订单与偏移，设置新分段起始时间。
   * 幂等：同一 cooldownEndMs 重复调用不产生副作用。
   */
  resetDirectionSegment: (params: ResetDirectionSegmentParams) => void;
}

/**
 * 浮亏监控上下文。
 * 类型用途：UnrealizedLossMonitor.monitorUnrealizedLoss 的入参，封装行情、检查器与交易依赖。
 * 数据来源：主循环与监控任务处理器组装传入。
 * 使用范围：风险控制与监控任务链路；全项目可引用。
 */
export type UnrealizedLossMonitorContext = {
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly monitorSymbol: string;
  readonly riskChecker: RiskChecker;
  readonly trader: Trader;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
};

/**
 * 浮亏监控器接口。
 * 类型用途：依赖注入，由 riskController 模块实现，主循环调用以监控做多/做空浮亏并触发保护性清仓。
 * 数据来源：由 riskController 模块实现并注入。
 * 使用范围：主程序、监控任务处理器、MonitorContext；全项目可引用。
 */
export interface UnrealizedLossMonitor {
  /**
   * 监控做多和做空标的的浮亏。
   * @param context 浮亏监控上下文
   */
  monitorUnrealizedLoss: (context: UnrealizedLossMonitorContext) => Promise<void>;
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
