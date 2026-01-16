/**
 * 订单执行模块类型定义
 */

import type { OrderSide, OrderType, OrderStatus, TimeInForceType, TradeContext } from 'longport';
import type { Signal, Quote, AccountSnapshot, Position, PendingOrder, TradeCheckResult } from '../../types/index.js';

/**
 * 订单载荷类型
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
 * 交易记录类型
 */
export type TradeRecord = {
  readonly orderId?: string;
  readonly symbol: string;
  readonly symbolName?: string | null;
  readonly action?: string;
  readonly side?: string;
  readonly quantity?: string;
  readonly price?: string;
  readonly orderType?: string;
  readonly status?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly signalTriggerTime?: Date | string | null;
  readonly timestamp?: string;
};

/**
 * 错误类型标识类型
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
 * 频率限制器接口
 */
export interface RateLimiter {
  throttle(): Promise<void>;
}

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
 * 需要刷新浮亏数据的标的信息
 */
export interface PendingRefreshSymbol {
  readonly symbol: string;
  readonly isLongSymbol: boolean;
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
 * 待追踪订单信息（用于 WebSocket 推送方案）
 */
export interface TrackedOrder {
  /** 订单ID */
  readonly orderId: string;
  /** 标的代码 */
  readonly symbol: string;
  /** 订单方向 */
  readonly side: OrderSide;
  /** 是否为做多标的（用于成交后更新本地记录） */
  readonly isLongSymbol: boolean;
  /** 委托价格 */
  submittedPrice: number;
  /** 委托数量 */
  readonly submittedQuantity: number;
  /** 已成交数量 */
  executedQuantity: number;
  /** 订单状态 */
  status: OrderStatus;
  /** 订单提交时间（用于超时检测） */
  readonly submittedAt: number;
  /** 最后一次修改价格的时间 */
  lastPriceUpdateAt: number;
  /** 是否已转为市价单 */
  convertedToMarket: boolean;
}

/**
 * 订单监控配置
 */
export interface OrderMonitorConfig {
  /** 超时时间（毫秒），默认 3 分钟 */
  readonly timeoutMs: number;
  /** 价格修改最小间隔（毫秒），避免频繁修改 */
  readonly priceUpdateIntervalMs: number;
  /** 价格差异阈值，低于此值不修改 */
  readonly priceDiffThreshold: number;
}

/**
 * 订单监控器依赖类型
 */
export type OrderMonitorDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  /** 订单记录器（用于成交后更新本地记录） */
  readonly orderRecorder: import('../../types/index.js').OrderRecorder;
};

/**
 * 订单执行器依赖类型
 */
export type OrderExecutorDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  readonly orderMonitor: OrderMonitor;
};

/**
 * 交易器依赖类型
 */
export type TraderDeps = {
  readonly config?: import('longport').Config | null;
};
