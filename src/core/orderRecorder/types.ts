import type { TradeContext } from 'longport';
import type { Quote } from '../../types/quote.js';
import type { OrderRecord, RateLimiter, RawOrderFromAPI } from '../../types/services.js';

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
 * 盈利订单查询结果
 */
export type ProfitableOrderResult = {
  /** 可卖出的订单记录列表 */
  readonly orders: ReadonlyArray<OrderRecord>;
  /** 这些订单的总数量 */
  readonly totalQuantity: number;
};

/**
 * 订单过滤算法的中间状态类型
 * - m0Orders: 最新卖出时间之后成交的买入订单（无条件保留）
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

  // 待成交卖出订单追踪

  /** 添加待成交卖出订单（提交时调用） */
  addPendingSell(info: Omit<PendingSellInfo, 'filledQuantity' | 'status'>): void;

  /** 标记卖出订单完全成交 */
  markSellFilled(orderId: string): PendingSellInfo | null;

  /** 标记卖出订单部分成交 */
  markSellPartialFilled(orderId: string, filledQuantity: number): PendingSellInfo | null;

  /** 标记卖出订单取消 */
  markSellCancelled(orderId: string): PendingSellInfo | null;

  /**
   * 恢复期：为待恢复的卖单分配关联买单 ID
   * 从当前买单记录中按价格从低到高分配，排除已被 pendingSells 占用的订单
   */
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
  ): ProfitableOrderResult;

  /** 清空买卖记录与 pendingSells */
  clearAll(): void;
}

/**
 * 订单过滤引擎接口
 * 实现智能清仓决策的订单过滤算法
 */
export interface OrderFilteringEngine {
  applyFilteringAlgorithm(allBuyOrders: ReadonlyArray<OrderRecord>, filledSellOrders: ReadonlyArray<OrderRecord>): ReadonlyArray<OrderRecord>;
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
  /** 清空 symbol cache 与 allOrdersCache */
  clearCache(): void;
}

// ==================== 依赖类型定义 ====================

/** 订单存储依赖类型（无依赖） */
export type OrderStorageDeps = {
  readonly [key: string]: never;
};

/** 订单过滤引擎依赖类型（无依赖，纯函数式设计） */
export type OrderFilteringEngineDeps = {
  readonly [key: string]: never;
};

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
