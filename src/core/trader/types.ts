import type { Config, Decimal, OrderSide, OrderType, OrderStatus, TimeInForceType, TradeContext, PushOrderChanged } from 'longport';
import type { Signal, SignalType, OrderTypeConfig } from '../../types/signal.js';
import type { Quote } from '../../types/quote.js';
import type { AccountSnapshot, Position } from '../../types/account.js';
import type { MonitorConfig, MultiMonitorTradingConfig } from '../../types/config.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type {
  PendingOrder,
  TradeCheckResult,
  RateLimiter,
  PendingRefreshSymbol,
  RawOrderFromAPI,
  OrderRecorder,
} from '../../types/services.js';
import type { LiquidationCooldownTracker } from '../../services/liquidationCooldown/types.js';
import type { DailyLossTracker } from '../riskController/types.js';
import type { RefreshGate } from '../../utils/refreshGate/types.js';

/**
 * 订单提交 API 可能返回的响应形状。
 * 类型用途：用于 extractOrderId 安全提取订单 ID。
 * 数据来源：由 LongPort API 的 submitOrder 响应返回。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderSubmitResponse = {
  readonly orderId?: string;
};

/**
 * 订单提交载荷。
 * 类型用途：封装调用 ctx.submitOrder() 时的参数。
 * 数据来源：模块内部根据信号与配置构造。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderPayload = {
  readonly symbol: string;
  readonly orderType: OrderType;
  readonly side: OrderSide;
  readonly timeInForce: TimeInForceType;
  readonly submittedQuantity: Decimal;
  readonly submittedPrice?: Decimal;
  readonly remark?: string;
};

/**
 * 订单追踪入参。
 * 类型用途：传递给 OrderMonitor.trackOrder() 的参数，用于追踪订单状态变化。
 * 数据来源：提交订单后由 OrderExecutor 等构造。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type TrackOrderParams = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly price: number;
  readonly quantity: number;
  readonly isLongSymbol: boolean;
  readonly monitorSymbol: string | null;
  readonly isProtectiveLiquidation: boolean;
  readonly orderType: OrderType;
};

/**
 * 提交订单入参
 * 用途：传递给内部 submitOrder 函数的参数，封装订单提交所需的完整上下文
 * 使用范围：仅在 trader 模块内部使用
 */
export type SubmitOrderParams = {
  readonly ctx: TradeContext;
  readonly signal: Signal;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly submittedQtyDecimal: Decimal;
  readonly orderTypeParam: OrderType;
  readonly timeInForce: TimeInForceType;
  readonly remark: string | undefined;
  readonly overridePrice: number | undefined;
  readonly isShortSymbol: boolean;
  readonly monitorConfig?: MonitorConfig | null;
};

/**
 * 订单类型解析配置（信号级覆盖 / 保护性清仓 / 全局类型）
 * 用途：封装订单类型解析所需的全局配置
 * 使用范围：仅在 trader 模块内部使用
 */
export type OrderTypeResolutionConfig = {
  readonly tradingOrderType: OrderTypeConfig;
  readonly liquidationOrderType: OrderTypeConfig;
};

/**
 * 交易记录。
 * 类型用途：用于日志持久化（JSON 文件），单条成交或订单状态变更的日志结构。
 * 数据来源：由 TradeLogger、OrderMonitor 等根据订单与信号构造并写入文件。
 * 使用范围：trader 模块内部与日志持久化；外部仅读取日志文件时使用。
 */
export type TradeRecord = {
  readonly orderId: string | null;
  /** 交易标的代码（如 55131.HK） */
  readonly symbol: string | null;
  /** 交易标的名称（如 阿里摩通六甲牛G） */
  readonly symbolName: string | null;
  /** 监控标的代码（如 HSI.HK） */
  readonly monitorSymbol: string | null;
  /** 信号动作（BUYCALL/SELLCALL/BUYPUT/SELLPUT） */
  readonly action: string | null;
  /** 订单方向（BUY/SELL） */
  readonly side: string | null;
  /** 成交数量 */
  readonly quantity: string | null;
  /** 成交价格 */
  readonly price: string | null;
  /** 订单类型（可为空） */
  readonly orderType: string | null;
  /** 订单状态（成交日志仅记录 FILLED） */
  readonly status: string | null;
  /** 错误信息（成交日志默认 null） */
  readonly error: string | null;
  /** 信号原因 */
  readonly reason: string | null;
  /** 信号触发时间（香港时间字符串） */
  readonly signalTriggerTime: string | null;
  /** 成交时间（香港时间字符串） */
  readonly executedAt: string | null;
  /** 成交时间（毫秒时间戳） */
  readonly executedAtMs: number | null;
  /** 日志记录时间（香港时间字符串） */
  readonly timestamp: string | null;
  /** 是否为保护性清仓（浮亏超阈值触发） */
  readonly isProtectiveClearance: boolean | null;
};

/**
 * 错误类型标识
 * 用途：识别 API 错误的具体类型，便于针对性处理（如重试、跳过、记录日志）
 * 使用范围：仅在 trader 模块内部使用
 */
export type ErrorTypeIdentifier = {
  readonly isShortSellingNotSupported: boolean;
  readonly isInsufficientFunds: boolean;
  readonly isOrderNotFound: boolean;
  readonly isNetworkError: boolean;
  readonly isRateLimited: boolean;
};

// ==================== 服务接口定义 ====================

/**
 * 账户服务接口。
 * 由 Trader 依赖注入，仅 trader 模块内部实现使用。
 */
export interface AccountService {
  getAccountSnapshot(): Promise<AccountSnapshot | null>;
  getStockPositions(symbols?: string[] | null): Promise<Position[]>;
}

/**
 * 订单缓存管理器接口。
 * 由 Trader 依赖注入，仅 trader 模块内部实现使用。
 */
export interface OrderCacheManager {
  getPendingOrders(symbols?: string[] | null, forceRefresh?: boolean): Promise<PendingOrder[]>;
  clearCache(): void;
}

/**
 * 订单监控器接口。
 * 由 Trader 依赖注入。
 */
export interface OrderMonitor {
  /** 初始化 WebSocket 订阅 */
  initialize(): Promise<void>;

  /** 开始追踪订单 */
  trackOrder(params: TrackOrderParams): void;

  /** 撤销订单 */
  cancelOrder(orderId: string): Promise<boolean>;

  /** 修改订单价格 */
  replaceOrderPrice(orderId: string, newPrice: number, quantity?: number | null): Promise<void>;

  /**
   * 处理价格更新（主循环调用）
   * 根据最新行情价格，更新未成交订单的委托价
   */
  processWithLatestQuotes(quotesMap: ReadonlyMap<string, Quote | null>): Promise<void>;

  /** 恢复订单追踪（程序启动时调用） */
  recoverTrackedOrders(): Promise<void>;

  /** 获取指定标的的未成交卖单快照 */
  getPendingSellOrders(symbol: string): ReadonlyArray<PendingSellOrderSnapshot>;

  /**
   * 获取并清空待刷新浮亏数据的标的列表
   * 订单成交后会将标的添加到此列表，主循环中应调用此方法获取并刷新
   *
   * @returns 待刷新的标的列表（调用后列表会被清空）
   */
  getAndClearPendingRefreshSymbols(): PendingRefreshSymbol[];

  /** 清空 trackedOrders 与 pendingRefreshSymbols */
  clearTrackedOrders(): void;
}

/**
 * 订单执行器接口。
 * 由 Trader 依赖注入。
 */
export interface OrderExecutor {
  canTradeNow(signalAction: SignalType, monitorConfig?: MonitorConfig | null): TradeCheckResult;
  /**
   * 标记买入意图（预占买入时间槽）
   * 在 signalProcessor 检查通过后立即调用，防止同一批次中的多个信号同时通过频率检查
   * @param signalAction 信号类型（BUYCALL 或 BUYPUT）
   * @param monitorConfig 监控配置
   */
  markBuyAttempt(signalAction: SignalType, monitorConfig?: MonitorConfig | null): void;
  executeSignals(signals: Signal[]): Promise<{ submittedCount: number }>;
  /** 清空 lastBuyTime（买入节流状态） */
  resetBuyThrottle(): void;
}

/**
 * 频率限制器配置。
 * 用于 trader 模块内建限流器。
 */
export type RateLimiterConfig = {
  readonly maxCalls: number;
  readonly windowMs: number;
};

/**
 * 频率限制器依赖。
 * 用于创建 RateLimiter 实例时的依赖注入。
 */
export type RateLimiterDeps = {
  readonly config?: RateLimiterConfig;
};

/**
 * 账户服务依赖。
 * 用于创建 AccountService 时的依赖注入。
 */
export type AccountServiceDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

/**
 * 订单缓存管理器依赖。
 * 类型用途：用于创建 OrderCacheManager 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderCacheManagerDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

/**
 * 追踪中的订单信息。
 * 类型用途：OrderMonitor 内部存储，用于 WebSocket 监控订单状态变化，跟踪委托价和成交情况。
 * 数据来源：由 trackOrder 入参初始化，状态由 WebSocket 推送更新。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type TrackedOrder = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  /** 是否为做多标的（成交后更新本地记录时使用） */
  readonly isLongSymbol: boolean;
  /** 监控标的代码（用于成交日志与冷却恢复） */
  readonly monitorSymbol: string | null;
  /** 是否为保护性清仓订单（用于触发买入冷却） */
  readonly isProtectiveLiquidation: boolean;
  /** 订单类型（用于合并和改单判断） */
  readonly orderType: OrderType;
  /** 当前委托价（会随市价更新） */
  submittedPrice: number;
  /** 委托数量（含部分成交后的剩余总量） */
  submittedQuantity: number;
  /** 已成交数量（部分成交时累加） */
  executedQuantity: number;
  /** 当前订单状态（由 WebSocket 推送更新） */
  status: OrderStatus;
  /** 提交时间戳（用于超时检测） */
  readonly submittedAt: number;
  /** 上次修改价格的时间（用于控制修改频率） */
  lastPriceUpdateAt: number;
  /** 是否已转为市价单（防止重复转换） */
  convertedToMarket: boolean;
};

/**
 * 未成交卖单快照（用于卖单合并决策）。
 * 类型用途：提供卖单合并决策所需的订单状态信息。
 * 数据来源：OrderMonitor.getPendingSellOrders 返回。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type PendingSellOrderSnapshot = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly status: OrderStatus;
  readonly orderType: OrderType;
  readonly submittedPrice: number;
  readonly submittedQuantity: number;
  readonly executedQuantity: number;
  readonly submittedAt: number;
};

/**
 * 卖单合并决策动作
 * SUBMIT：直接提交新卖单；REPLACE：修改现有卖单价格/数量；CANCEL_AND_SUBMIT：撤销现有卖单后重新提交；SKIP：跳过本次卖出
 * 仅在 trader 模块内部使用
 */
export type SellMergeDecisionAction = 'SUBMIT' | 'REPLACE' | 'CANCEL_AND_SUBMIT' | 'SKIP';

/**
 * 卖单合并决策输入
 * 由 OrderExecutor 在提交卖单前构造，传入 decideSellMerge 函数以决定合并策略
 * 仅在 trader 模块内部使用
 */
export type SellMergeDecisionInput = {
  readonly symbol: string;
  readonly pendingOrders: ReadonlyArray<PendingSellOrderSnapshot>;
  readonly newOrderQuantity: number;
  readonly newOrderPrice: number | null;
  readonly newOrderType: OrderType;
  readonly isProtectiveLiquidation: boolean;
};

/**
 * 卖单合并决策结果
 * 由 decideSellMerge 函数返回，OrderExecutor 根据 action 字段执行对应的下单/改单/撤单操作
 * 仅在 trader 模块内部使用
 */
export type SellMergeDecision = {
  readonly action: SellMergeDecisionAction;
  readonly mergedQuantity: number;
  readonly targetOrderId: string | null;
  readonly price: number | null;
  readonly pendingOrderIds: ReadonlyArray<string>;
  readonly pendingRemainingQuantity: number;
  readonly reason:
    | 'no-additional-quantity'
    | 'no-pending-sell'
    | 'cancel-and-merge'
    | 'replace-and-merge';
};

/**
 * 订单监控配置。
 * 类型用途：控制订单超时转换和价格修改行为。
 * 数据来源：如适用（来自交易配置等）。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderMonitorConfig = {
  readonly buyTimeout: {
    readonly enabled: boolean;
    readonly timeoutMs: number;
  };
  readonly sellTimeout: {
    readonly enabled: boolean;
    readonly timeoutMs: number;
  };
  /** 价格修改最小间隔（毫秒） */
  readonly priceUpdateIntervalMs: number;
  /** 价格差异阈值（低于此值不触发修改） */
  readonly priceDiffThreshold: number;
};

/**
 * 订单订阅保留集管理器。
 * 类型用途：依赖注入的服务接口，跟踪需持续订阅的订单标的、恢复订阅状态、成交后移除标记。
 * 数据来源：如适用。
 * 使用范围：由 Trader/OrderMonitor 依赖注入，仅 trader 模块实现与使用。
 */
export interface OrderHoldRegistry {
  /** 跟踪订单（添加标的到订阅保留集） */
  trackOrder(orderId: string, symbol: string): void;
  /** 标记订单已成交（从订阅保留集中移除） */
  markOrderFilled(orderId: string): void;
  /** 从历史订单初始化订阅保留集（程序重启时调用） */
  seedFromOrders(orders: ReadonlyArray<RawOrderFromAPI>): void;
  /** 获取当前需要持续订阅的标的集合 */
  getHoldSymbols(): ReadonlySet<string>;
  /** 清空内部 map/set */
  clear(): void;
}

/**
 * 订单监控器依赖。
 * 类型用途：用于创建 OrderMonitor 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderMonitorDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  /** 订单记录器（用于成交后更新本地记录） */
  readonly orderRecorder: OrderRecorder;
  /** 当日亏损跟踪器（成交后增量记录） */
  readonly dailyLossTracker: DailyLossTracker;
  /** 订单订阅保留集 */
  readonly orderHoldRegistry: OrderHoldRegistry;
  /** 清仓冷却追踪器（用于记录保护性清仓） */
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  /** 标的注册表（用于解析动态标的归属） */
  readonly symbolRegistry: SymbolRegistry;
  /** 可选测试钩子（仅用于单元测试） */
  readonly testHooks?: {
    readonly setHandleOrderChanged?: (handler: (event: PushOrderChanged) => void) => void;
  };
  /** 全局交易配置 */
  readonly tradingConfig: MultiMonitorTradingConfig;
  /** 刷新门禁（成交后标记 stale） */
  readonly refreshGate?: RefreshGate;
  /** 运行时执行门禁（卖单超时转市价单时校验，禁止门禁关闭时新开单） */
  readonly isExecutionAllowed: IsExecutionAllowed;
};

/**
 * 运行时执行门禁：返回当前是否允许下单
 * 门禁关闭时 orderExecutor 仅记录日志并跳过，不下单
 */
export type IsExecutionAllowed = () => boolean;

/**
 * 订单执行器依赖。
 * 类型用途：用于创建 OrderExecutor 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderExecutorDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  readonly orderMonitor: OrderMonitor;
  /** 订单记录器（用于卖出订单防重追踪） */
  readonly orderRecorder: OrderRecorder;
  /** 全局交易配置 */
  readonly tradingConfig: MultiMonitorTradingConfig;
  /** 标的注册表（用于解析动态标的归属） */
  readonly symbolRegistry: SymbolRegistry;
  /** 运行时执行门禁（单一状态源注入，执行层统一判定） */
  readonly isExecutionAllowed: IsExecutionAllowed;
};

/**
 * 交易器依赖。
 * 类型用途：用于创建顶层 Trader 实例时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：见调用方（启动层等）。
 */
export type TraderDeps = {
  readonly config: Config;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly rateLimiterConfig?: RateLimiterConfig;
  /** 标的注册表（用于动态标的映射） */
  readonly symbolRegistry: SymbolRegistry;
  readonly dailyLossTracker: DailyLossTracker;
  /** 刷新门禁（成交后标记 stale） */
  readonly refreshGate?: RefreshGate;
  /** 运行时执行门禁（单一状态源注入，执行层统一判定） */
  readonly isExecutionAllowed: IsExecutionAllowed;
};
