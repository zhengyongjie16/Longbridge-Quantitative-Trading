import type { Decimal, PushOrderChanged, TradeContext } from 'longport';
import type { MonitorConfig, MultiMonitorTradingConfig } from '../../../types/config.js';
import type { DailyLossTracker } from '../../../types/risk.js';
import type { SymbolRegistry } from '../../../types/seat.js';
import type {
  CancelOrderOutcome,
  OrderClosedReason,
  OrderStateCheckResult,
} from '../../../types/trader.js';
import type {
  OrderRecorder,
  PendingRefreshSymbol,
  RateLimiter,
  RawOrderFromAPI,
} from '../../../types/services.js';
import type { Quote } from '../../../types/quote.js';
import type { LiquidationCooldownTracker } from '../../../services/liquidationCooldown/types.js';
import type { RefreshGate } from '../../../utils/types.js';
import type {
  OrderCacheManager,
  OrderMonitorConfig,
  OrderHoldRegistry,
  OrderMonitorRuntimeState,
  PendingSellOrderSnapshot,
  TrackOrderParams,
  TrackedOrder,
} from '../types.js';

/**
 * 改单恢复模式。
 * 类型用途：约束 602013 临时阻塞后的恢复策略。
 * 数据来源：orderOps/quoteFlow 运行态更新。
 * 使用范围：orderMonitor 目录内部。
 */
type ReplaceResumeMode = 'TIME_BACKOFF' | 'WAIT_WS_ONLY';

export type TerminalClosedReason = 'FILLED' | 'CANCELED' | 'REJECTED';

export type TerminalSettlementInput = {
  readonly params: {
    readonly orderId: string;
    readonly closedReason: TerminalClosedReason;
    readonly source: 'API' | 'WS';
    readonly executedPrice: number | null;
    readonly executedQuantity: number | null;
    readonly executedTimeMs: number | null;
  };
  readonly queriedExecutedQuantity: number | null;
};

/**
 * 单订单权威终态快照。
 * 类型用途：缓存撤单/改单业务失败后的权威终态查询结果。
 * 数据来源：orderStatusQuery.checkOrderState 返回的 TERMINAL 分支。
 * 使用范围：orderMonitor 目录内部。
 */
export type TerminalStateSnapshot = Extract<OrderStateCheckResult, { kind: 'TERMINAL' }>;

/**
 * 改单结果语义。
 * 类型用途：描述改单执行后的标准化结果，供 quoteFlow 消费。
 * 数据来源：orderOps.replaceOrderPrice 写入运行态后由 quoteFlow 消费。
 * 使用范围：orderMonitor 目录内部。
 */
export type ReplaceOrderOutcome =
  | {
      readonly kind: 'SKIPPED';
      readonly reason:
        | 'ORDER_NOT_TRACKED'
        | 'UNSUPPORTED_BY_TYPE'
        | 'WAIT_WS_ONLY'
        | 'BACKOFF_IN_PROGRESS'
        | 'INVALID_REMAINING_QUANTITY';
    }
  | {
      readonly kind: 'REPLACED';
    }
  | {
      readonly kind: 'TEMP_BLOCKED';
      readonly retryCount: number;
      readonly nextRetryAtMs: number;
      readonly resumeMode: ReplaceResumeMode;
    }
  | {
      readonly kind: 'WAIT_WS_ONLY';
      readonly reason: 'OPEN' | 'QUERY_FAILED';
    }
  | {
      readonly kind: 'TERMINAL_CONFIRMED';
      readonly terminalState: TerminalStateSnapshot;
    }
  | {
      readonly kind: 'FAILED';
      readonly reason: 'RETRYABLE' | 'QUERY_OPEN' | 'QUERY_FAILED' | 'UNKNOWN';
      readonly errorCode: string | null;
      readonly message: string;
    };

/**
 * orderMonitor 内部追踪订单模型。
 * 类型用途：在基础 TrackedOrder 上补充状态确认与改单恢复的窄状态字段。
 * 数据来源：trackOrder 初始化，后续由 orderOps/quoteFlow 更新。
 * 使用范围：orderMonitor 目录内部。
 */
export type OrderMonitorTrackedOrder = TrackedOrder & {
  /** 下一次允许触发单订单状态确认的时间戳（毫秒） */
  nextStateCheckAt: number | null;

  /** 单订单状态确认重试计数 */
  stateCheckRetryCount: number;

  /** 单订单状态确认阻塞截止时间戳（毫秒） */
  stateCheckBlockedUntilAt: number | null;

  /** 连续命中 602013 的计数 */
  replaceTempBlockedCount: number;

  /** 改单恢复模式 */
  replaceResumeMode: ReplaceResumeMode;

  /** 卖单超时后是否已进入“等待终态确认后转市价”阶段 */
  timeoutMarketConversionPending: boolean;

  /** 卖单超时等待阶段已收到的终态快照 */
  timeoutMarketConversionTerminalState: {
    readonly closedReason: OrderClosedReason;
    readonly source: 'WS';
    readonly executedPrice: number | null;
    readonly executedQuantity: number | null;
    readonly executedTimeMs: number | null;
  } | null;
};

/**
 * 订单监控运行态容器。
 * 类型用途：集中存放 orderMonitor 在运行期维护的可变状态。
 * 数据来源：createOrderMonitor 初始化，后续由事件处理与恢复流程更新。
 * 使用范围：orderMonitor 目录内部各子模块共享。
 */
export type OrderMonitorRuntimeStore = {
  readonly trackedOrders: Map<string, OrderMonitorTrackedOrder>;
  readonly trackedOrderLifecycles: Map<string, TrackedOrderLifecycleState>;
  readonly pendingRefreshSymbols: PendingRefreshSymbol[];
  readonly bootstrappingOrderEvents: Map<string, PushOrderChanged>;
  readonly closedOrderIds: Set<string>;
  readonly queriedTerminalStateByOrderId: Map<string, TerminalStateSnapshot>;
  readonly latestReplaceOutcomeByOrderId: Map<string, ReplaceOrderOutcome>;
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
  readonly settleOrder: (params: FinalizeOrderSettlementParams) => FinalizeOrderSettlementResult;
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
  readonly settleOrder: (params: FinalizeOrderSettlementParams) => FinalizeOrderSettlementResult;
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
 * 单订单状态查询依赖。
 * 类型用途：为 orderStatusQuery 提供单订单权威状态查询所需依赖。
 * 数据来源：由 createOrderMonitor 装配注入。
 * 使用范围：仅 orderMonitor/orderStatusQuery.ts 使用。
 */
export type OrderStatusQueryDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

/**
 * 单订单状态查询接口。
 * 类型用途：统一封装撤单/改单业务失败后的权威状态确认。
 * 数据来源：createOrderStatusQuery 工厂返回。
 * 使用范围：orderMonitor/orderOps.ts 调用。
 */
export interface OrderStatusQuery {
  checkOrderState: (orderId: string) => Promise<OrderStateCheckResult>;
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
  readonly orderStatusQuery: OrderStatusQuery;
};

/**
 * 订单操作流接口。
 * 类型用途：封装订单追踪、撤单、改单的运行态修改行为。
 * 数据来源：createOrderOps 工厂返回。
 * 使用范围：orderMonitor/index.ts 与 quoteFlow.ts 调用。
 */
export interface OrderOps {
  trackOrder: (params: TrackOrderParams) => void;
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
  readonly settleOrder: (params: FinalizeOrderSettlementParams) => FinalizeOrderSettlementResult;
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
 * 终态结算入参。
 * 类型用途：统一描述订单终态结算副作用所需上下文。
 * 数据来源：撤单 outcome 归一结果、WebSocket 终态事件、恢复链路终态确认结果。
 * 使用范围：orderMonitor/settlementFlow.ts。
 */
export type FinalizeOrderSettlementParams = {
  readonly orderId: string;
  readonly closedReason: OrderClosedReason;
  readonly source: 'API' | 'WS' | 'STATE_CHECK' | 'RECOVERY';
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
 * 终态结算结果。
 * 类型用途：向调用方返回幂等处理结果与卖单关联买单占用信息。
 * 数据来源：settlementFlow.settleOrder 计算结果。
 * 使用范围：orderMonitor 各流程共享。
 */
export type FinalizeOrderSettlementResult = {
  readonly handled: boolean;
  readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
};

/**
 * 终态结算流程依赖。
 * 类型用途：为 settlementFlow 提供终态结算副作用依赖。
 * 数据来源：createOrderMonitor 组装注入。
 * 使用范围：orderMonitor/settlementFlow.ts。
 */
export type SettlementFlowDeps = {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly orderHoldRegistry: OrderHoldRegistry;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly refreshGate?: RefreshGate;
};

/**
 * 终态结算流程接口。
 * 类型用途：统一提供订单终态副作用结算能力。
 * 数据来源：createSettlementFlow 工厂返回。
 * 使用范围：orderMonitor/index.ts 及子流程调用。
 */
export interface SettlementFlow {
  settleOrder: (params: FinalizeOrderSettlementParams) => FinalizeOrderSettlementResult;
}

/**
 * 追踪订单生命周期状态。
 * 类型用途：用于统一 OPEN/CLOSED 生命周期流转控制。
 * 数据来源：orderMonitor 运行态维护。
 * 使用范围：orderMonitor 目录内部。
 */
type TrackedOrderLifecycleState = 'OPEN' | 'CLOSED';

/**
 * 可识别的订单关闭错误码类型。
 * 类型用途：约束可映射为订单已关闭语义的错误码集合。
 * 数据来源：来源于 LongPort 交易接口返回的错误码约定。
 * 使用范围：仅在 orderMonitor 模块的错误分类流程使用。
 */
export type OrderClosedErrorCode = '601011' | '601012' | '601013' | '603001';

/**
 * 不支持改单（类型不支持）错误码类型。
 * 类型用途：标识因订单类型限制导致的改单拒绝错误。
 * 数据来源：来源于 LongPort 交易接口返回的错误码约定。
 * 使用范围：仅在 orderMonitor 模块的改单错误分类流程使用。
 */
export type ReplaceUnsupportedByTypeErrorCode = '602012';

/**
 * 不支持改单（状态暂不允许）错误码类型。
 * 类型用途：标识因订单状态限制导致的临时改单拒绝错误。
 * 数据来源：来源于 LongPort 交易接口返回的错误码约定。
 * 使用范围：仅在 orderMonitor 模块的改单错误分类流程使用。
 */
export type ReplaceTempBlockedErrorCode = '602013';
