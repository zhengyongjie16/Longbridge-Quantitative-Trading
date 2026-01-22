/**
 * 订单记录模块类型定义
 */

import type { OrderSide, OrderStatus, OrderType, TradeContext } from 'longport';
import type { DecimalLikeValue, PendingOrder, OrderRecord, FetchOrdersResult, Quote, RateLimiter } from '../../types/index.js';

/**
 * API 返回的原始订单类型（用于类型安全的转换）
 */
export type RawOrderFromAPI = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly status: OrderStatus;
  readonly orderType: OrderType;
  readonly price: DecimalLikeValue;
  readonly quantity: DecimalLikeValue;
  readonly executedPrice: DecimalLikeValue;
  readonly executedQuantity: DecimalLikeValue;
  readonly submittedAt?: Date;
  readonly updatedAt?: Date;
};

/**
 * 订单缓存类型
 */
export type OrderCache = {
  readonly buyOrders: ReadonlyArray<OrderRecord>;
  readonly sellOrders: ReadonlyArray<OrderRecord>;
  readonly allOrders: ReadonlyArray<RawOrderFromAPI> | null;
  readonly fetchTime: number;
};

/**
 * 订单统计信息类型（用于调试输出）
 */
export type OrderStatistics = {
  readonly totalQuantity: number;
  readonly totalValue: number;
  readonly averagePrice: number;
};

/**
 * 过滤算法的中间结果类型
 */
export type FilteringState = {
  readonly m0Orders: ReadonlyArray<OrderRecord>;
  readonly candidateOrders: ReadonlyArray<OrderRecord>;
};

// ==================== 服务接口定义 ====================

/**
 * 订单存储接口
 */
export interface OrderStorage {
  getBuyOrdersList(symbol: string, isLongSymbol: boolean): OrderRecord[];
  setBuyOrdersListForLong(symbol: string, newList: OrderRecord[]): void;
  setBuyOrdersListForShort(symbol: string, newList: OrderRecord[]): void;
  addBuyOrder(symbol: string, executedPrice: number, executedQuantity: number, isLongSymbol: boolean): void;
  updateAfterSell(symbol: string, executedPrice: number, executedQuantity: number, isLongSymbol: boolean): void;
  clearBuyOrders(symbol: string, isLongSymbol: boolean, quote?: Quote | null): void;
  getLatestBuyOrderPrice(symbol: string, isLongSymbol: boolean): number | null;
  getBuyOrdersBelowPrice(currentPrice: number, direction: 'LONG' | 'SHORT', symbol: string): OrderRecord[];
  calculateTotalQuantity(orders: OrderRecord[]): number;
  getLongBuyOrders(): OrderRecord[];
  getShortBuyOrders(): OrderRecord[];
}

/**
 * 订单过滤引擎接口
 */
export interface OrderFilteringEngine {
  applyFilteringAlgorithm(allBuyOrders: OrderRecord[], filledSellOrders: OrderRecord[]): OrderRecord[];
}

/**
 * 订单API管理器接口
 */
export interface OrderAPIManager {
  fetchOrdersFromAPI(symbol: string): Promise<FetchOrdersResult>;
  hasCacheForSymbols(symbols: string[]): boolean;
  getPendingOrdersFromCache(symbols: string[]): PendingOrder[];
}

// ==================== 依赖类型定义 ====================

/**
 * 订单存储依赖类型
 */
export type OrderStorageDeps = Record<string, never>;

/**
 * 订单过滤引擎依赖类型
 */
export type OrderFilteringEngineDeps = Record<string, never>;

/**
 * 订单API管理器依赖类型
 */
export type OrderAPIManagerDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

/**
 * 订单记录器依赖类型
 *
 * 重构说明：
 * - 移除对 Trader 的依赖，改为直接依赖 ctxPromise
 * - 消除过度依赖，使模块可被 orderMonitor 引用
 * - 添加 rateLimiter 以控制 Trade API 调用频率
 */
export type OrderRecorderDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

