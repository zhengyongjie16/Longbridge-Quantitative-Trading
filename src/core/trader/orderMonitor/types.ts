import type { Decimal, PushOrderChanged, TradeContext } from 'longport';
import type { MonitorConfig, MultiMonitorTradingConfig } from '../../../types/config.js';
import type { SymbolRegistry } from '../../../types/seat.js';
import type {
  OrderRecorder,
  PendingRefreshSymbol,
  RateLimiter,
  RawOrderFromAPI,
} from '../../../types/services.js';
import type { Quote } from '../../../types/quote.js';
import type { DailyLossTracker } from '../../riskController/types.js';
import type { LiquidationCooldownTracker } from '../../../services/liquidationCooldown/types.js';
import type { RefreshGate } from '../../../utils/types.js';
import type {
  CancelOrderOutcome,
  OrderClosedReason,
  OrderCacheManager,
  OrderMonitorConfig,
  OrderHoldRegistry,
  OrderMonitorRuntimeState,
  PendingSellOrderSnapshot,
  TrackOrderParams,
  TrackedOrder,
} from '../types.js';

/**
 * 订单监控运行态容器。
 * 类型用途：集中存放 orderMonitor 在运行期维护的可变状态。
 * 数据来源：createOrderMonitor 初始化，后续由事件处理与恢复流程更新。
 * 使用范围：orderMonitor 目录内部各子模块共享。
 */
export type OrderMonitorRuntimeStore = {
  readonly trackedOrders: Map<string, TrackedOrder>;
  readonly trackedOrderLifecycles: Map<string, TrackedOrderLifecycleState>;
  readonly pendingRefreshSymbols: PendingRefreshSymbol[];
  readonly bootstrappingOrderEvents: Map<string, PushOrderChanged>;
  readonly closeSyncQueue: Map<string, CloseSyncTask>;
  readonly closedOrderIds: Set<string>;
  runtimeState: OrderMonitorRuntimeState;
};

/**
 * 恢复流程依赖。
 * 类型用途：为 recoveryFlow 提供恢复所需的状态、服务与回调。
 * 数据来源：由 createOrderMonitor 组装注入。
 * 使用范围：仅 orderMonitor/recoveryFlow.ts 使用。
 */
export type RecoveryFlowDeps = {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly orderHoldRegistry: OrderHoldRegistry;
  readonly orderRecorder: OrderRecorder;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly trackOrder: (params: TrackOrderParams) => void;
  readonly cancelOrder: (orderId: string) => Promise<CancelOrderOutcome>;
  readonly enqueueCloseSync: (
    orderId: string,
    reason: CloseSyncTriggerReason,
    expectedReason?: OrderClosedReason | null,
  ) => void;
  readonly handleOrderChangedWhenActive: (event: PushOrderChanged) => void;
};

/**
 * 恢复流程接口。
 * 类型用途：暴露 BOOTSTRAPPING 事件缓存、重置、回放与快照恢复能力。
 * 数据来源：createRecoveryFlow 工厂返回。
 * 使用范围：orderMonitor/index.ts 调用。
 */
export interface RecoveryFlow {
  cacheBootstrappingEvent: (event: PushOrderChanged) => void;
  clearBootstrappingEventBuffer: () => void;
  resetRecoveryTrackingState: () => void;
  replayBootstrappingEvents: () => ReadonlySet<string>;
  recoverOrderTrackingFromSnapshot: (allOrders: ReadonlyArray<RawOrderFromAPI>) => Promise<void>;
}

/**
 * 事件流依赖。
 * 类型用途：为 eventFlow 提供推送事件处理所需依赖与缓存回调。
 * 数据来源：由 createOrderMonitor 装配注入。
 * 使用范围：仅 orderMonitor/eventFlow.ts 使用。
 */
export type EventFlowDeps = {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly orderRecorder: OrderRecorder;
  readonly finalizeOrderClose: (params: FinalizeOrderCloseParams) => FinalizeOrderCloseResult;
  readonly enqueueCloseSync: (
    orderId: string,
    reason: CloseSyncTriggerReason,
    expectedReason?: OrderClosedReason | null,
  ) => void;
  readonly cacheBootstrappingEvent: (event: PushOrderChanged) => void;
};

/**
 * 事件流接口。
 * 类型用途：封装 ACTIVE 事件处理与 BOOTSTRAPPING/ACTIVE 分发入口。
 * 数据来源：createEventFlow 工厂返回。
 * 使用范围：orderMonitor/index.ts 调用。
 */
export interface EventFlow {
  handleOrderChangedWhenActive: (event: PushOrderChanged) => void;
  handleOrderChanged: (event: PushOrderChanged) => void;
}

/**
 * 订单操作流依赖。
 * 类型用途：为 orderOps 提供 track/cancel/replace 所需依赖。
 * 数据来源：由 createOrderMonitor 装配注入。
 * 使用范围：仅 orderMonitor/orderOps.ts 使用。
 */
export type OrderOpsDeps = {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  readonly orderHoldRegistry: OrderHoldRegistry;
  readonly finalizeOrderClose: (params: FinalizeOrderCloseParams) => FinalizeOrderCloseResult;
  readonly enqueueCloseSync: (
    orderId: string,
    reason: CloseSyncTriggerReason,
    expectedReason?: OrderClosedReason | null,
  ) => void;
};

/**
 * 订单操作流接口。
 * 类型用途：封装订单追踪、撤单、改单的运行态修改行为。
 * 数据来源：createOrderOps 工厂返回。
 * 使用范围：orderMonitor/index.ts 与 quoteFlow.ts 调用。
 */
export interface OrderOps {
  trackOrder: (params: TrackOrderParams) => void;
  cancelOrderWithOutcome: (orderId: string) => Promise<CancelOrderOutcome>;
  cancelOrder: (orderId: string) => Promise<CancelOrderOutcome>;
  replaceOrderPrice: (orderId: string, newPrice: number, quantity?: number | null) => Promise<void>;
}

/**
 * 行情驱动流依赖。
 * 类型用途：为 quoteFlow 提供超时处理与改单循环所需依赖。
 * 数据来源：由 createOrderMonitor 装配注入。
 * 使用范围：仅 orderMonitor/quoteFlow.ts 使用。
 */
export type QuoteFlowDeps = {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly config: OrderMonitorConfig;
  readonly thresholdDecimal: Decimal;
  readonly orderRecorder: OrderRecorder;
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
  readonly isExecutionAllowed: () => boolean;
  readonly trackOrder: (params: TrackOrderParams) => void;
  readonly cancelOrder: (orderId: string) => Promise<CancelOrderOutcome>;
  readonly cancelOrderWithOutcome: (orderId: string) => Promise<CancelOrderOutcome>;
  readonly processCloseSyncQueue: () => Promise<void>;
  readonly replaceOrderPrice: (
    orderId: string,
    newPrice: number,
    quantity?: number | null,
  ) => Promise<void>;
};

/**
 * 行情驱动流接口。
 * 类型用途：封装超时处理、行情驱动改单与 pendingSell 快照读取。
 * 数据来源：createQuoteFlow 工厂返回。
 * 使用范围：orderMonitor/index.ts 调用。
 */
export interface QuoteFlow {
  processWithLatestQuotes: (quotesMap: ReadonlyMap<string, Quote | null>) => Promise<void>;
  getPendingSellOrders: (symbol: string) => ReadonlyArray<PendingSellOrderSnapshot>;
}

/**
 * 关闭收口入参。
 * 类型用途：统一描述订单关闭时副作用计算所需上下文。
 * 数据来源：撤单 outcome、WebSocket 事件、定向对账快照。
 * 使用范围：orderMonitor/closeFlow.ts。
 */
export type FinalizeOrderCloseParams = {
  readonly orderId: string;
  readonly closedReason: OrderClosedReason;
  readonly source: 'API' | 'WS' | 'SYNC' | 'RECOVERY';
  readonly executedPrice?: number | null;
  readonly executedQuantity?: number | null;
  readonly executedTimeMs?: number | null;
  readonly symbol?: string;
  readonly side?: 'BUY' | 'SELL';
  readonly monitorSymbol?: string | null;
  readonly isLongSymbol?: boolean;
  readonly isProtectiveLiquidation?: boolean;
  readonly liquidationTriggerLimit?: number;
  readonly liquidationCooldownConfig?: MonitorConfig['liquidationCooldown'];
};

/**
 * 关闭收口结果。
 * 类型用途：向调用方返回幂等处理结果与卖单关联买单占用信息。
 * 数据来源：closeFlow.finalizeOrderClose 计算结果。
 * 使用范围：orderMonitor 各流程共享。
 */
export type FinalizeOrderCloseResult = {
  readonly handled: boolean;
  readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
};

/**
 * 关闭收口流程依赖。
 * 类型用途：为 closeFlow 提供统一关闭语义处理所需依赖。
 * 数据来源：createOrderMonitor 组装注入。
 * 使用范围：orderMonitor/closeFlow.ts。
 */
export type CloseFlowDeps = {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly orderHoldRegistry: OrderHoldRegistry;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly refreshGate?: RefreshGate;
};

/**
 * 关闭收口流程接口。
 * 类型用途：统一提供关闭收口、定向对账入队和调度能力。
 * 数据来源：createCloseFlow 工厂返回。
 * 使用范围：orderMonitor/index.ts 及子流程调用。
 */
export interface CloseFlow {
  finalizeOrderClose: (params: FinalizeOrderCloseParams) => FinalizeOrderCloseResult;
  enqueueCloseSync: (
    orderId: string,
    reason: CloseSyncTriggerReason,
    expectedReason?: OrderClosedReason | null,
  ) => void;
  processCloseSyncQueue: () => Promise<void>;
  clearCloseSyncQueue: () => void;
}

/**
 * LongPort API 错误码类型定义
 */

/**
 * 追踪订单生命周期状态。
 * 类型用途：用于统一关闭收口与定向对账状态流转控制。
 * 数据来源：orderMonitor 运行态维护。
 * 使用范围：orderMonitor 目录内部。
 */
export type TrackedOrderLifecycleState = 'OPEN' | 'CLOSE_SYNC_PENDING' | 'CLOSED';

/**
 * 定向对账触发原因。
 * 类型用途：用于 closeSyncQueue 的可观测性与重试策略区分。
 * 数据来源：撤单 outcome、WS 终态缺失、异常路径。
 * 使用范围：orderMonitor 目录内部。
 */
export type CloseSyncTriggerReason =
  | 'ALREADY_CLOSED_FILLED'
  | 'ALREADY_CLOSED_NOT_FOUND'
  | 'UNKNOWN_FAILURE'
  | 'LATE_CLOSED_EVENT';

/**
 * 定向对账任务。
 * 类型用途：维护按 orderId 去重的有限重试队列项。
 * 数据来源：orderMonitor 运行态任务入队。
 * 使用范围：orderMonitor 目录内部。
 */
export type CloseSyncTask = {
  readonly orderId: string;
  readonly triggerReason: CloseSyncTriggerReason;
  readonly expectedReason: OrderClosedReason | null;
  attempts: number;
  nextAttemptAtMs: number;
  lastError: string | null;
};

/** 可识别的订单关闭错误码类型 */
export type OrderClosedErrorCode = '601011' | '601012' | '601013' | '603001';

/** 不支持改单（类型不支持）错误码类型 */
export type ReplaceUnsupportedByTypeErrorCode = '602012';

/** 不支持改单（状态暂不允许）错误码类型 */
export type ReplaceTempBlockedErrorCode = '602013';
