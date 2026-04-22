import type {
  Candlestick,
  Decimal,
  FilterWarrantExpiryDate,
  FilterWarrantInOutBoundsType,
  Market,
  OrderSide,
  OrderStatus,
  OrderType,
  Period,
  SortOrderType,
  TradeSessions,
  WarrantSortBy,
  WarrantStatus,
  WarrantType,
} from 'longbridge';
import type { SignalType, Signal } from './signal.js';
import type { Quote, IndicatorSnapshot } from './quote.js';
import type { AccountSnapshot, Position } from './account.js';
import type { MonitorConfig } from './config.js';
import type { TradingCalendarSnapshot } from './tradingCalendar.js';
import type { CancelOrderOutcome, OrderClosedReason } from './trader.js';
import type { CandleData } from './data.js';
import type { DecimalLike } from '../utils/helpers/types.js';

/**
 * 可转换为数字的值类型。
 * 类型用途：兼容 Longbridge SDK 返回的 Decimal 与原始数值，用于当前服务类型中的价格、数量等字段声明。
 * 数据来源：Longbridge API 返回或本地数字。
 * 使用范围：services 类型模块内部字段复用，不作为跨模块公共类型导出。
 */
type DecimalLikeValue = string | number | null;

/**
 * 交易日查询结果。
 * 类型用途：封装交易日 API 的返回结构，作为 isTradingDay / 交易日查询的返回值或中间数据。
 * 数据来源：Longbridge 交易日 API（如 trading_days）。
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
 * 数据来源：Longbridge 交易日 API（如 trading_days）或行情客户端 isTradingDay。
 * 使用范围：行情客户端、生命周期、门禁等；全项目可引用。
 */
export type TradingDayInfo = {
  /** 是否为交易日 */
  readonly isTradingDay: boolean;

  /** 是否为半日市（如节假日前一天） */
  readonly isHalfDay: boolean;
};

/**
 * 本地 K 线缓存快照。
 * 类型用途：主循环消费的应用层 K 线缓存结构，包含版本、最后一根 bar 状态与初始化标记。
 * 数据来源：quoteClient 在 subscribe seed 与 setOnCandlestick push 更新后维护。
 * 使用范围：MarketDataClient.getCandlestickSnapshot 与主循环指标流水线使用。
 */
export type CandlestickCacheSnapshot = {
  readonly symbol: string;
  readonly period: Period;
  readonly version: number;
  readonly candles: ReadonlyArray<CandleData>;
  readonly lastBarTimestamp: number | null;
  readonly lastBarConfirmed: boolean | null;
  readonly initialized: boolean;
};

/**
 * 标准化行情更新事件。
 * 类型用途：表示经过 quoteClient 标准化后的单标的报价更新事件，供运行时与业务监听器消费。
 * 数据来源：quoteClient 基于 Longbridge QuoteContext 的 quote push 事件与本地缓存标准化得到。
 * 使用范围：MarketDataClient.onQuoteUpdated 与相关风控/运行时消费链路；全项目可引用。
 */
export type QuoteUpdatedEvent = {
  /** 标的代码 */
  readonly symbol: string;

  /** 标准化后的行情快照 */
  readonly quote: Quote;
};

/**
 * 标准化 K 线更新事件。
 * 类型用途：表示经过 quoteClient 标准化后的单标的 K 线更新事件，供事件驱动业务监听器消费。
 * 数据来源：quoteClient 在处理 Longbridge K 线 push 并更新本地缓存后标准化得到。
 * 使用范围：MarketDataClient.onCandlestickUpdated 与相关业务监听链路；全项目可引用。
 */
export type CandlestickUpdatedEvent = {
  /** 标的代码 */
  readonly symbol: string;

  /** K 线周期 */
  readonly period: Period;

  /** 最新本地 K 线缓存快照 */
  readonly snapshot: CandlestickCacheSnapshot;
};

/**
 * 轮证报价最小结构。
 * 类型用途：表达当前仓库直接消费的 warrantQuote 字段边界，仅保留 symbol/callPrice/category。
 * 数据来源：quoteClient 透传的 Longbridge warrantQuote 响应。
 * 使用范围：MarketQuoteContext.warrantQuote 返回值内部使用，不作为跨模块公共类型导出。
 */
type MarketWarrantQuote = Readonly<{
  readonly symbol: string;
  readonly callPrice?: DecimalLike | DecimalLikeValue;
  readonly category?: number | string | null;
}>;

/**
 * 轮证列表最小结构。
 * 类型用途：表达当前仓库直接消费的 warrantList 字段边界，仅保留自动寻标所需字段。
 * 数据来源：quoteClient 透传的 Longbridge warrantList 响应。
 * 使用范围：MarketQuoteContext.warrantList 返回值内部使用，不作为跨模块公共类型导出。
 */
type MarketWarrantListItem = Readonly<{
  readonly symbol: string;
  readonly name?: string | null;
  readonly lastDone: DecimalLike | DecimalLikeValue | null | undefined;
  readonly toCallPrice: DecimalLike | DecimalLikeValue | null | undefined;
  readonly callPrice?: DecimalLike | DecimalLikeValue | null | undefined;
  readonly turnover: DecimalLike | DecimalLikeValue | null | undefined;
  readonly warrantType: number | string | null | undefined;
  readonly status: number | string | null | undefined;
}>;

/**
 * 轮证列表查询参数。
 * 类型用途：收口 warrantList 查询所需参数，避免业务边界暴露过长的位置参数列表。
 * 数据来源：由自动寻标、换标预寻标与席位恢复链路组装。
 * 使用范围：MarketQuoteContext.warrantList 入参内部使用，不作为跨模块公共类型导出。
 */
type MarketWarrantListRequest = Readonly<{
  readonly symbol: string;
  readonly sortBy: WarrantSortBy;
  readonly sortOrder: SortOrderType;
  readonly types: ReadonlyArray<WarrantType>;
  readonly issuerIds?: ReadonlyArray<number> | null;
  readonly expiryFilters?: ReadonlyArray<FilterWarrantExpiryDate>;
  readonly inOutBoundsTypes?: ReadonlyArray<FilterWarrantInOutBoundsType>;
  readonly status?: ReadonlyArray<WarrantStatus>;
}>;

/**
 * 行情上下文最小契约。
 * 类型用途：约束 getQuoteContext 对外暴露的真实能力边界，只包含当前业务链路实际依赖的轮证查询能力。
 * 数据来源：由 quoteClient 基于 Longbridge QuoteContext 适配后提供。
 * 使用范围：自动寻标、牛熊证风险检查与运行时恢复等需要直接访问轮证接口的链路。
 */
export interface MarketQuoteContext {
  /** 查询轮证报价（用于回收价/牛熊证类型检查） */
  warrantQuote: (symbols: ReadonlyArray<string>) => Promise<ReadonlyArray<MarketWarrantQuote>>;

  /** 查询轮证列表（用于自动寻标/换标候选筛选） */
  warrantList: (request: MarketWarrantListRequest) => Promise<ReadonlyArray<MarketWarrantListItem>>;
}

/**
 * 行情数据客户端接口。
 * 类型用途：依赖注入用接口，封装 Longbridge 行情 API，提供行情获取、订阅、K 线、交易日查询及运行期缓存重置。
 * 数据来源：由 quoteClient 等实现，对接 Longbridge QuoteContext。
 * 使用范围：主程序、生命周期、processMonitor、行情订阅与 K 线消费方等；全项目可引用。
 */
export interface MarketDataClient {
  /** 获取轮证查询上下文（内部使用） */
  getQuoteContext: () => Promise<MarketQuoteContext>;

  /**
   * 批量获取多个标的的最新行情
   * @param symbols 标的代码可迭代对象
   * @returns 标的代码到行情数据的 Map
   */
  getQuotes: (symbols: Iterable<string>) => Promise<Map<string, Quote | null>>;

  /** 动态订阅行情标的（报价推送） */
  subscribeSymbols: (symbols: ReadonlyArray<string>) => Promise<void>;

  /** 取消订阅行情标的（报价推送） */
  unsubscribeSymbols: (symbols: ReadonlyArray<string>) => Promise<void>;

  /**
   * 订阅标准化行情更新事件。
   *
   * 该事件由 quoteClient 基于 quote push 与本地缓存标准化后发出。
   *
   * @param listener 报价更新监听器
   * @returns 取消订阅函数
   */
  onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => () => void;

  /**
   * 订阅标准化 K 线更新事件。
   *
   * 该事件由 quoteClient 基于 K 线 push 与本地缓存标准化后发出，是普通 K 线事件业务链路的必需能力。
   *
   * @param listener K 线更新监听器
   * @returns 取消订阅函数
   */
  onCandlestickUpdated: (listener: (event: CandlestickUpdatedEvent) => void) => () => void;

  /**
   * 订阅指定标的的 K 线推送
   *
   * 订阅后客户端会用返回值 seed 应用层本地 K 线缓存，并通过 push 事件持续更新。
   * getRealtimeCandlesticks 仍保留为 SDK 内部缓存读取能力（非主循环主路径）。
   *
   * @param symbol 标的代码
   * @param period K 线周期
   * @param tradeSessions 交易时段（默认 Intraday）
   * @returns 初始 K 线数据
   */
  subscribeCandlesticks: (
    symbol: string,
    period: Period,
    tradeSessions?: TradeSessions,
  ) => Promise<ReadonlyArray<Candlestick>>;

  /**
   * 获取实时 K 线数据（从 SDK 内部缓存读取，无 HTTP 请求）
   *
   * 需先调用 subscribeCandlesticks 订阅，否则返回空数据。
   *
   * @param symbol 标的代码
   * @param period K 线周期
   * @param count 获取数量
   */
  getRealtimeCandlesticks: (
    symbol: string,
    period: Period,
    count: number,
  ) => Promise<ReadonlyArray<Candlestick>>;

  /**
   * 获取应用层本地 K 线缓存快照（由 subscribe seed + push 更新维护）。
   *
   * @param symbol 标的代码
   * @param period K 线周期
   * @returns 本地缓存快照，不存在时返回 null
   */
  getCandlestickSnapshot: (symbol: string, period: Period) => CandlestickCacheSnapshot | null;

  /** 判断指定日期是否为交易日 */
  isTradingDay: (date: Date, market?: Market) => Promise<TradingDayInfo>;

  /** 批量获取交易日历区间（可选实现） */
  getTradingDays?: (startDate: Date, endDate: Date, market?: Market) => Promise<TradingDaysResult>;

  /** 重置运行期订阅与缓存（跨日午夜清理） */
  resetRuntimeSubscriptionsAndCaches: () => Promise<void>;
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
};

/**
 * API 返回的原始订单类型。
 * 类型用途：从 Longbridge 订单 API 接收订单数据时的类型安全结构，作为 fetchAllOrdersFromAPI、refreshOrdersFromAllOrdersForLong/Short 等入参或元素类型。
 * 数据来源：Longbridge 订单 API 返回。
 * 使用范围：OrderRecorder、Trader、orderApiManager 等；全项目可引用。
 */
export type RawOrderFromAPI = {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly side: OrderSide;
  readonly status: OrderStatus;
  readonly orderType: OrderType;
  readonly remark?: string | null;
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
 * 待成交卖出订单信息。
 * 类型用途：智能平仓防重追踪，记录已提交但未成交的卖出订单及关联买单。
 * 数据来源：提交卖单时添加，成交/撤单时更新状态。
 * 使用范围：OrderRecorder、OrderStorage、订单监控等；全项目可引用。
 */
export type PendingSellInfo = {
  /** 卖出订单ID */
  readonly orderId: string;

  /** 标的代码 */
  readonly symbol: string;

  /** 方向 */
  readonly direction: 'LONG' | 'SHORT';

  /** 提交数量 */
  readonly submittedQuantity: number;

  /** 已成交数量 */
  readonly filledQuantity: number;

  /** 关联的买入订单ID列表（精确标记哪些订单被占用） */
  readonly relatedBuyOrderIds: readonly string[];

  /** 状态 */
  readonly status: 'pending' | 'partial' | 'filled' | 'cancelled';

  /** 提交时间 */
  readonly submittedAt: number;
};

/**
 * 可卖订单筛选策略。
 * 类型用途：统一描述卖出订单筛选行为（全量/仅盈利/仅超时）。
 * 数据来源：由卖出决策层传入。
 * 使用范围：orderRecorder 与 signalProcessor 模块。
 */
type SellableOrderStrategy = 'ALL' | 'PROFIT_ONLY' | 'TIMEOUT_ONLY';

/**
 * 可卖订单筛选参数。
 * 类型用途：selectSellableOrders 的对象入参，统一承载策略、价格、超时、截断和额外排除规则。
 * 数据来源：卖出决策层构建。
 * 使用范围：orderRecorder 与 signalProcessor 模块。
 */
export type SellableOrderSelectParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly strategy: SellableOrderStrategy;
  readonly currentPrice: number;
  readonly maxSellQuantity?: number;
  readonly excludeOrderIds?: ReadonlySet<string>;
  readonly timeoutMinutes?: number | null;
  readonly nowMs?: number;
  readonly calendarSnapshot?: TradingCalendarSnapshot;
};

/**
 * 可卖订单查询结果。
 * 类型用途：OrderStorage.selectSellableOrders 的返回结果，用于卖出数量计算与防重。
 * 数据来源：由 OrderStorage.selectSellableOrders 返回。
 * 使用范围：见调用方（如 signalProcessor、trader）。
 */
export type SellableOrderResult = {
  /** 可卖出的订单记录列表 */
  readonly orders: ReadonlyArray<OrderRecord>;

  /** 这些订单的总数量 */
  readonly totalQuantity: number;
};

/**
 * 交易检查结果。
 * 类型用途：表示当前是否可执行交易及原因，作为 canTradeNow 等频率检查调用的返回值。
 * 数据来源：Trader 内部根据频率限制、门禁等计算。
 * 使用范围：主循环、买卖处理器等；全项目可引用。
 */
export type TradeCheckResult = {
  /** 是否可以交易 */
  readonly canTrade: boolean;

  /** 需等待秒数（频率限制） */
  readonly waitSeconds?: number;
};

/**
 * API 频率限制器接口。
 * 类型用途：依赖注入用接口，在交易/行情等 API 调用前等待限流通过。
 * 数据来源：如适用；实现由调用方提供。
 * 使用范围：Trader、行情客户端等限流场景；见调用方。
 */
export interface RateLimiter {
  /** 等待限流通过 */
  throttle: () => Promise<void>;
}

/**
 * 订单记录器中「待成交卖单 + 可卖订单」相关方法的共享契约。
 * 类型用途：抽取 OrderRecorder 内部复用的方法集合，避免在公开契约中重复书写同一组方法签名。
 * 数据来源：由订单记录器实现提供。
 * 使用范围：OrderRecorder 内部组合复用，不作为跨模块公共类型导出。
 */
interface OrderRecorderPendingSellAndSellable {
  /** 更新待成交卖单元数据（卖单合并后同步数量与占用集合） */
  updatePendingSell: (
    orderId: string,
    params: {
      readonly submittedQuantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    },
  ) => PendingSellInfo | null;

  /** 标记卖出订单完全成交 */
  markSellFilled: (orderId: string) => PendingSellInfo | null;

  /** 标记卖出订单部分成交 */
  markSellPartialFilled: (orderId: string, filledQuantity: number) => PendingSellInfo | null;

  /** 标记卖出订单取消 */
  markSellCancelled: (orderId: string) => PendingSellInfo | null;

  /** 获取待成交卖单快照（用于恢复一致性校验） */
  getPendingSellSnapshot: () => ReadonlyArray<PendingSellInfo>;

  /** 恢复期：为待恢复的卖单分配关联买单 ID */
  allocateRelatedBuyOrderIdsForRecovery: (
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
  ) => readonly string[];

  /** 获取指定标的的成本均价（实时计算，无缓存） */
  getCostAveragePrice: (symbol: string, isLongSymbol: boolean) => number | null;

  /** 按策略筛选可卖订单（统一处理占用过滤、整笔截断与可选额外排除） */
  selectSellableOrders: (params: SellableOrderSelectParams) => SellableOrderResult;
}

/**
 * 订单记录器接口。
 * 类型用途：依赖注入用接口，管理买卖订单的本地记录与 API 同步，提供成本价、可卖订单、待成交卖单追踪等。
 * 数据来源：本地记录 + Longbridge 订单 API 同步。
 * 使用范围：Trader、RiskChecker、信号处理、主循环等；全项目可引用。
 */
export interface OrderRecorder extends OrderRecorderPendingSellAndSellable {
  /** 记录本地买入订单 */
  recordLocalBuy: (
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
  ) => void;

  /** 记录本地卖出订单 */
  recordLocalSell: (
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
    orderId?: string | null,
    relatedBuyOrderIds?: ReadonlyArray<string> | null,
  ) => void;

  /** 清空指定标的的买入订单记录 */
  clearBuyOrders: (symbol: string, isLongSymbol: boolean, quote?: Quote | null) => void;

  /** 获取最新买入订单价格 */
  getLatestBuyOrderPrice: (symbol: string, isLongSymbol: boolean) => number | null;

  /** 获取最新卖出订单记录 */
  getLatestSellRecord: (symbol: string, isLongSymbol: boolean) => OrderRecord | null;

  /** 按订单 ID 获取卖出成交记录 */
  getSellRecordByOrderId: (orderId: string) => OrderRecord | null;

  /** 从 API 获取全量订单 */
  fetchAllOrdersFromAPI: (forceRefresh?: boolean) => Promise<ReadonlyArray<RawOrderFromAPI>>;

  /** 使用全量订单刷新指定标的记录（做多标的） */
  refreshOrdersFromAllOrdersForLong: (
    symbol: string,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    quote?: Quote | null,
  ) => Promise<ReadonlyArray<OrderRecord>>;

  /** 使用全量订单刷新指定标的记录（做空标的） */
  refreshOrdersFromAllOrdersForShort: (
    symbol: string,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    quote?: Quote | null,
  ) => Promise<ReadonlyArray<OrderRecord>>;

  /** 清理指定标的的 API 订单缓存（不影响本地订单记录） */
  clearOrdersCacheForSymbol: (symbol: string) => void;

  /** 获取指定标的的买入订单 */
  getBuyOrdersForSymbol: (symbol: string, isLongSymbol: boolean) => ReadonlyArray<OrderRecord>;

  /** 提交卖出订单时调用（添加待成交追踪） */
  submitSellOrder: (
    orderId: string,
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
    relatedBuyOrderIds: readonly string[],
    submittedAtMs?: number,
  ) => void;

  /** 重置全部订单记录与 API 缓存 */
  resetAll: () => void;
}

/**
 * 成交后一致性刷新需求。
 * 类型用途：表达一次成交后需要补刷的最小账户/持仓刷新意图。
 * 数据来源：由订单监控成交结算链路在确认终态后组装。
 * 使用范围：orderMonitor、app runtime 与相关测试；全项目可引用。
 */
export type PostTradeConsistencyRefreshNeed = {
  readonly refreshAccount: boolean;
  readonly refreshPositions: boolean;
};

/**
 * 成交后一致性 fresh 事件。
 * 类型用途：表达 freshness 追平后的统一通知载荷，供事件驱动运行时与测试消费。
 * 数据来源：由 PostTradeConsistencyRuntime 在 refresh 成功或重建 baseline 完成时发出。
 * 使用范围：app runtime、事件运行时与相关测试使用。
 */
export type PostTradeConsistencyFreshReachedEvent = Readonly<{
  currentVersion: number;
  staleVersion: number;
  trigger: 'REFRESH' | 'REBUILD_BASELINE';
}>;

/**
 * 取消订阅函数。
 * 类型用途：统一表达事件监听注册返回的清理函数。
 * 数据来源：由各运行时/服务的 onXxx 订阅方法返回。
 * 使用范围：事件端口、服务端口与测试使用。
 */
export type Unsubscribe = () => void;

/**
 * 订单状态变化事件。
 * 类型用途：表达订单监控向外暴露的最小终态结算事件载荷。
 * 数据来源：由 orderMonitor 在订单完成本地结算后发出。
 * 使用范围：trader、orderMonitor、后续事件驱动 runtime 与相关测试使用。
 */
export type OrderStateChangedEvent = Readonly<{
  orderId: string;
  symbol: string | null;
  side: 'BUY' | 'SELL' | null;
  source: 'API' | 'WS' | 'STATE_CHECK' | 'RECOVERY';
  status: OrderClosedReason;
  monitorSymbol: string | null;
  isLongSymbol: boolean | null;
  isProtectiveLiquidation: boolean;
  executedPrice: number | null;
  executedQuantity: number | null;
  executedTimeMs: number | null;
}>;

/**
 * 订单保留标的集合变化事件。
 * 类型用途：表达本地未完成订单保留集合的 symbol 粒度增减，供 quote 订阅 runtime 维护 ORDER_HOLD retain。
 * 数据来源：由 OrderHoldRegistry 在 holdSymbols 实际新增或移除时发布。
 * 使用范围：Trader、QuoteSubscriptionRuntime 与相关测试。
 */
export type OrderHoldSymbolsChangedEvent = Readonly<{
  /** 发生变化的订单标的 */
  symbol: string;

  /** 保留集合变化方向 */
  action: 'ADDED' | 'REMOVED';
}>;

/**
 * 成交后一致性运行时最小端口。
 * 类型用途：向下层模块暴露成交后刷新需求记录能力，避免 core 反向依赖 app 层。
 * 数据来源：由 app 层成交后一致性 runtime 实现并注入。
 * 使用范围：trader/orderMonitor 与 app runtime 连接点。
 */
export interface PostTradeConsistencyRuntimePort {
  /** 记录一次成交后的最小刷新需求 */
  recordSettlementRefreshNeed: (need: PostTradeConsistencyRefreshNeed) => void;
}

/**
 * 成交后一致性 freshness 等待端口。
 * 类型用途：向卖出处理器、监控任务处理器等顶层等待方暴露统一的 freshness 等待能力。
 * 数据来源：由 app 层 PostTradeConsistencyRuntime 实现并注入。
 * 使用范围：asyncProgram 顶层等待链路使用。
 */
export interface PostTradeConsistencyFreshnessPort {
  /** 等待当前 freshness 追平 staleVersion；若当前生命周期已终止该等待轮次则立即失败 */
  waitForFresh: () => Promise<void>;

  /** 订阅 freshness 追平事件 */
  onFreshReached: (listener: (event: PostTradeConsistencyFreshReachedEvent) => void) => Unsubscribe;
}

/**
 * 交易器接口。
 * 类型用途：依赖注入用接口，封装 Longbridge 交易 API，提供账户/持仓、订单执行、订单监控与信号执行等。
 * 数据来源：实现层对接 Longbridge TradeContext；账户与订单数据来自 API。
 * 使用范围：主循环、MonitorContext、信号处理、门禁等；全项目可引用。
 */
export interface Trader {
  /** 订单记录器实例 */
  readonly orderRecorder: OrderRecorder;

  // ========== 账户相关 ==========

  /** 获取账户快照 */
  getAccountSnapshot: () => Promise<AccountSnapshot | null>;

  /** 获取持仓列表 */
  getStockPositions: (symbols?: ReadonlyArray<string> | null) => Promise<ReadonlyArray<Position>>;

  // ========== 订单缓存 ==========

  /** 获取待处理订单 */
  getPendingOrders: (
    symbols?: ReadonlyArray<string> | null,
    forceRefresh?: boolean,
  ) => Promise<ReadonlyArray<PendingOrder>>;

  /** 启动阶段种子化订单订阅保留集 */
  seedOrderHoldSymbols: (orders: ReadonlyArray<RawOrderFromAPI>) => void;

  /** 获取订单订阅保留标的集合 */
  getOrderHoldSymbols: () => ReadonlySet<string>;

  /** 订阅订单保留标的集合变化事件 */
  onOrderHoldSymbolsChanged: (
    listener: (event: OrderHoldSymbolsChangedEvent) => void,
  ) => Unsubscribe;

  // ========== 订单监控 ==========

  /** 撤销订单 */
  cancelOrder: (orderId: string) => Promise<CancelOrderOutcome>;

  /** 启动订单监控 runtime */
  startOrderMonitorRuntime: () => void;

  /** 停止订单监控 runtime 并等待在途处理完成 */
  stopOrderMonitorRuntimeAndDrain: () => Promise<void>;

  /** 是否存在指定监控标的方向的未完成保护性清仓卖单链路 */
  hasPendingProtectiveLiquidationOrders: (
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
  ) => boolean;

  /** 初始化订单监控（WebSocket 订阅） */
  initializeOrderMonitor: () => Promise<void>;

  /** 订阅订单终态结算事件 */
  onOrderStateChanged: (listener: (event: OrderStateChangedEvent) => void) => Unsubscribe;

  // ========== 订单执行 ==========

  /** 检查当前是否可交易 */
  canTradeNow: (signalAction: SignalType, monitorConfig?: MonitorConfig | null) => TradeCheckResult;

  /** 从 API 获取全量订单 */
  fetchAllOrdersFromAPI: (forceRefresh?: boolean) => Promise<ReadonlyArray<RawOrderFromAPI>>;

  /** 生命周期午夜清理：重置订单运行态缓存 */
  resetRuntimeState: () => void;

  /** 生命周期开盘重建：基于快照恢复订单追踪 */
  recoverOrderTrackingFromSnapshot: (allOrders: ReadonlyArray<RawOrderFromAPI>) => Promise<void>;

  /** 执行交易信号；返回实际提交数量与订单 ID 列表（保护性清仓等仅在真正提交后才更新缓存） */
  executeSignals: (
    signals: ReadonlyArray<Signal>,
  ) => Promise<{ submittedCount: number; submittedOrderIds: ReadonlyArray<string> }>;
}

/**
 * 牛熊证类型。
 * 类型用途：区分牛证（做多）与熊证（做空），用于 RiskCheckResult、WarrantDistanceInfo 等字段。
 * 数据来源：Longbridge 行情静态信息或 RiskChecker 解析。
 * 使用范围：RiskChecker、UI/监控展示等；全项目可引用。
 */
export type BullBearWarrantType = 'BULL' | 'BEAR';

/**
 * 牛熊证距离回收价信息。
 * 类型用途：表示某标的距离回收价的百分比，用于实时展示与风控判断。
 * 数据来源：RiskChecker 根据行情与回收价计算。
 * 使用范围：RiskChecker、UI/监控展示；全项目可引用。
 */
export type WarrantDistanceInfo = {
  /** 牛熊证类型 */
  readonly warrantType: BullBearWarrantType;

  /** 距离回收价百分比（运行时保持 Decimal 精度，展示时再格式化） */
  readonly distanceToStrikePercent: Decimal | null;
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
  readonly warrantType?: BullBearWarrantType;

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
    readonly warrantType: BullBearWarrantType;

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

  /** dailyLossOffset: 当日亏损偏移（仅记录亏损，<=0） */
  readonly dailyLossOffset?: number;

  /** 最后更新时间戳 */
  readonly lastUpdateTime: number;
};

/**
 * 浮亏实时指标。
 * 类型用途：基于浮亏缓存和当前价格计算的实时持仓指标，供行情展示等非清仓场景使用。
 * 数据来源：RiskChecker 读取 UnrealizedLossData 并结合最新价格计算得到。
 * 使用范围：marketMonitor、processMonitor 风险任务等；全项目可引用。
 */
export type UnrealizedLossMetrics = {
  /** r1: 调整后的开仓成本 */
  readonly r1: number;

  /** n1: 持仓数量 */
  readonly n1: number;

  /** r2: 当前持仓市值 */
  readonly r2: number;

  /** 持仓盈亏（r2 - r1） */
  readonly unrealizedPnL: number;
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
  update: (positions: ReadonlyArray<Position>) => void;

  /** 获取指定标的的持仓 */
  get: (symbol: string) => Position | null;
}

/**
 * 末日保护买入门禁最小契约。
 * 类型用途：仅约束风险检查链路对末日保护买入截止窗口的依赖行为，避免类型层反向依赖业务实现。
 * 数据来源：由 doomsdayProtection 模块实现并注入。
 * 使用范围：RiskCheckContext 与买入风险检查链路使用。
 */
interface DoomsdayBuyGuard {
  /** 检查买入截止窗口当前是否生效 */
  isBuyCutoffWindowActive: (currentTime: Date, isHalfDay: boolean) => boolean;
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

  /** 账户缓存（卖出基础风险检查与日志共用） */
  readonly account: AccountSnapshot | null;

  /** 持仓缓存（卖出基础风险检查与日志共用） */
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
  readonly doomsdayProtection: DoomsdayBuyGuard;

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
  setWarrantInfoFromCallPrice: (
    symbol: string,
    callPrice: number,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ) => WarrantRefreshResult;

  /** 刷新单个标的的牛熊证信息 */
  refreshWarrantInfoForSymbol: (
    marketDataClient: MarketDataClient,
    symbol: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ) => Promise<WarrantRefreshResult>;

  /** 订单前风险检查（持仓限制） */
  checkBeforeOrder: (params: {
    readonly account: AccountSnapshot | null;
    readonly positions: ReadonlyArray<Position> | null;
    readonly signal: Signal | null;
    readonly orderNotional: number;
  }) => RiskCheckResult;

  /** 牛熊证风险检查（距离回收价阈值） */
  checkWarrantRisk: (
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: number,
  ) => RiskCheckResult;

  /** 牛熊证距回收价清仓检查 */
  checkWarrantDistanceLiquidation: (
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: number,
  ) => WarrantDistanceLiquidationResult;

  /** 获取牛熊证距离回收价信息（实时展示用） */
  getWarrantDistanceInfo: (
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: number | null,
  ) => WarrantDistanceInfo | null;

  /** 清空做多标的牛熊证信息缓存（换标时调用） */
  clearLongWarrantInfo: () => void;

  /** 清空做空标的牛熊证信息缓存（换标时调用） */
  clearShortWarrantInfo: () => void;

  /** 刷新浮亏数据 */
  refreshUnrealizedLossData: (
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
    quote?: Quote | null,
    dailyLossOffset?: number,
  ) => Promise<{ r1: number; n1: number } | null>;

  /** 浮亏检查（是否触发强平） */
  checkUnrealizedLoss: (
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ) => UnrealizedLossCheckResult;

  /** 获取实时浮亏指标（用于展示持仓市值与持仓盈亏） */
  getUnrealizedLossMetrics: (
    symbol: string,
    currentPrice: number | null,
  ) => UnrealizedLossMetrics | null;

  /** 清空浮亏缓存（symbol 为空时清空全部） */
  clearUnrealizedLossData: (symbol?: string | null) => void;
}
