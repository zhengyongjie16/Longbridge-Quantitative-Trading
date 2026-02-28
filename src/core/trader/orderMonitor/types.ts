import type { Decimal, PushOrderChanged, TradeContext } from 'longport';
import type { MultiMonitorTradingConfig } from '../../../types/config.js';
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
  CancelOrderResult,
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
  readonly pendingRefreshSymbols: PendingRefreshSymbol[];
  readonly bootstrappingOrderEvents: Map<string, PushOrderChanged>;
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
  readonly cancelOrder: (orderId: string) => Promise<boolean>;
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
  readonly orderHoldRegistry: OrderHoldRegistry;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly refreshGate?: RefreshGate;
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
  readonly orderRecorder: OrderRecorder;
  readonly orderHoldRegistry: OrderHoldRegistry;
};

/**
 * 订单操作流接口。
 * 类型用途：封装订单追踪、撤单、改单的运行态修改行为。
 * 数据来源：createOrderOps 工厂返回。
 * 使用范围：orderMonitor/index.ts 与 quoteFlow.ts 调用。
 */
export interface OrderOps {
  trackOrder: (params: TrackOrderParams) => void;
  cancelOrderWithRuntimeCleanup: (orderId: string) => Promise<CancelOrderResult>;
  cancelOrder: (orderId: string) => Promise<boolean>;
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
  readonly cancelOrder: (orderId: string) => Promise<boolean>;
  readonly cancelOrderWithRuntimeCleanup: (orderId: string) => Promise<CancelOrderResult>;
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
