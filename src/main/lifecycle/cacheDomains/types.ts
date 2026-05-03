import type { LastState, MonitorContext } from '../../../types/state.js';
import type { MultiMonitorTradingConfig } from '../../../types/config.js';
import type { SymbolRegistry } from '../../../types/seat.js';
import type { MarketDataClient, Trader } from '../../../types/services.js';
import type { Processor } from '../../asyncProgram/types.js';
import type {
  TaskQueue,
  BuyTaskType,
  SellTaskType,
} from '../../asyncProgram/tradeTaskQueue/types.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskProcessor,
} from '../../asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTaskQueue } from '../../asyncProgram/monitorTaskQueue/types.js';
import type { IndicatorCache } from '../../asyncProgram/indicatorCache/types.js';
import type { TradingRiskEventRuntime } from '../../tradingRiskEventRuntime/types.js';
import type { BusinessEventProgram } from '../../businessEventProgram/types.js';
import type {
  MonitorQuoteEventRuntime,
  SwitchWakeupRuntime,
} from '../../monitorQuoteEventRuntime/types.js';
import type { MonitorDisplayRuntime } from '../../monitorDisplayRuntime/types.js';
import type { TradingQuoteDisplayRuntime } from '../../tradingQuoteDisplayRuntime/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../../periodicSwitchWakeupRuntime/types.js';
import type { QuoteSubscriptionRuntime } from '../../quoteSubscriptionRuntime/types.js';
import type { AutoSearchWakeupRuntime } from '../../autoSearchWakeupRuntime/types.js';
import type { SeatActivationDispatcher } from '../../seatActivationDispatcher/types.js';
import type { SeatRuntimeCleanupDispatcher } from '../../seatRuntimeCleanupDispatcher/types.js';
import type { WarrantListCache } from '../../../services/autoSymbolFinder/types.js';
import type { SignalProcessor } from '../../../core/signalProcessor/types.js';
import type { DailyLossTracker } from '../../../types/risk.js';
import type { LiquidationCooldownTracker } from '../../../services/liquidationCooldown/types.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../../core/trader/protectiveLiquidationEpisodeTracker/types.js';

/**
 * lifecycle 持有的成交后一致性 runtime 最小契约。
 * 类型用途：约束 signalRuntimeDomain 在生命周期切换时对 runtime 的启停与 baseline 推进能力。
 * 数据来源：由 app 层注入 PostTradeConsistencyRuntime 实例。
 * 使用范围：仅 lifecycle signalRuntimeDomain 使用。
 */
interface SignalRuntimePostTradeConsistencyRuntime {
  readonly abortWaiting: () => void;
  readonly resetAbort: () => void;
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly midnightClear: () => void;
  readonly completeRebuildBaseline: () => void;
}

/**
 * 信号运行时域依赖。
 * 类型用途：createSignalRuntimeDomain 的入参，提供监控上下文、订单监控 runtime、买卖/监控处理器、runtime 所有权与队列等。
 * 数据来源：由 lifecycle 或主程序在注册 cacheDomains 时组装传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export type SignalRuntimeDomainDeps = Readonly<{
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  buyProcessor: Processor;
  sellProcessor: Processor;
  monitorTaskProcessor: MonitorTaskProcessor;
  businessEventProgram: Pick<BusinessEventProgram, 'start' | 'stopAndDrain'>;
  tradingRiskEventRuntime: Pick<TradingRiskEventRuntime, 'start' | 'stopAndDrain'>;
  monitorQuoteEventRuntime: MonitorQuoteEventRuntime;
  monitorDisplayRuntime: Pick<MonitorDisplayRuntime, 'start' | 'stopAndDrain'>;
  tradingQuoteDisplayRuntime: Pick<TradingQuoteDisplayRuntime, 'start' | 'stopAndDrain'>;
  switchWakeupRuntime: Pick<SwitchWakeupRuntime, 'start' | 'stopAndDrain'>;
  periodicSwitchWakeupRuntime: Pick<PeriodicSwitchWakeupRuntime, 'start' | 'stopAndDrain'>;
  quoteSubscriptionRuntime: Pick<
    QuoteSubscriptionRuntime,
    'reconcileFromCurrentTruth' | 'start' | 'stopAndDrain'
  >;
  autoSearchWakeupRuntime: Pick<AutoSearchWakeupRuntime, 'start' | 'stopAndDrain'>;
  seatActivationDispatcher: Pick<SeatActivationDispatcher, 'start' | 'stop'>;
  seatRuntimeCleanupDispatcher: Pick<SeatRuntimeCleanupDispatcher, 'start' | 'stop'>;
  trader: Pick<Trader, 'startOrderMonitorRuntime' | 'stopOrderMonitorRuntimeAndDrain'>;
  postTradeConsistencyRuntime: SignalRuntimePostTradeConsistencyRuntime;
  indicatorCache: IndicatorCache;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
}>;

/**
 * 席位域依赖。
 * 类型用途：createSeatDomain 的入参，提供 tradingConfig、symbolRegistry、monitorContexts、warrantListCache。
 * 数据来源：由 lifecycle 在注册 cacheDomains 时组装传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export type SeatDomainDeps = Readonly<{
  tradingConfig: MultiMonitorTradingConfig;
  symbolRegistry: SymbolRegistry;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  warrantListCache: WarrantListCache;
}>;

/**
 * 订单域依赖。
 * 类型用途：createOrderDomain 的入参，提供 trader.resetRuntimeState 用于午夜清理时重置运行时状态。
 * 数据来源：由 lifecycle 在注册 cacheDomains 时传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export type OrderDomainDeps = Readonly<{
  trader: Pick<Trader, 'resetRuntimeState'>;
}>;

/**
 * 风险域依赖。
 * 类型用途：createRiskDomain 的入参，提供 signalProcessor、dailyLossTracker、monitorContexts、liquidationCooldownTracker。
 * 数据来源：由 lifecycle 在注册 cacheDomains 时组装传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export type RiskDomainDeps = Readonly<{
  signalProcessor: SignalProcessor;
  dailyLossTracker: DailyLossTracker;
  protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  liquidationCooldownTracker: LiquidationCooldownTracker;
}>;

/**
 * 行情数据域依赖。
 * 类型用途：createMarketDataDomain 的入参，提供 marketDataClient 用于午夜清理时重置订阅与缓存。
 * 数据来源：由 lifecycle 在注册 cacheDomains 时传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export type MarketDataDomainDeps = Readonly<{
  marketDataClient: MarketDataClient;
}>;

/**
 * 全局状态域依赖。
 * 类型用途：createGlobalStateDomain 的入参，提供 lastState 与 runTradingDayOpenRebuild 用于午夜清理与开盘重建。
 * 数据来源：由 lifecycle 在注册 cacheDomains 时传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export type GlobalStateDomainDeps = Readonly<{
  lastState: LastState;
  runTradingDayOpenRebuild: (now: Date) => Promise<void>;
}>;
