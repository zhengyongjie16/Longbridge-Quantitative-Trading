import type { Decimal, PushOrderChanged, TradeContext } from 'longbridge';
import type { MonitorConfig, MultiMonitorTradingConfig } from '../../../types/config.js';
import type { Quote } from '../../../types/quote.js';
import type { DailyLossTracker } from '../../../types/risk.js';
import type { SymbolRegistry } from '../../../types/seat.js';
import type {
  CancelOrderOutcome,
  OrderClosedReason,
  OrderStateCheckResult,
} from '../../../types/trader.js';
import type {
  OrderRecorder,
  PostTradeConsistencyRuntimePort,
  RateLimiter,
  RawOrderFromAPI,
  MarketDataClient,
  OrderStateChangedEvent,
  Unsubscribe,
} from '../../../types/services.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../protectiveLiquidationEpisodeTracker/types.js';
import type {
  OrderCacheManager,
  OrderMonitorConfig,
  OrderHoldRegistry,
  OrderMonitorRuntimeState,
  TrackOrderParams,
  TrackedOrder,
} from '../types.js';

/**
 * 改单恢复模式。
 * 类型用途：约束 602013 临时阻塞后的恢复策略。
 * 数据来源：orderOps 与 route runtime 相关运行态更新。
 * 使用范围：orderMonitor 目录内部。
 */
type ReplaceResumeMode = 'TIME_BACKOFF' | 'WAIT_WS_ONLY';

/**
 * 已确认终态原因。
 * 类型用途：约束 routeProcessor / settlementFlow 只处理系统认可的终态结论。
 * 数据来源：WS 订单终态、权威状态查询结果与恢复链路。
 * 使用范围：orderMonitor 目录内部。
 */
export type TerminalClosedReason = 'FILLED' | 'CANCELED' | 'REJECTED';

/**
 * 终态结算输入。
 * 类型用途：把已确认终态的最小结算载荷与查询侧剩余数量信息打包传递。
 * 数据来源：routeProcessor 在 timeout / state-check / WS 终态处理中构造。
 * 使用范围：orderMonitor 目录内部。
 */
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
 * 卖单超时处置结果。
 * 类型用途：区分继续等待终态、直接结算或结算后转市价的后续动作。
 * 数据来源：routeProcessor 在收到卖单超时终态后基于剩余数量计算。
 * 使用范围：仅 orderMonitor/routeProcessor.ts 使用。
 */
export type SellTimeoutResolution =
  | {
      readonly kind: 'WAIT_RETRY';
    }
  | {
      readonly kind: 'SETTLE_FILLED';
      readonly settlementInput: TerminalSettlementInput;
    }
  | {
      readonly kind: 'SETTLE_NO_REMAINDER';
      readonly settlementInput: TerminalSettlementInput;
    }
  | {
      readonly kind: 'SETTLE_AND_CONVERT';
      readonly settlementInput: TerminalSettlementInput;
      readonly marketConversionQuantity: number;
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
 * 类型用途：描述改单执行后的标准化结果，供 routeProcessor 等 owner 消费。
 * 数据来源：orderOps.replaceOrderPrice 写入运行态后由 route owner 消费。
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
 * 订单监控唤醒类型。
 * 类型用途：标识 route runtime 本轮执行由哪类事件触发。
 * 数据来源：quote push、order WS、timer、track 与 runtime bootstrap 流程。
 * 使用范围：orderMonitor route runtime 目录内部。
 */
export type OrderMonitorWakeupKind = 'QUOTE' | 'ORDER_EVENT' | 'TIMER' | 'TRACKED' | 'RECOVERED';

/**
 * 订单监控 timer 类型。
 * 类型用途：为 route timer 建立稳定的业务类型边界，供后续按订单状态投影扩展。
 * 数据来源：orderMonitor route runtime 基于 tracked order 当前状态推导。
 * 使用范围：orderMonitor route runtime 目录内部。
 */
export type OrderMonitorTimerKind =
  | 'BUY_TIMEOUT'
  | 'SELL_TIMEOUT'
  | 'CANCEL_RETRY'
  | 'REPLACE_RETRY'
  | 'QUOTE_RETRY';

/**
 * 订单监控 timer 键。
 * 类型用途：为 route 内部 timer 建立稳定的结构化唯一键。
 * 数据来源：由 orderId 与 timerKind 组合生成。
 * 使用范围：orderMonitor route runtime 目录内部。
 */
export type OrderMonitorTimerKey = `${string}:${OrderMonitorTimerKind}`;

/**
 * route timer 计划。
 * 类型用途：表达某个订单当前应投影到 route runtime 的 timer key 与触发时间。
 * 数据来源：routeRuntime 按 tracked order 的 timeout、retry 与 quote retry 状态推导。
 * 使用范围：仅 orderMonitor/routeRuntime.ts 使用。
 */
export type RouteTimerSchedule = Readonly<{
  readonly key: OrderMonitorTimerKey;
  readonly atMs: number;
}>;

/**
 * route timer 注册信息。
 * 类型用途：为每个 timerKey 同时记录句柄与本次投影的计划触发时间。
 * 数据来源：routeRuntime.reconcileRouteTimers 在投影 tracked order timer 时写入。
 * 使用范围：orderMonitor route runtime 与 routing index。
 */
type OrderMonitorTimerRegistration = {
  readonly atMs: number;
  readonly handle: ReturnType<typeof setTimeout>;
};

/**
 * 单 symbol route 运行态。
 * 类型用途：维护 route 执行收敛所需的 generation、in-flight、dirty、latestQuote 与 timer 注册信息。
 * 数据来源：route runtime 在 start/trigger/stop 生命周期中维护。
 * 使用范围：orderMonitor route runtime 目录内部。
 */
export type OrderMonitorSymbolRouteState = {
  symbol: string;
  generation: number;
  inFlight: boolean;
  dirty: boolean;
  latestQuote: Quote | null;
  pendingWakeupKind: OrderMonitorWakeupKind | null;
  readonly timerHandles: Map<OrderMonitorTimerKey, OrderMonitorTimerRegistration>;
};

/**
 * route runtime 单次执行入参。
 * 类型用途：向 route 处理器暴露当前 symbol、generation 与最新唤醒来源。
 * 数据来源：route runtime 在触发执行时构造。
 * 使用范围：orderMonitor/routeRuntime.ts 与后续 routeProcessor 共享。
 */
export type RouteRuntimeProcessParams = Readonly<{
  readonly symbol: string;
  readonly generation: number;
  readonly wakeupKind: OrderMonitorWakeupKind;
  readonly latestQuote: Quote | null;
}>;

/**
 * route runtime 依赖。
 * 类型用途：创建 route runtime 所需的最小外部依赖，当前只注入 quote 事件源与 route 处理器。
 * 数据来源：由 createOrderMonitor 或测试代码装配注入。
 * 使用范围：仅 orderMonitor/routeRuntime.ts 使用。
 */
export type RouteRuntimeDeps = Readonly<{
  readonly runtime: OrderMonitorRuntimeStore;
  readonly config: OrderMonitorConfig;
  readonly marketDataClient: Pick<MarketDataClient, 'onQuoteUpdated'>;
  readonly processRoute: (params: RouteRuntimeProcessParams) => Promise<void>;
}>;

/**
 * route runtime 接口。
 * 类型用途：提供启动、停止、显式唤醒与 active route bootstrap 的最小运行时能力。
 * 数据来源：createRouteRuntime 工厂返回。
 * 使用范围：orderMonitor/index.ts 与测试使用。
 */
export interface RouteRuntime {
  start: () => void;
  stopAndDrain: () => Promise<void>;
  triggerRoute: (symbol: string, wakeupKind: OrderMonitorWakeupKind) => void;
  bootstrapActiveRoutes: () => void;
}

/**
 * orderMonitor 内部追踪订单模型。
 * 类型用途：在基础 TrackedOrder 上补充状态确认与改单恢复的窄状态字段。
 * 数据来源：trackOrder 初始化，后续由 orderOps / eventFlow / routeProcessor 更新。
 * 使用范围：orderMonitor 目录内部。
 */
export type TimeoutMarketConversionTerminalState = Readonly<{
  readonly closedReason: OrderClosedReason;
  readonly source: 'WS';
  readonly executedPrice: number | null;
  readonly executedQuantity: number | null;
  readonly executedTimeMs: number | null;
}>;

export type OrderMonitorTrackedOrder = TrackedOrder & {
  /** 连续命中 602013 的计数 */
  replaceTempBlockedCount: number;

  /** 改单恢复模式 */
  replaceResumeMode: ReplaceResumeMode;

  /** quote retry 已尝试次数 */
  quoteRetryAttempts: number;

  /** 下次允许重试 quote 的时间戳（毫秒） */
  quoteRetryNextAt: number | null;

  /** quote retry 是否已耗尽（仅用于诊断，不作为 replace/timer owner 真值） */
  quoteRetryExhausted: boolean;

  /** 卖单超时后是否已进入“等待终态确认后转市价”阶段 */
  timeoutMarketConversionPending: boolean;

  /** 卖单超时等待阶段已收到的终态快照 */
  timeoutMarketConversionTerminalState: TimeoutMarketConversionTerminalState | null;
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
  readonly bootstrappingOrderEvents: Map<string, PushOrderChanged>;
  readonly closedOrderIds: Set<string>;
  readonly queriedTerminalStateByOrderId: Map<string, TerminalStateSnapshot>;
  readonly latestReplaceOutcomeByOrderId: Map<string, ReplaceOrderOutcome>;
  readonly orderStateChangedListeners: Set<(event: OrderStateChangedEvent) => void>;
  readonly trackedOrderIdsBySymbol: Map<string, Set<string>>;
  readonly routeStatesBySymbol: Map<string, OrderMonitorSymbolRouteState>;
  readonly latestRouteGenerationBySymbol: Map<string, number>;
  runtimeState: OrderMonitorRuntimeState;
  running: boolean;
  unsubscribeQuoteUpdated: Unsubscribe | null;
};

/**
 * 恢复流程依赖。
 * 类型用途：为 recoveryFlow 提供恢复所需的状态、服务与 ACTIVE 事件回放能力。
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
  readonly triggerRoute: (symbol: string, wakeupKind: OrderMonitorWakeupKind) => void;
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
  readonly ctx: TradeContext;
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
  readonly ctx: TradeContext;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  readonly orderHoldRegistry: OrderHoldRegistry;
  readonly orderStatusQuery: OrderStatusQuery;
  readonly triggerRoute: (symbol: string, wakeupKind: OrderMonitorWakeupKind) => void;
};

/**
 * 订单操作流接口。
 * 类型用途：封装订单追踪、撤单、改单的运行态修改行为。
 * 数据来源：createOrderOps 工厂返回。
 * 使用范围：orderMonitor/index.ts 与 routeProcessor.ts 调用。
 */
export interface OrderOps {
  trackOrder: (params: TrackOrderParams) => void;
  cancelOrder: (orderId: string) => Promise<CancelOrderOutcome>;
  replaceOrderPrice: (orderId: string, newPrice: number, quantity?: number | null) => Promise<void>;
}

/**
 * routeProcessor 依赖。
 * 类型用途：为单 symbol route 的一次业务推进提供最小依赖集合。
 * 数据来源：由 createOrderMonitor 或测试代码装配注入。
 * 使用范围：仅 orderMonitor/routeProcessor.ts 使用。
 */
export type RouteProcessorDeps = {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly config: OrderMonitorConfig;
  readonly thresholdDecimal: Decimal;
  readonly orderRecorder: OrderRecorder;
  readonly ctx: TradeContext;
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
 * routeProcessor 接口。
 * 类型用途：封装单 symbol route 的一次动作选择与推进过程。
 * 数据来源：createRouteProcessor 工厂返回。
 * 使用范围：routeRuntime 与测试代码使用。
 */
export interface RouteProcessor {
  processRoute: (params: RouteRuntimeProcessParams) => Promise<void>;
}

/**
 * 卖单终态后的 pending sell 占用处置。
 * 类型用途：声明终态结算后是直接释放占用，还是为后续跟进卖单保留占位。
 * 数据来源：由 routeProcessor 等终态调用方按业务路径传入。
 * 使用范围：orderMonitor/settlementFlow.ts 与相关调用链。
 */
type PendingSellDisposition =
  | {
      readonly kind: 'RELEASE';
    }
  | {
      readonly kind: 'HANDOFF_TO_FOLLOW_UP_SELL';
      readonly followUpQuantity: number;
    };

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
  readonly pendingSellDisposition?: PendingSellDisposition;
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
  readonly protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;
  readonly postTradeConsistencyRuntime: PostTradeConsistencyRuntimePort;
  readonly emitOrderStateChanged: (event: OrderStateChangedEvent) => void;
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
 * 数据来源：来源于 Longbridge 交易接口返回的错误码约定。
 * 使用范围：仅在 orderMonitor 模块的错误分类流程使用。
 */
export type OrderClosedErrorCode = '601011' | '601012' | '601013' | '603001';

/**
 * 不支持改单（类型不支持）错误码类型。
 * 类型用途：标识因订单类型限制导致的改单拒绝错误。
 * 数据来源：来源于 Longbridge 交易接口返回的错误码约定。
 * 使用范围：仅在 orderMonitor 模块的改单错误分类流程使用。
 */
export type ReplaceUnsupportedByTypeErrorCode = '602012';

/**
 * 不支持改单（状态暂不允许）错误码类型。
 * 类型用途：标识因订单状态限制导致的临时改单拒绝错误。
 * 数据来源：来源于 Longbridge 交易接口返回的错误码约定。
 * 使用范围：仅在 orderMonitor 模块的改单错误分类流程使用。
 */
export type ReplaceTempBlockedErrorCode = '602013';
