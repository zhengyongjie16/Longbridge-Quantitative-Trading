import type { TradeContext } from 'longbridge';
import type { Quote } from '../../types/quote.js';
import type { MonitorConfig } from '../../types/config.js';
import type { OrderFilteringEngine, OrderOwnership } from '../../types/orderRecorder.js';
import type {
  OrderRecord,
  PendingSellInfo,
  RateLimiter,
  RawOrderFromAPI,
  SellableOrderResult,
  SellableOrderSelectParams,
} from '../../types/services.js';

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
    relatedBuyOrderIds?: ReadonlyArray<string> | null,
  ) => void;
  clearBuyOrders: (symbol: string, isLongSymbol: boolean, quote?: Quote | null) => void;
  getLatestBuyOrderPrice: (symbol: string, isLongSymbol: boolean) => number | null;
  getLatestSellRecord: (symbol: string, isLongSymbol: boolean) => OrderRecord | null;
  getSellRecordByOrderId: (orderId: string) => OrderRecord | null;

  /** 添加待成交卖出订单（提交时调用） */
  addPendingSell: (info: Omit<PendingSellInfo, 'filledQuantity' | 'status'>) => void;

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

  /** 清空买卖记录与 pendingSells */
  clearAll: () => void;
}

/**
 * 订单 API 管理器接口。
 * 类型用途：依赖注入，负责从 Longbridge API 获取订单并管理缓存。
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
 * 订单 API 管理器依赖。
 * 类型用途：用于创建 OrderAPIManager 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅 orderRecorder 模块内部使用。
 */
export type OrderAPIManagerDeps = {
  readonly ctx: TradeContext;
  readonly rateLimiter: RateLimiter;
};

/**
 * 订单记录器正式工厂依赖。
 * 类型用途：创建 OrderRecorder 时注入外部交易上下文与 API 限流器。
 * 数据来源：由 Trader 装配层创建后传入。
 * 使用范围：仅 orderRecorder 对外工厂使用。
 */
export type OrderRecorderFactoryDeps = {
  readonly ctx: TradeContext;
  readonly rateLimiter: RateLimiter;
};

/**
 * 日内亏损回算所需的订单分析依赖。
 * 类型用途：作为 orderRecorder 对外暴露的最小分析能力集合，供装配层注入 dailyLossTracker。
 * 数据来源：由 orderRecorder 公共边界内组装后返回。
 * 使用范围：仅 orderRecorder 的对外分析导出使用。
 */
export type OrderDailyLossAnalysisDeps = {
  readonly filteringEngine: OrderFilteringEngine;
  readonly resolveOrderOwnership: (
    order: RawOrderFromAPI,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
  ) => OrderOwnership | null;
  readonly classifyAndConvertOrders: (orders: ReadonlyArray<RawOrderFromAPI>) => {
    readonly buyOrders: ReadonlyArray<OrderRecord>;
    readonly sellOrders: ReadonlyArray<OrderRecord>;
  };
};

/**
 * 订单记录器依赖。
 * 类型用途：用于创建 OrderRecorder 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅 orderRecorder 模块内部组装使用。
 */
export type OrderRecorderDeps = {
  readonly storage: OrderStorage;
  readonly apiManager: OrderAPIManager;
  readonly filteringEngine: OrderFilteringEngine;
};
