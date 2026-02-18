import type { Logger } from '../../utils/logger/types.js';
import type { DailyLossTracker } from '../../core/riskController/types.js';
import type { TradeLogHydrator } from '../../services/liquidationCooldown/types.js';
import type { WarrantListCacheConfig } from '../../services/autoSymbolFinder/types.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { LifecycleState, SymbolRegistry } from '../../types/seat.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import type { MarketDataClient, RawOrderFromAPI, Trader } from '../../types/services.js';

/**
 * 每次 tick 传入的运行时标志。
 * 由外部计算后注入，生命周期管理器只读取不修改。
 */
export type LifecycleRuntimeFlags = Readonly<{
  dayKey: string | null;
  canTradeNow: boolean;
  isTradingDay: boolean;
}>;

/**
 * 生命周期管理器持有的可变状态。
 * 记录当前日期键、生命周期阶段、开盘重建标志及交易门禁开关。
 */
export type LifecycleMutableState = {
  currentDayKey: string | null;
  lifecycleState: LifecycleState;
  pendingOpenRebuild: boolean;
  targetTradingDayKey: string | null;
  isTradingEnabled: boolean;
};

/**
 * 传递给各 CacheDomain 回调的上下文，包含当前时间和运行时标志。
 */
export type LifecycleContext = Readonly<{
  now: Date;
  runtime: LifecycleRuntimeFlags;
}>;

/**
 * 缓存域接口，每个域负责自身数据的午夜清理与开盘重建。
 * 由 DayLifecycleManager 按注册顺序（清理）或逆序（重建）依次调用。
 */
export interface CacheDomain {
  readonly midnightClear: (ctx: LifecycleContext) => Promise<void> | void;
  readonly openRebuild: (ctx: LifecycleContext) => Promise<void> | void;
}

/**
 * 交易日生命周期管理器接口，对外暴露 tick 方法供主循环每秒驱动。
 */
export interface DayLifecycleManager {
  readonly tick: (now: Date, runtime: LifecycleRuntimeFlags) => Promise<void>;
}

/**
 * createDayLifecycleManager 的依赖注入参数。
 */
export type DayLifecycleManagerDeps = Readonly<{
  mutableState: LifecycleMutableState;
  cacheDomains: ReadonlyArray<CacheDomain>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  rebuildRetryDelayMs?: number;
}>;

/**
 * rebuildTradingDayState 的外部依赖，包含行情、交易、状态及账户展示回调。
 */
export type RebuildTradingDayStateDeps = Readonly<{
  marketDataClient: MarketDataClient;
  trader: Trader;
  lastState: LastState;
  symbolRegistry: SymbolRegistry;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  dailyLossTracker: DailyLossTracker;
  displayAccountAndPositions: (params: {
    readonly lastState: LastState;
    readonly quotesMap: ReadonlyMap<string, Quote | null>;
  }) => Promise<void>;
}>;

/**
 * rebuildTradingDayState 的调用参数，包含当日订单列表和行情快照。
 */
export type RebuildTradingDayStateParams = Readonly<{
  allOrders: ReadonlyArray<RawOrderFromAPI>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

/**
 * loadTradingDayRuntimeSnapshot 的调用参数，控制加载行为的各项开关。
 */
export type LoadTradingDayRuntimeSnapshotParams = Readonly<{
  now: Date;
  requireTradingDay: boolean;
  failOnOrderFetchError: boolean;
  resetRuntimeSubscriptions: boolean;
  hydrateCooldownFromTradeLog: boolean;
  forceOrderRefresh: boolean;
}>;

/**
 * loadTradingDayRuntimeSnapshot 的返回结果，包含当日订单和行情快照。
 */
export type LoadTradingDayRuntimeSnapshotResult = Readonly<{
  allOrders: ReadonlyArray<RawOrderFromAPI>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

/**
 * loadTradingDayRuntimeSnapshot 的外部依赖，包含行情、交易、配置及辅助服务。
 */
export type LoadTradingDayRuntimeSnapshotDeps = Readonly<{
  marketDataClient: MarketDataClient;
  trader: Trader;
  lastState: LastState;
  tradingConfig: MultiMonitorTradingConfig;
  symbolRegistry: SymbolRegistry;
  dailyLossTracker: DailyLossTracker;
  tradeLogHydrator: TradeLogHydrator;
  warrantListCacheConfig: WarrantListCacheConfig;
}>;
