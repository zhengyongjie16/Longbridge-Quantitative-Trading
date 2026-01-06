/**
 * 订单执行模块类型定义
 */

import type { OrderSide, OrderType, TimeInForceType, TradeContext } from 'longport';
import type { Signal, Quote, AccountSnapshot, Position } from '../../types/index.js';
import type { PendingOrder } from '../type.js';

/**
 * 默认订单配置类型
 */
export type OrderOptions = {
  readonly symbol: string;
  readonly targetNotional: number;
  readonly quantity: number;
  readonly orderType: typeof OrderType[keyof typeof OrderType];
  readonly timeInForce: typeof TimeInForceType[keyof typeof TimeInForceType];
  readonly remark: string;
  readonly price?: number;
};

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

/**
 * 交易检查结果类型
 */
export type TradeCheckResult = {
  readonly canTrade: boolean;
  readonly waitSeconds?: number;
  readonly direction?: 'LONG' | 'SHORT';
  readonly reason?: string;
};

/**
 * 订单对象类型（用于修改订单）
 */
export type OrderForReplace = {
  readonly orderId: string;
  readonly status: import('longport').OrderStatus;
  readonly executedQuantity: unknown;
  readonly quantity: unknown;
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
  hasPendingBuyOrders(symbols: string[], orderRecorder?: import('../orderRecorder/index.js').OrderRecorder | null): Promise<boolean>;
}

/**
 * 订单监控器接口
 */
export interface OrderMonitor {
  enableMonitoring(): void;
  cancelOrder(orderId: string): Promise<boolean>;
  replaceOrderPrice(orderId: string, newPrice: number, quantity?: number | null, cachedOrder?: PendingOrder | null): Promise<void>;
  monitorAndManageOrders(longQuote: Quote | null, shortQuote: Quote | null): Promise<void>;
}

/**
 * 订单执行器接口
 */
export interface OrderExecutor {
  canTradeNow(signalAction: string): TradeCheckResult;
  executeSignals(signals: Signal[]): Promise<void>;
}

/**
 * 交易器接口（门面）
 */
export interface Trader {
  readonly _ctxPromise: Promise<TradeContext>;

  // 账户相关方法
  getAccountSnapshot(): Promise<AccountSnapshot | null>;
  getStockPositions(symbols?: string[] | null): Promise<Position[]>;

  // 订单缓存相关方法
  getPendingOrders(symbols?: string[] | null, forceRefresh?: boolean): Promise<PendingOrder[]>;
  clearPendingOrdersCache(): void;
  hasPendingBuyOrders(symbols: string[], orderRecorder?: import('../orderRecorder/index.js').OrderRecorder | null): Promise<boolean>;

  // 订单监控相关方法
  enableBuyOrderMonitoring(): void;
  cancelOrder(orderId: string): Promise<boolean>;
  replaceOrderPrice(orderId: string, newPrice: number, quantity?: number | null, cachedOrder?: PendingOrder | null): Promise<void>;
  monitorAndManageOrders(longQuote: Quote | null, shortQuote: Quote | null): Promise<void>;

  // 订单执行相关方法
  _canTradeNow(signalAction: string): TradeCheckResult;
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
 * 订单监控器依赖类型
 */
export type OrderMonitorDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
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
