/**
 * 交易执行模块类型定义
 *
 * 包含：
 * - 订单相关类型：OrderPayload、TradeRecord、TrackedOrder
 * - 服务接口：AccountService、OrderCacheManager、OrderMonitor、OrderExecutor
 * - 依赖注入类型：各服务的 Deps 类型
 * - 配置类型：RateLimiterConfig、OrderMonitorConfig
 */
import type { OrderSide, OrderType, OrderStatus, TimeInForceType, TradeContext, PushOrderChanged } from 'longport';
import type {
  Signal,
  Quote,
  AccountSnapshot,
  Position,
  PendingOrder,
  TradeCheckResult,
  RateLimiter,
  PendingRefreshSymbol,
  MultiMonitorTradingConfig,
  SymbolRegistry,
  RawOrderFromAPI,
} from '../../types/index.js';
import type { LiquidationCooldownTracker } from '../../services/liquidationCooldown/types.js';
import type { DailyLossTracker } from '../risk/types.js';
import type { RefreshGate } from '../../utils/refreshGate/types.js';

/**
 * 订单提交载荷
 * 用于调用 ctx.submitOrder() 时的参数
 */
export type OrderPayload = {
  readonly symbol: string;
  readonly orderType: typeof OrderType[keyof typeof OrderType];
  readonly side: typeof OrderSide[keyof typeof OrderSide];
  readonly timeInForce: typeof TimeInForceType[keyof typeof TimeInForceType];
  readonly submittedQuantity: import('longport').Decimal;
  readonly submittedPrice?: import('longport').Decimal;
  readonly remark?: string;
};

/**
 * 交易记录（用于日志持久化）
 * 记录每笔交易的完整信息，保存到 JSON 文件
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
  /** 信号触发时间（北京时间字符串） */
  readonly signalTriggerTime: string | null;
  /** 成交时间（北京时间字符串） */
  readonly executedAt: string | null;
  /** 成交时间（毫秒时间戳） */
  readonly executedAtMs: number | null;
  /** 日志记录时间（北京时间字符串） */
  readonly timestamp: string | null;
  /** 是否为保护性清仓（浮亏超阈值触发） */
  readonly isProtectiveClearance: boolean | null;
};

/**
 * 错误类型标识
 * 用于识别 API 错误的具体类型，便于针对性处理
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
 * 账户服务接口
 */
export interface AccountService {
  getAccountSnapshot(): Promise<AccountSnapshot | null>;
  getStockPositions(symbols?: string[] | null): Promise<Position[]>;
}

/**
 * 订单缓存管理器接口
 */
export interface OrderCacheManager {
  getPendingOrders(symbols?: string[] | null, forceRefresh?: boolean): Promise<PendingOrder[]>;
  clearCache(): void;
  hasPendingBuyOrders(symbols: string[], orderRecorder?: import('../../types/index.js').OrderRecorder | null): Promise<boolean>;
}

/**
 * 订单监控器接口（重构后）
 */
export interface OrderMonitor {
  /** 初始化 WebSocket 订阅 */
  initialize(): Promise<void>;

  /**
   * 开始追踪订单
   * @param orderId 订单ID
   * @param symbol 标的代码
   * @param side 订单方向
   * @param price 委托价格
   * @param quantity 委托数量
   * @param isLongSymbol 是否为做多标的
   */
  trackOrder(
    orderId: string,
    symbol: string,
    side: OrderSide,
    price: number,
    quantity: number,
    isLongSymbol: boolean,
    monitorSymbol: string | null,
    isProtectiveLiquidation: boolean,
  ): void;

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

  /**
   * 获取并清空待刷新浮亏数据的标的列表
   * 订单成交后会将标的添加到此列表，主循环中应调用此方法获取并刷新
   *
   * @returns 待刷新的标的列表（调用后列表会被清空）
   */
  getAndClearPendingRefreshSymbols(): PendingRefreshSymbol[];

  /** 销毁监控器 */
  destroy(): Promise<void>;
}

/**
 * 订单执行器接口
 */
export interface OrderExecutor {
  canTradeNow(signalAction: string, monitorConfig?: import('../../types/index.js').MonitorConfig | null): TradeCheckResult;
  /**
   * 标记买入意图（预占买入时间槽）
   * 在 signalProcessor 检查通过后立即调用，防止同一批次中的多个信号同时通过频率检查
   * @param signalAction 信号类型（BUYCALL 或 BUYPUT）
   * @param monitorConfig 监控配置
   */
  markBuyAttempt(signalAction: string, monitorConfig?: import('../../types/index.js').MonitorConfig | null): void;
  executeSignals(signals: Signal[]): Promise<void>;
}

/**
 * 频率限制器配置类型
 */
export type RateLimiterConfig = {
  readonly maxCalls: number;
  readonly windowMs: number;
};

/**
 * 频率限制器依赖类型
 */
export type RateLimiterDeps = {
  readonly config?: RateLimiterConfig;
};

/**
 * 账户服务依赖类型
 */
export type AccountServiceDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

/**
 * 订单缓存管理器依赖类型
 */
export type OrderCacheManagerDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

/**
 * 追踪中的订单信息
 * 用于 WebSocket 监控订单状态变化，跟踪委托价和成交情况
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
  /** 当前委托价（会随市价更新） */
  submittedPrice: number;
  readonly submittedQuantity: number;
  /** 已成交数量（部分成交时累加） */
  executedQuantity: number;
  status: OrderStatus;
  /** 提交时间戳（用于超时检测） */
  readonly submittedAt: number;
  /** 上次修改价格的时间（用于控制修改频率） */
  lastPriceUpdateAt: number;
  /** 是否已转为市价单（防止重复转换） */
  convertedToMarket: boolean;
};

/**
 * 订单监控配置
 */
export interface OrderMonitorConfig {
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
}

/**
 * 订单订阅保留集管理器
 */
export type OrderHoldRegistry = {
  trackOrder(orderId: string, symbol: string): void;
  markOrderFilled(orderId: string): void;
  seedFromOrders(orders: ReadonlyArray<RawOrderFromAPI>): void;
  getHoldSymbols(): ReadonlySet<string>;
};

/**
 * 订单监控器依赖类型
 */
export type OrderMonitorDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  /** 订单记录器（用于成交后更新本地记录） */
  readonly orderRecorder: import('../../types/index.js').OrderRecorder;
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
};

/**
 * 订单执行器依赖类型
 */
export type OrderExecutorDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  readonly orderMonitor: OrderMonitor;
  /** 全局交易配置 */
  readonly tradingConfig: MultiMonitorTradingConfig;
  /** 标的注册表（用于解析动态标的归属） */
  readonly symbolRegistry: SymbolRegistry;
};

/**
 * 交易器依赖类型
 */
export type TraderDeps = {
  readonly config: import('longport').Config;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly rateLimiterConfig?: RateLimiterConfig;
  /** 标的注册表（用于动态标的映射） */
  readonly symbolRegistry: SymbolRegistry;
  readonly dailyLossTracker: DailyLossTracker;
  /** 刷新门禁（成交后标记 stale） */
  readonly refreshGate?: RefreshGate;
};
