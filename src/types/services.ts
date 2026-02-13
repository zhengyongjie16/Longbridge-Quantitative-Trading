/**
 * @module types/services
 * @description 核心服务接口类型定义
 *
 * 定义核心服务的接口和相关的类型
 */
import type {
  Market,
  OrderSide,
  OrderStatus,
  OrderType,
  QuoteContext,
  Candlestick,
  Period,
  TradeSessions,
} from 'longport';
import type { SignalType, Signal } from './signal.js';
import type { Quote, IndicatorSnapshot } from './quote.js';
import type { AccountSnapshot, Position } from './account.js';
import type { DecimalLikeValue } from './common.js';
import type { MonitorConfig } from './config.js';
import type { DoomsdayProtection } from '../core/doomsdayProtection/types.js';
import type { PendingSellInfo } from '../core/orderRecorder/types.js';

/**
 * 交易日查询结果
 */
export type TradingDaysResult = {
  /** 完整交易日列表 */
  readonly tradingDays: ReadonlyArray<string>;
  /** 半日交易日列表 */
  readonly halfTradingDays: ReadonlyArray<string>;
};

/**
 * 交易日信息
 * 用于判断当前是否为交易日及是否为半日市
 */
export type TradingDayInfo = {
  /** 是否为交易日 */
  readonly isTradingDay: boolean;
  /** 是否为半日市（如节假日前一天） */
  readonly isHalfDay: boolean;
};

/**
 * 行情数据客户端接口
 * 封装 LongPort 行情 API，提供行情获取和缓存功能
 */
export interface MarketDataClient {
  /** 获取底层 QuoteContext（内部使用） */
  _getContext(): Promise<QuoteContext>;

  /**
   * 批量获取多个标的的最新行情
   * @param symbols 标的代码可迭代对象
   * @returns 标的代码到行情数据的 Map
   */
  getQuotes(symbols: Iterable<string>): Promise<Map<string, Quote | null>>;

  /** 动态订阅行情标的（报价推送） */
  subscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>;

  /** 取消订阅行情标的（报价推送） */
  unsubscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>;

  /**
   * 订阅指定标的的 K 线推送
   *
   * 订阅后 SDK 通过 WebSocket 实时推送 K 线更新到 SDK 内部缓存，
   * 后续通过 getRealtimeCandlesticks 从 SDK 内部缓存读取。
   *
   * @param symbol 标的代码
   * @param period K 线周期
   * @param tradeSessions 交易时段（默认 All）
   * @returns 初始 K 线数据
   */
  subscribeCandlesticks(
    symbol: string,
    period: Period,
    tradeSessions?: TradeSessions,
  ): Promise<Candlestick[]>;

  /**
   * 取消订阅指定标的的 K 线推送
   * @param symbol 标的代码
   * @param period K 线周期
   */
  unsubscribeCandlesticks(
    symbol: string,
    period: Period,
  ): Promise<void>;

  /**
   * 获取实时 K 线数据（从 SDK 内部缓存读取，无 HTTP 请求）
   *
   * 需先调用 subscribeCandlesticks 订阅，否则返回空数据。
   *
   * @param symbol 标的代码
   * @param period K 线周期
   * @param count 获取数量
   */
  getRealtimeCandlesticks(
    symbol: string,
    period: Period,
    count: number,
  ): Promise<Candlestick[]>;

  /** 判断指定日期是否为交易日 */
  isTradingDay(date: Date, market?: Market): Promise<TradingDayInfo>;

  /** 重置运行期订阅与缓存（跨日午夜清理） */
  resetRuntimeSubscriptionsAndCaches(): Promise<void>;

}

/**
 * 待处理订单
 * 表示尚未完全成交的订单
 */
export type PendingOrder = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly submittedPrice: number;
  readonly quantity: number;
  readonly executedQuantity: number;
  readonly status: OrderStatus;
  readonly orderType: RawOrderFromAPI['orderType'];
  readonly _rawOrder?: unknown;
};

/**
 * API 返回的原始订单类型
 * 用于从 LongPort API 接收订单数据时的类型安全转换
 */
export type RawOrderFromAPI = {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly side: OrderSide;
  readonly status: OrderStatus;
  readonly orderType: OrderType;
  readonly price: DecimalLikeValue;
  readonly quantity: DecimalLikeValue;
  readonly executedPrice: DecimalLikeValue;
  readonly executedQuantity: DecimalLikeValue;
  readonly submittedAt?: Date | null;
  readonly updatedAt?: Date | null;
};

/**
 * 已成交订单记录
 * 用于记录和计算持仓成本
 */
export type OrderRecord = {
  /** 订单 ID */
  readonly orderId: string;
  /** 标的代码 */
  readonly symbol: string;
  /** 成交价格 */
  readonly executedPrice: number;
  /** 成交数量 */
  readonly executedQuantity: number;
  /** 成交时间戳 */
  readonly executedTime: number;
  /** 下单时间 */
  readonly submittedAt: Date | undefined;
  /** 更新时间 */
  readonly updatedAt: Date | undefined;
};

/**
 * 交易检查结果
 * 检查当前是否可以执行交易
 */
export type TradeCheckResult = {
  /** 是否可以交易 */
  readonly canTrade: boolean;
  /** 需等待秒数（频率限制） */
  readonly waitSeconds?: number;
  /** 交易方向 */
  readonly direction?: 'LONG' | 'SHORT';
  /** 不可交易原因 */
  readonly reason?: string;
};

/**
 * API 频率限制器接口
 */
export interface RateLimiter {
  /** 等待限流通过 */
  throttle(): Promise<void>;
}

/**
 * 订单记录器接口
 * 管理买卖订单的本地记录和 API 同步
 */
export interface OrderRecorder {
  /** 记录本地买入订单 */
  recordLocalBuy(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
  ): void;
  /** 记录本地卖出订单 */
  recordLocalSell(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
    orderId?: string | null,
  ): void;
  /** 清空指定标的的买入订单记录 */
  clearBuyOrders(symbol: string, isLongSymbol: boolean, quote?: Quote | null): void;
  /** 获取最新买入订单价格 */
  getLatestBuyOrderPrice(symbol: string, isLongSymbol: boolean): number | null;
  /** 获取最新卖出订单记录 */
  getLatestSellRecord(symbol: string, isLongSymbol: boolean): OrderRecord | null;
  /** 从 API 获取全量订单 */
  fetchAllOrdersFromAPI(forceRefresh?: boolean): Promise<ReadonlyArray<RawOrderFromAPI>>;
  /** 使用全量订单刷新指定标的记录（做多标的） */
  refreshOrdersFromAllOrdersForLong(
    symbol: string,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    quote?: Quote | null,
  ): Promise<OrderRecord[]>;
  /** 使用全量订单刷新指定标的记录（做空标的） */
  refreshOrdersFromAllOrdersForShort(
    symbol: string,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    quote?: Quote | null,
  ): Promise<OrderRecord[]>;
  /** 清理指定标的的 API 订单缓存（不影响本地订单记录） */
  clearOrdersCacheForSymbol(symbol: string): void;
  /** 获取指定标的的买入订单 */
  getBuyOrdersForSymbol(symbol: string, isLongSymbol: boolean): ReadonlyArray<OrderRecord>;

  // 待成交卖出订单追踪

  /** 提交卖出订单时调用（添加待成交追踪） */
  submitSellOrder(
    orderId: string,
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
    relatedBuyOrderIds: readonly string[],
  ): void;
  /** 标记卖出订单完全成交 */
  markSellFilled(orderId: string): PendingSellInfo | null;
  /** 标记卖出订单部分成交 */
  markSellPartialFilled(orderId: string, filledQuantity: number): PendingSellInfo | null;
  /** 标记卖出订单取消 */
  markSellCancelled(orderId: string): PendingSellInfo | null;
  /** 恢复期：为待恢复的卖单分配关联买单 ID */
  allocateRelatedBuyOrderIdsForRecovery(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
  ): readonly string[];
  /** 获取可卖出的盈利订单（核心防重逻辑） */
  getProfitableSellOrders(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    currentPrice: number,
    maxSellQuantity?: number,
  ): { orders: ReadonlyArray<OrderRecord>; totalQuantity: number };
  /** 重置全部订单记录与 API 缓存 */
  resetAll(): void;
}

/**
 * 交易器接口
 * 封装 LongPort 交易 API，提供订单执行和管理功能
 */
export interface Trader {
  /** 订单记录器实例 */
  readonly _orderRecorder: OrderRecorder;

  // ========== 账户相关 ==========

  /** 获取账户快照 */
  getAccountSnapshot(): Promise<AccountSnapshot | null>;
  /** 获取持仓列表 */
  getStockPositions(symbols?: string[] | null): Promise<Position[]>;

  // ========== 订单缓存 ==========

  /** 获取待处理订单 */
  getPendingOrders(symbols?: string[] | null, forceRefresh?: boolean): Promise<PendingOrder[]>;
  /** 启动阶段种子化订单订阅保留集 */
  seedOrderHoldSymbols(orders: ReadonlyArray<RawOrderFromAPI>): void;
  /** 获取订单订阅保留标的集合 */
  getOrderHoldSymbols(): ReadonlySet<string>;
  // ========== 订单监控 ==========

  /** 撤销订单 */
  cancelOrder(orderId: string): Promise<boolean>;
  /** 监控和管理待处理订单 */
  monitorAndManageOrders(quotesMap: ReadonlyMap<string, Quote | null>): Promise<void>;
  /** 获取并清空待刷新标的列表 */
  getAndClearPendingRefreshSymbols(): ReadonlyArray<PendingRefreshSymbol>;

  // ========== 订单执行 ==========

  /** 检查当前是否可交易 */
  _canTradeNow(signalAction: SignalType, monitorConfig?: MonitorConfig | null): TradeCheckResult;
  /** 标记买入意图（预占时间槽，防止并发） */
  _markBuyAttempt(signalAction: SignalType, monitorConfig?: MonitorConfig | null): void;
  /** 生命周期午夜清理：重置订单运行态缓存 */
  _resetRuntimeState(): void;
  /** 生命周期开盘重建：恢复订单追踪 */
  _recoverOrderTracking(): Promise<void>;
  /** 执行交易信号；返回实际提交的订单数量（保护性清仓等仅在真正提交后才更新缓存） */
  executeSignals(signals: Signal[]): Promise<{ submittedCount: number }>;
}

/**
 * 待刷新数据的标的信息
 * 订单成交后标记需要刷新的数据类型
 */
export type PendingRefreshSymbol = {
  /** 标的代码 */
  readonly symbol: string;
  /** 是否为做多标的 */
  readonly isLongSymbol: boolean;
  /** 是否刷新账户数据 */
  readonly refreshAccount: boolean;
  /** 是否刷新持仓数据 */
  readonly refreshPositions: boolean;
};

/**
 * 牛熊证类型
 * - BULL: 牛证（做多）
 * - BEAR: 熊证（做空）
 */
export type WarrantType = 'BULL' | 'BEAR';

/**
 * 牛熊证距离回收价信息（用于实时显示）
 */
export type WarrantDistanceInfo = {
  /** 牛熊证类型 */
  readonly warrantType: WarrantType;
  /** 距离回收价百分比 */
  readonly distanceToStrikePercent: number | null;
};

/**
 * 牛熊证信息刷新结果
 */
export type WarrantRefreshResult =
  | { readonly status: 'ok'; readonly isWarrant: true }
  | { readonly status: 'notWarrant'; readonly isWarrant: false }
  | { readonly status: 'error'; readonly isWarrant: false; readonly reason: string }
  | { readonly status: 'skipped'; readonly isWarrant: false };

/**
 * 牛熊证距回收价清仓判定结果
 */
export type WarrantDistanceLiquidationResult = {
  /** 是否触发清仓 */
  readonly shouldLiquidate: boolean;
  /** 牛熊证类型 */
  readonly warrantType?: WarrantType;
  /** 距离回收价百分比 */
  readonly distancePercent?: number | null;
  /** 判定原因 */
  readonly reason?: string;
};

/**
 * 风险检查结果
 */
export type RiskCheckResult = {
  /** 是否允许交易 */
  readonly allowed: boolean;
  /** 不允许原因 */
  readonly reason?: string;
  /** 牛熊证风险信息 */
  readonly warrantInfo?: {
    /** 是否为牛熊证 */
    readonly isWarrant: boolean;
    /** 牛熊证类型 */
    readonly warrantType: WarrantType;
    /** 距离回收价百分比 */
    readonly distanceToStrikePercent: number;
  };
};

/**
 * 浮亏数据
 * 用于计算单标的浮动亏损
 */
export type UnrealizedLossData = {
  /** r1: 累计买入金额 */
  readonly r1: number;
  /** n1: 累计买入数量 */
  readonly n1: number;
  /** baseR1: 未调整的开仓成本 */
  readonly baseR1?: number;
  /** dailyLossOffset: 当日亏损偏移 */
  readonly dailyLossOffset?: number;
  /** 最后更新时间戳 */
  readonly lastUpdateTime: number;
};

/**
 * 浮亏检查结果
 */
export type UnrealizedLossCheckResult = {
  /** 是否应该强制平仓 */
  readonly shouldLiquidate: boolean;
  /** 平仓原因 */
  readonly reason?: string;
  /** 平仓数量 */
  readonly quantity?: number;
};

/**
 * 持仓缓存接口
 * 使用 Map 提供 O(1) 查找性能
 */
export interface PositionCache {
  /** 更新持仓缓存 */
  update(positions: ReadonlyArray<Position>): void;
  /** 获取指定标的的持仓 */
  get(symbol: string): Position | null;
}

/**
 * 风险检查上下文
 * 执行信号处理时的完整上下文信息
 */
export type RiskCheckContext = {
  /** 交易器 */
  readonly trader: Trader;
  /** 风险检查器 */
  readonly riskChecker: RiskChecker;
  /** 订单记录器 */
  readonly orderRecorder: OrderRecorder;
  /** 做多标的行情 */
  readonly longQuote: Quote | null;
  /** 做空标的行情 */
  readonly shortQuote: Quote | null;
  /** 监控标的行情 */
  readonly monitorQuote: Quote | null;
  /** 监控标的指标快照 */
  readonly monitorSnapshot: IndicatorSnapshot | null;
  /** 做多标的代码 */
  readonly longSymbol: string;
  /** 做空标的代码 */
  readonly shortSymbol: string;
  /** 做多标的名称 */
  readonly longSymbolName: string | null;
  /** 做空标的名称 */
  readonly shortSymbolName: string | null;
  /** 账户缓存（仅用于日志） */
  readonly account: AccountSnapshot | null;
  /** 持仓缓存（仅用于日志） */
  readonly positions: ReadonlyArray<Position>;
  /** 全局状态引用 */
  readonly lastState: {
    cachedAccount?: AccountSnapshot | null;
    cachedPositions?: ReadonlyArray<Position>;
    positionCache: PositionCache;
  };
  /** 当前时间 */
  readonly currentTime: Date;
  /** 是否为半日市 */
  readonly isHalfDay: boolean;
  /** 末日保护实例 */
  readonly doomsdayProtection: DoomsdayProtection;
  /** 监控配置 */
  readonly config: MonitorConfig;
};

/**
 * 风险检查器接口
 * 门面模式，协调牛熊证风险、持仓限制和浮亏检查
 */
export interface RiskChecker {
  /** 从透传的回收价设置牛熊证信息（不调用 API） */
  setWarrantInfoFromCallPrice(
    symbol: string,
    callPrice: number,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ): WarrantRefreshResult;

  /** 刷新单个标的的牛熊证信息 */
  refreshWarrantInfoForSymbol(
    marketDataClient: MarketDataClient,
    symbol: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ): Promise<WarrantRefreshResult>;

  /** 订单前风险检查（持仓限制） */
  checkBeforeOrder(params: {
    readonly account: AccountSnapshot | null;
    readonly positions: ReadonlyArray<Position> | null;
    readonly signal: Signal | null;
    readonly orderNotional: number;
    readonly currentPrice?: number | null;
    readonly longCurrentPrice?: number | null;
    readonly shortCurrentPrice?: number | null;
  }): RiskCheckResult;

  /** 牛熊证风险检查（距离回收价 + 当前价阈值） */
  checkWarrantRisk(
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: number,
    warrantCurrentPrice: number | null,
  ): RiskCheckResult;

  /** 牛熊证距回收价清仓检查 */
  checkWarrantDistanceLiquidation(
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: number,
  ): WarrantDistanceLiquidationResult;

  /** 获取牛熊证距离回收价信息（实时展示用） */
  getWarrantDistanceInfo(
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: number | null,
  ): WarrantDistanceInfo | null;
  /** 清空做多标的牛熊证信息缓存（换标时调用） */
  clearLongWarrantInfo(): void;
  /** 清空做空标的牛熊证信息缓存（换标时调用） */
  clearShortWarrantInfo(): void;

  /** 刷新浮亏数据 */
  refreshUnrealizedLossData(
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
    quote?: Quote | null,
    dailyLossOffset?: number,
  ): Promise<{ r1: number; n1: number } | null>;

  /** 浮亏检查（是否触发强平） */
  checkUnrealizedLoss(
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult;
  /** 清空浮亏缓存（symbol 为空时清空全部） */
  clearUnrealizedLossData(symbol?: string | null): void;
}
