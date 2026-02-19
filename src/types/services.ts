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
 * 交易日查询结果。
 * 类型用途：封装交易日 API 的返回结构，作为 isTradingDay / 交易日查询的返回值或中间数据。
 * 数据来源：LongPort 交易日 API（如 trading_days）。
 * 使用范围：行情客户端、生命周期、门禁等；全项目可引用。
 */
export type TradingDaysResult = {
  /** 完整交易日列表 */
  readonly tradingDays: ReadonlyArray<string>;
  /** 半日交易日列表 */
  readonly halfTradingDays: ReadonlyArray<string>;
};

/**
 * 交易日信息。
 * 类型用途：表示某日是否为交易日及是否为半日市，作为 isTradingDay 返回值、门禁与跨日逻辑的入参。
 * 数据来源：LongPort 交易日 API（如 trading_days）或行情客户端 isTradingDay。
 * 使用范围：行情客户端、生命周期、门禁等；全项目可引用。
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
  getQuoteContext(): Promise<QuoteContext>;

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
 * 待处理订单。
 * 类型用途：表示尚未完全成交的订单，用于 getPendingOrders 返回值、订单监控与撤单逻辑。
 * 数据来源：Trader/订单 API 查询结果转换。
 * 使用范围：trader、orderMonitor、主循环等；全项目可引用。
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
  /** 订单原始响应（仅用于问题排查与调试日志） */
  readonly _rawOrder?: unknown;
};

/**
 * API 返回的原始订单类型。
 * 类型用途：从 LongPort 订单 API 接收订单数据时的类型安全结构，作为 fetchAllOrdersFromAPI、refreshOrdersFromAllOrdersForLong/Short 等入参或元素类型。
 * 数据来源：LongPort 订单 API 返回。
 * 使用范围：OrderRecorder、Trader、orderApiManager 等；全项目可引用。
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
 * 已成交订单记录。
 * 类型用途：表示单笔已成交订单，用于订单记录器内部存储、成本均价计算、可卖订单列表等。
 * 数据来源：本地记录或由 RawOrderFromAPI 转换/同步得到。
 * 使用范围：OrderRecorder、RiskChecker、卖出计算、智能平仓等；全项目可引用。
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
 * 交易检查结果。
 * 类型用途：表示当前是否可执行交易及原因，作为 canTradeNow、recordBuyAttempt 等调用的返回值。
 * 数据来源：Trader 内部根据频率限制、门禁等计算。
 * 使用范围：主循环、买卖处理器等；全项目可引用。
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
 * API 频率限制器接口。
 * 类型用途：依赖注入用接口，在交易/行情等 API 调用前等待限流通过。
 * 数据来源：如适用；实现由调用方提供。
 * 使用范围：Trader、行情客户端等限流场景；见调用方。
 */
export interface RateLimiter {
  /** 等待限流通过 */
  throttle(): Promise<void>;
}

/**
 * 订单记录器接口。
 * 类型用途：依赖注入用接口，管理买卖订单的本地记录与 API 同步，提供成本价、可卖订单、待成交卖单追踪等。
 * 数据来源：本地记录 + LongPort 订单 API 同步。
 * 使用范围：Trader、RiskChecker、信号处理、主循环等；全项目可引用。
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
  /** 获取指定标的的成本均价（实时计算，无缓存） */
  getCostAveragePrice(symbol: string, isLongSymbol: boolean): number | null;
  /**
   * 获取可卖出的订单（核心防重逻辑）
   * includeAll=true 时返回该标的该方向全部订单，否则仅返回买入价 < 当前价的订单
   */
  getSellableOrders(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    currentPrice: number,
    maxSellQuantity?: number,
    options?: { readonly includeAll?: boolean },
  ): { orders: ReadonlyArray<OrderRecord>; totalQuantity: number };
  /** 重置全部订单记录与 API 缓存 */
  resetAll(): void;
}

/**
 * 交易器接口。
 * 类型用途：依赖注入用接口，封装 LongPort 交易 API，提供账户/持仓、订单执行、订单监控与信号执行等。
 * 数据来源：实现层对接 LongPort TradeContext；账户与订单数据来自 API。
 * 使用范围：主循环、MonitorContext、信号处理、门禁等；全项目可引用。
 */
export interface Trader {
  /** 订单记录器实例 */
  readonly orderRecorder: OrderRecorder;

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
  canTradeNow(signalAction: SignalType, monitorConfig?: MonitorConfig | null): TradeCheckResult;
  /** 标记买入意图（预占时间槽，防止并发） */
  recordBuyAttempt(signalAction: SignalType, monitorConfig?: MonitorConfig | null): void;
  /** 从 API 获取全量订单 */
  fetchAllOrdersFromAPI(forceRefresh?: boolean): Promise<ReadonlyArray<RawOrderFromAPI>>;
  /** 生命周期午夜清理：重置订单运行态缓存 */
  resetRuntimeState(): void;
  /** 生命周期开盘重建：恢复订单追踪 */
  recoverOrderTracking(): Promise<void>;
  /** 执行交易信号；返回实际提交的订单数量（保护性清仓等仅在真正提交后才更新缓存） */
  executeSignals(signals: Signal[]): Promise<{ submittedCount: number }>;
}

/**
 * 待刷新数据的标的信息。
 * 类型用途：订单成交后标记需要刷新的标的及要刷新的数据类型（账户/持仓），用于 getAndClearPendingRefreshSymbols 等。
 * 数据来源：Trader/订单监控在成交回调中写入。
 * 使用范围：postTradeRefresher、主循环等；全项目可引用。
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
 * 牛熊证类型。
 * 类型用途：区分牛证（做多）与熊证（做空），用于 RiskCheckResult、WarrantDistanceInfo 等字段。
 * 数据来源：LongPort 行情静态信息或 RiskChecker 解析。
 * 使用范围：RiskChecker、UI/监控展示等；全项目可引用。
 */
export type WarrantType = 'BULL' | 'BEAR';

/**
 * 牛熊证距离回收价信息。
 * 类型用途：表示某标的距离回收价的百分比，用于实时展示与风控判断。
 * 数据来源：RiskChecker 根据行情与回收价计算。
 * 使用范围：RiskChecker、UI/监控展示；全项目可引用。
 */
export type WarrantDistanceInfo = {
  /** 牛熊证类型 */
  readonly warrantType: WarrantType;
  /** 距离回收价百分比 */
  readonly distanceToStrikePercent: number | null;
};

/**
 * 牛熊证信息刷新结果。
 * 类型用途：表示刷新牛熊证信息的结果（ok/notWarrant/error/skipped），作为 setWarrantInfoFromCallPrice、refreshWarrantInfoForSymbol 返回值。
 * 数据来源：RiskChecker 根据 API 或透传回收价得出。
 * 使用范围：RiskChecker、调用方与 UI；全项目可引用。
 */
export type WarrantRefreshResult =
  | { readonly status: 'ok'; readonly isWarrant: true }
  | { readonly status: 'notWarrant'; readonly isWarrant: false }
  | { readonly status: 'error'; readonly isWarrant: false; readonly reason: string }
  | { readonly status: 'skipped'; readonly isWarrant: false };

/**
 * 牛熊证距回收价清仓判定结果。
 * 类型用途：表示是否应因距回收价过近而清仓及原因，作为 checkWarrantDistanceLiquidation 返回值。
 * 数据来源：RiskChecker 根据当前价与回收价计算。
 * 使用范围：RiskChecker、信号处理/卖出逻辑；全项目可引用。
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
 * 风险检查结果。
 * 类型用途：订单前/牛熊证风险检查的返回值，表示是否允许交易、原因及牛熊证风险信息。
 * 数据来源：RiskChecker.checkBeforeOrder、checkWarrantRisk 等。
 * 使用范围：信号处理、买卖流程、主循环；全项目可引用。
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
 * 浮亏数据。
 * 类型用途：存储单标的累计买入金额/数量等，用于计算浮动亏损与强平判定。
 * 数据来源：OrderRecorder 订单记录 + RiskChecker 刷新与计算。
 * 使用范围：RiskChecker、UnrealizedLossMonitor 等；全项目可引用。
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
 * 浮亏检查结果。
 * 类型用途：单标的浮亏检查返回值，表示是否应强制平仓、原因及建议平仓数量。
 * 数据来源：RiskChecker.checkUnrealizedLoss。
 * 使用范围：信号处理、卖出逻辑；全项目可引用。
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
 * 持仓缓存接口。
 * 类型用途：依赖注入用接口，提供基于标的代码的 O(1) 持仓查找，作为 LastState.positionCache、RiskCheckContext 等类型。
 * 数据来源：由主循环/刷新流程根据 getStockPositions 结果调用 update 维护。
 * 使用范围：LastState、RiskChecker、主循环等；全项目可引用。
 */
export interface PositionCache {
  /** 更新持仓缓存 */
  update(positions: ReadonlyArray<Position>): void;
  /** 获取指定标的的持仓 */
  get(symbol: string): Position | null;
}

/**
 * 风险检查上下文。
 * 类型用途：执行信号处理与风控时的完整上下文（交易器、风控器、行情、账户、配置等），作为 processSignal、风控检查的入参。
 * 数据来源：由主循环/processMonitor 根据 MonitorContext 与 LastState 组装传入。
 * 使用范围：信号处理、风控检查等；全项目可引用。
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
 * 风险检查器接口。
 * 类型用途：依赖注入用接口，门面模式协调牛熊证风险、持仓限制与浮亏检查，供信号处理与买卖流程调用。
 * 数据来源：实现层对接行情与订单记录；牛熊证/浮亏数据由内部缓存与 API 维护。
 * 使用范围：MonitorContext、信号处理、主循环等；全项目可引用。
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
