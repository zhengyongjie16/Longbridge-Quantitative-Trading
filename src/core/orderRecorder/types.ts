import type { TradeContext } from 'longport';
import type { Quote } from '../../types/quote.js';
import type { OrderRecord, RateLimiter, RawOrderFromAPI } from '../../types/services.js';
import type { TradingCalendarSnapshot } from '../../types/tradingCalendar.js';

/**
 * 订单缓存类型。
 * 类型用途：OrderAPIManager 内部缓存结构，按标的存储买卖单与原始 API 订单。
 * 数据来源：由 OrderAPIManager 从 API 拉取并分类后填充。
 * 使用范围：仅 orderRecorder 模块内部使用。
 */
export type OrderCache = {
  readonly buyOrders: ReadonlyArray<OrderRecord>;
  readonly sellOrders: ReadonlyArray<OrderRecord>;
  readonly allOrders: ReadonlyArray<RawOrderFromAPI> | null;
  readonly fetchTime: number;
};

/**
 * 订单归属解析结果。
 * 类型用途：表示单笔 API 订单归属的监控标的与方向，供 DailyLossTracker 等使用。
 * 数据来源：订单归属逻辑解析 RawOrderFromAPI 得到。
 * 使用范围：orderRecorder 与 riskController 等模块使用。
 */
export type OrderOwnership = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
};

/**
 * 订单统计信息类型。
 * 类型用途：用于调试输出或内部汇总（数量、金额、均价）。
 * 数据来源：如适用（由模块内部根据订单列表计算）。
 * 使用范围：仅 orderRecorder 模块使用。
 */
export type OrderStatistics = {
  readonly totalQuantity: number;
  readonly totalValue: number;
  readonly averagePrice: number;
};

/**
 * 订单重建分类结果。
 * 类型用途：启动/开盘重建阶段在单标的维度将全量订单按成交状态与买卖方向分流。
 * 数据来源：由 classifyOrdersForRebuild 从 RawOrderFromAPI 转换得到。
 * 使用范围：orderRecorder 重建链路内部使用。
 */
export type OrderRebuildClassification = {
  readonly filledBuyOrders: ReadonlyArray<OrderRecord>;
  readonly filledSellOrders: ReadonlyArray<OrderRecord>;
  readonly pendingBuyOrders: ReadonlyArray<RawOrderFromAPI>;
  readonly pendingSellOrders: ReadonlyArray<RawOrderFromAPI>;
};

/**
 * 订单重建中的待成交分类（仅买/卖两类）。
 * 类型用途：在刷新日志与重建流程中传递待成交买卖订单集合。
 * 数据来源：由 classifyOrdersForRebuild 结果派生。
 * 使用范围：orderRecorder 重建链路内部使用。
 */
export type PendingOrderClassificationForRebuild = {
  readonly pendingBuyOrders: ReadonlyArray<RawOrderFromAPI>;
  readonly pendingSellOrders: ReadonlyArray<RawOrderFromAPI>;
};

/**
 * 订单刷新结果日志参数。
 * 类型用途：统一记录刷新前后数量与待成交分类信息，避免实现文件内联类型膨胀。
 * 数据来源：由 orderRecorder 刷新流程构造。
 * 使用范围：orderRecorder 模块内部使用。
 */
export type OrderRefreshResultLogParams = {
  readonly symbol: string;
  readonly isLongSymbol: boolean;
  readonly originalBuyCount: number;
  readonly sellCount: number;
  readonly recordedCount: number;
  readonly pendingClassification?: PendingOrderClassificationForRebuild;
  readonly extraInfo?: string;
  readonly quote?: Quote | null | undefined;
};

/**
 * 订单快照来源标识。
 * 类型用途：标记同一 orderId 的来源（history/today），用于去重覆盖决策。
 * 数据来源：OrderAPIManager 拉取 history/today 订单时生成。
 * 使用范围：orderRecorder/orderApiManager 内部使用。
 */
export type OrderSnapshotSource = 'history' | 'today';

/**
 * 合并去重后的订单条目。
 * 类型用途：在按 orderId 合并时同时保留来源与订单内容，供覆盖策略判断。
 * 数据来源：mergeAndDeduplicateOrders 构建。
 * 使用范围：orderRecorder/orderApiManager 内部使用。
 */
export type MergedOrderEntry = {
  readonly source: OrderSnapshotSource;
  readonly order: RawOrderFromAPI;
};

/**
 * 待成交卖出订单信息。
 * 类型用途：智能平仓防重追踪，记录已提交但未成交的卖出订单及关联买单。
 * 数据来源：提交卖单时添加，成交/撤单时更新状态。
 * 使用范围：仅 orderRecorder 模块内部使用。
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
 * 可卖订单筛选策略。
 * 类型用途：统一描述卖出订单筛选行为（全量/仅盈利/仅超时）。
 * 数据来源：由卖出决策层传入。
 * 使用范围：orderRecorder 与 signalProcessor 模块。
 */
export type SellableOrderStrategy = 'ALL' | 'PROFIT_ONLY' | 'TIMEOUT_ONLY';

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
 * 订单过滤算法的中间状态类型。
 * 类型用途：OrderFilteringEngine 过滤算法中的中间结构（m0Orders 保留，candidateOrders 待过滤）。
 * 数据来源：模块内部在 applyFilteringAlgorithm 中构造。
 * 使用范围：仅 orderRecorder 模块内部使用。
 */
export type FilteringState = {
  readonly m0Orders: ReadonlyArray<OrderRecord>;
  readonly candidateOrders: ReadonlyArray<OrderRecord>;
};

// ==================== 服务接口定义 ====================

/**
 * 订单存储接口。
 * 类型用途：依赖注入，提供订单的本地存储管理（买卖记录、待成交卖单、可卖订单查询等）。
 * 数据来源：如适用。
 * 使用范围：由 OrderRecorder 依赖注入；仅 orderRecorder 模块实现与使用。
 */
export interface OrderStorage {
  getBuyOrdersList: (symbol: string, isLongSymbol: boolean) => ReadonlyArray<OrderRecord>;
  setBuyOrdersListForLong: (symbol: string, newList: ReadonlyArray<OrderRecord>) => void;
  setBuyOrdersListForShort: (symbol: string, newList: ReadonlyArray<OrderRecord>) => void;
  addBuyOrder: (
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
  ) => void;
  updateAfterSell: (
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
    orderId?: string | null,
  ) => void;
  clearBuyOrders: (symbol: string, isLongSymbol: boolean, quote?: Quote | null) => void;
  getLatestBuyOrderPrice: (symbol: string, isLongSymbol: boolean) => number | null;
  getLatestSellRecord: (symbol: string, isLongSymbol: boolean) => OrderRecord | null;
  getSellRecordByOrderId: (orderId: string) => OrderRecord | null;

  // 待成交卖出订单追踪

  /** 添加待成交卖出订单（提交时调用） */
  addPendingSell: (info: Omit<PendingSellInfo, 'filledQuantity' | 'status'>) => void;

  /** 标记卖出订单完全成交 */
  markSellFilled: (orderId: string) => PendingSellInfo | null;

  /** 标记卖出订单部分成交 */
  markSellPartialFilled: (orderId: string, filledQuantity: number) => PendingSellInfo | null;

  /** 标记卖出订单取消 */
  markSellCancelled: (orderId: string) => PendingSellInfo | null;

  /** 获取待成交卖单快照（用于恢复一致性校验） */
  getPendingSellSnapshot: () => ReadonlyArray<PendingSellInfo>;

  /**
   * 恢复期：为待恢复的卖单分配关联买单 ID
   * 从当前买单记录中按价格从低到高分配，排除已被 pendingSells 占用的订单
   */
  allocateRelatedBuyOrderIdsForRecovery: (
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
  ) => readonly string[];

  /** 获取指定标的的成本均价（实时计算，无缓存） */
  getCostAveragePrice: (symbol: string, isLongSymbol: boolean) => number | null;

  /** 按策略筛选可卖订单（统一处理占用过滤、整笔截断与可选额外排除） */
  selectSellableOrders: (params: SellableOrderSelectParams) => SellableOrderResult;

  /** 清空买卖记录与 pendingSells */
  clearAll: () => void;
}

/**
 * 订单过滤引擎接口。
 * 类型用途：依赖注入，实现智能清仓决策的订单过滤算法。
 * 数据来源：如适用。
 * 使用范围：由 OrderRecorder、DailyLossTracker 等依赖注入；仅 orderRecorder 模块实现。
 */
export interface OrderFilteringEngine {
  applyFilteringAlgorithm: (
    allBuyOrders: ReadonlyArray<OrderRecord>,
    filledSellOrders: ReadonlyArray<OrderRecord>,
  ) => ReadonlyArray<OrderRecord>;
}

/**
 * 订单 API 管理器接口。
 * 类型用途：依赖注入，负责从 LongPort API 获取订单并管理缓存。
 * 数据来源：如适用。
 * 使用范围：由 OrderRecorder 依赖注入；仅 orderRecorder 模块实现与使用。
 */
export interface OrderAPIManager {
  fetchAllOrdersFromAPI: (forceRefresh?: boolean) => Promise<ReadonlyArray<RawOrderFromAPI>>;
  cacheOrdersForSymbol: (
    symbol: string,
    buyOrders: ReadonlyArray<OrderRecord>,
    sellOrders: ReadonlyArray<OrderRecord>,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
  ) => void;
  clearCacheForSymbol: (symbol: string) => void;
  /** 清空 symbol cache 与 allOrdersCache */
  clearCache: () => void;
}

// ==================== 依赖类型定义 ====================

/**
 * 订单存储依赖。
 * 类型用途：创建 OrderStorage 时的依赖注入（当前无外部依赖，空对象）。
 * 数据来源：如适用。
 * 使用范围：仅 orderRecorder 模块内部使用。
 */
export type OrderStorageDeps = {
  readonly [key: string]: never;
};

/**
 * 订单过滤引擎依赖。
 * 类型用途：创建 OrderFilteringEngine 时的依赖注入（当前无外部依赖，空对象）。
 * 数据来源：如适用。
 * 使用范围：仅 orderRecorder 模块内部使用。
 */
export type OrderFilteringEngineDeps = {
  readonly [key: string]: never;
};

/**
 * 订单 API 管理器依赖。
 * 类型用途：用于创建 OrderAPIManager 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅 orderRecorder 模块内部使用。
 */
export type OrderAPIManagerDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

/**
 * 订单记录器依赖。
 * 类型用途：用于创建 OrderRecorder 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：见调用方（如启动层、riskDomain）。
 */
export type OrderRecorderDeps = {
  readonly storage: OrderStorage;
  readonly apiManager: OrderAPIManager;
  readonly filteringEngine: OrderFilteringEngine;
};
