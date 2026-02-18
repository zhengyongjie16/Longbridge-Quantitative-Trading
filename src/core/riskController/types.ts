import type { Position } from '../../types/account.js';
import type { Signal, SignalType } from '../../types/signal.js';
import type { Quote } from '../../types/quote.js';
import type { MonitorConfig } from '../../types/config.js';
import type {
  MarketDataClient,
  OrderRecorder,
  OrderRecord,
  RawOrderFromAPI,
  RiskChecker,
  Trader,
  WarrantType,
  RiskCheckResult,
  WarrantDistanceInfo,
  WarrantDistanceLiquidationResult,
  WarrantRefreshResult,
  UnrealizedLossData,
  UnrealizedLossCheckResult,
} from '../../types/services.js';
import type { OrderFilteringEngine, OrderOwnership } from '../orderRecorder/types.js';
import type { Decimal, NaiveDate, OrderSide, WarrantType as SDKWarrantType } from 'longport';

/**
 * 牛熊证报价
 * @see LongPort SDK QuoteContext.warrantQuote() 返回类型
 */
export type WarrantQuote = {
  /** 证券代码 */
  readonly symbol: string | null;
  /** 最新价 */
  readonly lastDone: Decimal | null;
  /** 昨收价 */
  readonly prevClose: Decimal | null;
  /** 开盘价 */
  readonly open: Decimal | null;
  /** 最高价 */
  readonly high: Decimal | null;
  /** 最低价 */
  readonly low: Decimal | null;
  /** 最新价时间戳 */
  readonly timestamp: Date | null;
  /** 成交量 */
  readonly volume: number | null;
  /** 成交额 */
  readonly turnover: Decimal | null;
  /** 交易状态 (TradeStatus 枚举值) */
  readonly tradeStatus: number | null;
  /** 引伸波幅 */
  readonly impliedVolatility: Decimal | null;
  /** 到期日 */
  readonly expiryDate: NaiveDate | null;
  /** 最后交易日 */
  readonly lastTradeDate: NaiveDate | null;
  /** 街货比 */
  readonly outstandingRatio: Decimal | null;
  /** 街货量 */
  readonly outstandingQuantity: number | null;
  /** 换股比率 */
  readonly conversionRatio: Decimal | null;
  /** 轮证类型 (WarrantType: Call/Put/Bull/Bear/Inline) */
  readonly category: SDKWarrantType | null;
  /** 行权价 */
  readonly strikePrice: Decimal | null;
  /** 上限价 */
  readonly upperStrikePrice: Decimal | null;
  /** 下限价 */
  readonly lowerStrikePrice: Decimal | null;
  /** 回收价 */
  readonly callPrice: Decimal | null;
  /** 标的证券代码 */
  readonly underlyingSymbol: string | null;
};

/**
 * 牛熊证信息
 * 来源：WarrantRiskChecker 通过 LongPort API 查询后解析填充
 * 区分非轮证（isWarrant=false）与轮证（isWarrant=true）两种形态，仅在 riskController 模块内部使用
 */
export type WarrantInfo =
  | { readonly isWarrant: false }
  | {
      readonly isWarrant: true;
      readonly warrantType: WarrantType;
      readonly callPrice: number | null;
      readonly category: number | string;
      readonly symbol: string;
    };

// ==================== 服务接口定义 ====================

/** 牛熊证风险检查器接口 */
export interface WarrantRiskChecker {
  setWarrantInfoFromCallPrice(
    symbol: string,
    callPrice: number,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ): WarrantRefreshResult;
  refreshWarrantInfoForSymbol(
    marketDataClient: MarketDataClient,
    symbol: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ): Promise<WarrantRefreshResult>;
  checkRisk(
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: number,
    warrantCurrentPrice: number | null,
  ): RiskCheckResult;
  checkWarrantDistanceLiquidation(
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: number,
  ): WarrantDistanceLiquidationResult;
  getWarrantDistanceInfo(
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: number | null,
  ): WarrantDistanceInfo | null;
  clearLongWarrantInfo(): void;
  clearShortWarrantInfo(): void;
}

/** 持仓限制检查器接口 */
export interface PositionLimitChecker {
  checkLimit(
    signal: Signal,
    positions: ReadonlyArray<Position> | null,
    orderNotional: number,
    currentPrice: number | null,
  ): RiskCheckResult;
}

/** 浮亏检查器接口 */
export interface UnrealizedLossChecker {
  getUnrealizedLossData(symbol: string): UnrealizedLossData | undefined;
  /** 清空浮亏数据，symbol 为空时清空全部 */
  clearUnrealizedLossData(symbol?: string | null): void;
  refresh(
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
    quote?: Quote | null,
    dailyLossOffset?: number,
  ): Promise<{ r1: number; n1: number } | null>;
  check(
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult;
}

// ==================== 依赖类型定义 ====================

/** 牛熊证风险检查器依赖（当前无外部依赖） */
export type WarrantRiskCheckerDeps = {
  readonly [key: string]: never;
};

/** 持仓限制检查器依赖 */
export type PositionLimitCheckerDeps = {
  readonly maxPositionNotional: number | null;
};

/** 浮亏检查器依赖 */
export type UnrealizedLossCheckerDeps = {
  readonly maxUnrealizedLossPerSymbol: number | null;
};

/** 风险检查器依赖（门面模式） */
export type RiskCheckerDeps = {
  readonly warrantRiskChecker: WarrantRiskChecker;
  readonly positionLimitChecker: PositionLimitChecker;
  readonly unrealizedLossChecker: UnrealizedLossChecker;
  readonly options?: {
    readonly maxDailyLoss?: number | null;
    readonly maxPositionNotional?: number | null;
    readonly maxUnrealizedLossPerSymbol?: number | null;
  };
};

// ==================== 当日亏损追踪 ====================

/**
 * 单监控标的单方向的当日亏损状态。
 * 由 DailyLossTracker 内部维护，按 monitorSymbol + 方向（long/short）分组存储。
 */
export type DailyLossState = {
  readonly buyOrders: ReadonlyArray<OrderRecord>;
  readonly sellOrders: ReadonlyArray<OrderRecord>;
  readonly dailyLossOffset: number;
};

/**
 * 未归属订单诊断样例，用于日志输出。
 * 仅在 collectOrderOwnershipDiagnostics 内部构造，不对外暴露。
 */
export type OrderOwnershipDiagnosticSample = {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName: string;
};

/**
 * 订单归属诊断结果，记录当日成交订单中未能归属到任何监控标的的统计信息。
 * 由 collectOrderOwnershipDiagnostics 返回，供 DailyLossTracker 启动时日志告警使用。
 */
export type OrderOwnershipDiagnostics = {
  readonly dayKey: string;
  readonly totalFilled: number;
  readonly inDayFilled: number;
  readonly unmatchedFilled: number;
  readonly unmatchedSamples: ReadonlyArray<OrderOwnershipDiagnosticSample>;
};

/**
 * 成交回报输入，用于 DailyLossTracker.recordFilledOrder 增量记录单笔成交。
 * 数据来源：OrderMonitor 成交回调，仅在当日日键匹配时写入。
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
 * 当日亏损追踪器接口，按监控标的与方向维护已实现盈亏偏移。
 * 由 riskDomain 持有，生命周期与主程序一致；跨日时由 midnightClear 调用 resetAll 重置。
 */
export interface DailyLossTracker {
  /** 显式重置 dayKey 与 states */
  resetAll(now: Date): void;
  /** 使用完整订单列表重新计算当日状态，作为启动初始化或纠偏手段 */
  recalculateFromAllOrders(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
    now: Date,
  ): void;
  /** 增量记录单笔成交，仅接受当日日键匹配的订单 */
  recordFilledOrder(input: DailyLossFilledOrderInput): void;
  /** 获取指定标的与方向的当日亏损偏移，未初始化时返回 0 */
  getLossOffset(monitorSymbol: string, isLongSymbol: boolean): number;
}

/**
 * DailyLossTracker 依赖注入类型。
 * filteringEngine 用于计算未平仓买入成本；其余函数由外部注入以解耦订单归属逻辑。
 */
export type DailyLossTrackerDeps = {
  readonly filteringEngine: OrderFilteringEngine;
  readonly resolveOrderOwnership: (
    order: RawOrderFromAPI,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
  ) => OrderOwnership | null;
  readonly classifyAndConvertOrders: (
    orders: ReadonlyArray<RawOrderFromAPI>,
  ) => { buyOrders: ReadonlyArray<OrderRecord>; sellOrders: ReadonlyArray<OrderRecord> };
  readonly toHongKongTimeIso: (date: Date | null) => string;
};

// ==================== 浮亏监控器 ====================

/**
 * 浮亏监控上下文
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
 * 浮亏监控器接口
 * 监控做多/做空标的的浮亏，超过阈值时触发保护性清仓
 */
export interface UnrealizedLossMonitor {
  /**
   * 监控做多和做空标的的浮亏
   * @param context 浮亏监控上下文
   */
  monitorUnrealizedLoss(context: UnrealizedLossMonitorContext): Promise<void>;
}

/**
 * 浮亏监控器依赖类型
 */
export type UnrealizedLossMonitorDeps = {
  /** 单标的最大浮亏阈值（港币），<=0 表示禁用浮亏监控 */
  readonly maxUnrealizedLossPerSymbol: number;
};
