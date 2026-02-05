/**
 * 订单记录模块类型定义
 *
 * 本文件定义了订单记录模块所需的所有类型：
 * - 数据类型：RawOrderFromAPI, OrderCache, OrderStatistics, FilteringState
 * - 服务接口：OrderStorage, OrderFilteringEngine, OrderAPIManager
 * - 依赖类型：各服务的依赖注入类型
 */
import type { TradeContext } from 'longport';
import type {
  PendingOrder,
  OrderRecord,
  Quote,
  RateLimiter,
  RawOrderFromAPI,
} from '../../types/index.js';

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
 * 订单归属解析结果
 * 用于标记订单对应的监控标的与方向
 */
export type OrderOwnership = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
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
 * 待成交卖出订单信息
 * 用于智能平仓防重追踪，记录已提交但未成交的卖出订单
 */
export interface PendingSellInfo {
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
}

/**
 * 盈利订单查询结果
 */
export interface ProfitableOrderResult {
  /** 可卖出的订单记录列表 */
  readonly orders: ReadonlyArray<OrderRecord>;
  /** 这些订单的总数量 */
  readonly totalQuantity: number;
}

/**
 * 订单过滤算法的中间状态类型
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
  getBuyOrdersList(symbol: string, isLongSymbol: boolean): ReadonlyArray<OrderRecord>;
  setBuyOrdersListForLong(symbol: string, newList: ReadonlyArray<OrderRecord>): void;
  setBuyOrdersListForShort(symbol: string, newList: ReadonlyArray<OrderRecord>): void;
  addBuyOrder(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
  ): void;
  updateAfterSell(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
    orderId?: string | null,
  ): void;
  clearBuyOrders(symbol: string, isLongSymbol: boolean, quote?: Quote | null): void;
  getLatestBuyOrderPrice(symbol: string, isLongSymbol: boolean): number | null;
  getLatestSellRecord(symbol: string, isLongSymbol: boolean): OrderRecord | null;
  getBuyOrdersBelowPrice(
    currentPrice: number,
    direction: 'LONG' | 'SHORT',
    symbol: string,
  ): ReadonlyArray<OrderRecord>;
  calculateTotalQuantity(orders: ReadonlyArray<OrderRecord>): number;
  getLongBuyOrders(): ReadonlyArray<OrderRecord>;
  getShortBuyOrders(): ReadonlyArray<OrderRecord>;

  // 待成交卖出订单追踪

  /** 添加待成交卖出订单（提交时调用） */
  addPendingSell(info: Omit<PendingSellInfo, 'filledQuantity' | 'status'>): void;

  /** 标记卖出订单完全成交 */
  markSellFilled(orderId: string): PendingSellInfo | null;

  /** 标记卖出订单部分成交 */
  markSellPartialFilled(orderId: string, filledQuantity: number): PendingSellInfo | null;

  /** 标记卖出订单取消 */
  markSellCancelled(orderId: string): PendingSellInfo | null;

  /** 获取待成交卖出订单列表 */
  getPendingSellOrders(symbol: string, direction: 'LONG' | 'SHORT'): ReadonlyArray<PendingSellInfo>;

  /** 获取可卖出的盈利订单（核心防重逻辑） */
  getProfitableSellOrders(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    currentPrice: number,
    maxSellQuantity?: number,
  ): ProfitableOrderResult;

  /** 获取被指定订单占用的买入订单ID列表 */
  getBuyOrderIdsOccupiedBySell(orderId: string): ReadonlyArray<string> | null;
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
  fetchAllOrdersFromAPI(forceRefresh?: boolean): Promise<ReadonlyArray<RawOrderFromAPI>>;
  cacheOrdersForSymbol(
    symbol: string,
    buyOrders: ReadonlyArray<OrderRecord>,
    sellOrders: ReadonlyArray<OrderRecord>,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
  ): void;
  clearCacheForSymbol(symbol: string): void;
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
 * @property storage - 订单存储器
 * @property apiManager - 订单API管理器
 * @property filteringEngine - 订单过滤引擎
 */
export type OrderRecorderDeps = {
  readonly storage: OrderStorage;
  readonly apiManager: OrderAPIManager;
  readonly filteringEngine: OrderFilteringEngine;
};
