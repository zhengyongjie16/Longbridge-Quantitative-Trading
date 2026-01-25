/**
 * 订单记录模块类型定义
 *
 * 本文件定义了订单记录模块所需的所有类型：
 * - 数据类型：RawOrderFromAPI, OrderCache, OrderStatistics, FilteringState
 * - 服务接口：OrderStorage, OrderFilteringEngine, OrderAPIManager
 * - 依赖类型：各服务的依赖注入类型
 */

import type { OrderSide, OrderStatus, OrderType, TradeContext } from 'longport';
import type { DecimalLikeValue, PendingOrder, OrderRecord, FetchOrdersResult, Quote, RateLimiter } from '../../types/index.js';

/**
 * API 返回的原始订单类型
 * 用于从 LongPort API 接收订单数据时的类型安全转换
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
 * 存储某个标的的已处理订单和原始订单数据
 */
export type OrderCache = {
  readonly buyOrders: ReadonlyArray<OrderRecord>;
  readonly sellOrders: ReadonlyArray<OrderRecord>;
  readonly allOrders: ReadonlyArray<RawOrderFromAPI> | null;
  readonly fetchTime: number;
};

/**
 * 订单统计信息类型
 * 用于调试输出订单的汇总统计
 */
export type OrderStatistics = {
  readonly totalQuantity: number;
  readonly totalValue: number;
  readonly averagePrice: number;
};

/**
 * 过滤算法的中间状态类型
 * - m0Orders: 最新卖出后的买入订单（无条件保留）
 * - candidateOrders: 需要过滤的候选订单
 */
export type FilteringState = {
  readonly m0Orders: ReadonlyArray<OrderRecord>;
  readonly candidateOrders: ReadonlyArray<OrderRecord>;
};

// ==================== 服务接口定义 ====================

/**
 * 订单存储接口
 * 提供订单的本地存储管理功能
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
 * 实现智能清仓决策的订单过滤算法
 */
export interface OrderFilteringEngine {
  applyFilteringAlgorithm(allBuyOrders: OrderRecord[], filledSellOrders: OrderRecord[]): OrderRecord[];
}

/**
 * 订单API管理器接口
 * 负责从 LongPort API 获取订单并管理缓存
 */
export interface OrderAPIManager {
  fetchOrdersFromAPI(symbol: string): Promise<FetchOrdersResult>;
  hasCacheForSymbols(symbols: string[]): boolean;
  getPendingOrdersFromCache(symbols: string[]): PendingOrder[];
}

// ==================== 依赖类型定义 ====================

/** 订单存储依赖类型（无依赖） */
export type OrderStorageDeps = Record<string, never>;

/** 订单过滤引擎依赖类型（无依赖，纯函数式设计） */
export type OrderFilteringEngineDeps = Record<string, never>;

/**
 * 订单API管理器依赖类型
 * @property ctxPromise - LongPort 交易上下文
 * @property rateLimiter - API 限流器
 */
export type OrderAPIManagerDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

/**
 * 订单记录器依赖类型
 * @property ctxPromise - LongPort 交易上下文
 * @property rateLimiter - API 限流器（控制 Trade API 调用频率）
 */
export type OrderRecorderDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

