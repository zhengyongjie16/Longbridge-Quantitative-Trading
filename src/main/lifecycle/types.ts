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
 * 每次 tick 传入的运行时标志（生命周期 tick 的入参之一）。
 * 类型用途：供 DayLifecycleManager.tick 使用，表示当日键、是否可交易、是否交易日等；管理器只读不写。
 * 数据来源：由主循环根据当前时间与交易日历等计算后传入 tick(now, runtime)。
 * 使用范围：仅 lifecycle 模块及主程序调用 tick 处使用，内部使用。
 */
export type LifecycleRuntimeFlags = Readonly<{
  dayKey: string | null;
  canTradeNow: boolean;
  isTradingDay: boolean;
}>;

/**
 * 生命周期管理器持有的可变状态。
 * 类型用途：记录当前日期键、生命周期阶段、待开盘重建标志及交易门禁开关，供 tick 与缓存域回调读写。
 * 数据来源：由 createDayLifecycleManager 创建并由管理器内部在 tick 与 openRebuild 时更新。
 * 使用范围：仅 lifecycle 模块内部使用。
 */
export type LifecycleMutableState = {
  currentDayKey: string | null;
  lifecycleState: LifecycleState;
  pendingOpenRebuild: boolean;
  targetTradingDayKey: string | null;
  isTradingEnabled: boolean;
};

/**
 * 传递给各 CacheDomain 回调的上下文（midnightClear / openRebuild 的入参）。
 * 类型用途：供各缓存域在午夜清理与开盘重建时使用，包含当前时间与运行时标志。
 * 数据来源：由 DayLifecycleManager 在调用 cacheDomain.midnightClear/openRebuild 时组装传入。
 * 使用范围：仅 lifecycle 与各 cacheDomains 使用，内部使用。
 */
export type LifecycleContext = Readonly<{
  now: Date;
  runtime: LifecycleRuntimeFlags;
}>;

/**
 * 缓存域接口，每个域负责自身数据的午夜清理与开盘重建。
 * 类型用途：依赖注入给 DayLifecycleManager，在跨日与开盘时被调用；midnightClear 按注册顺序、openRebuild 按逆序执行。
 * 数据来源：由主程序注册各 CacheDomain 实现（如 globalStateDomain、orderDomain 等）。
 * 使用范围：仅 lifecycle 模块及 cacheDomains 实现使用。
 */
export interface CacheDomain {
  readonly midnightClear: (ctx: LifecycleContext) => Promise<void> | void;
  readonly openRebuild: (ctx: LifecycleContext) => Promise<void> | void;
}

/**
 * 交易日生命周期管理器接口。
 * 类型用途：对外暴露 tick 方法，供主循环每秒驱动；内部根据 dayKey 与状态执行午夜清理与开盘重建。
 * 数据来源：由 createDayLifecycleManager(DayLifecycleManagerDeps) 返回。
 * 使用范围：仅主程序 mainProgram 调用。
 */
export interface DayLifecycleManager {
  readonly tick: (now: Date, runtime: LifecycleRuntimeFlags) => Promise<void>;
}

/**
 * 交易日生命周期管理器依赖（创建 DayLifecycleManager 时的参数）。
 * 类型用途：createDayLifecycleManager 的依赖注入，包含可变状态、缓存域列表、日志与重试间隔等。
 * 数据来源：由主程序/启动流程组装并传入工厂。
 * 使用范围：仅 lifecycle 及启动流程使用，内部使用。
 */
export type DayLifecycleManagerDeps = Readonly<{
  mutableState: LifecycleMutableState;
  cacheDomains: ReadonlyArray<CacheDomain>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  rebuildRetryDelayMs?: number;
}>;

/**
 * rebuildTradingDayState 的外部依赖（开盘重建时刷新交易状态所需的注入）。
 * 类型用途：包含行情客户端、交易、lastState、symbolRegistry、monitorContexts、dailyLossTracker、displayAccountAndPositions 等。
 * 数据来源：由 lifecycle 或 cacheDomains 在创建/调用 rebuildTradingDayState 时传入。
 * 使用范围：仅 lifecycle 内部使用。
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
 * rebuildTradingDayState 的调用参数。
 * 类型用途：传入当日订单列表与行情快照，供开盘重建时刷新状态与展示。
 * 数据来源：由调用方在 openRebuild 流程中获取订单与行情后传入。
 * 使用范围：仅 lifecycle 内部使用。
 */
export type RebuildTradingDayStateParams = Readonly<{
  allOrders: ReadonlyArray<RawOrderFromAPI>;
  quotesMap: ReadonlyMap<string, Quote | null>;
  now?: Date;
}>;

/**
 * loadTradingDayRuntimeSnapshot 的调用参数。
 * 类型用途：控制加载行为：是否要求交易日、订单拉取失败是否抛错、是否重置订阅、是否从成交记录恢复冷却等。
 * 数据来源：由启动流程或开盘重建逻辑根据场景组装传入。
 * 使用范围：仅 lifecycle 内部使用。
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
 * loadTradingDayRuntimeSnapshot 的返回结果。
 * 类型用途：包含当日订单列表与行情快照，供后续重建状态与展示使用。
 * 数据来源：由 loadTradingDayRuntimeSnapshot 内部拉取订单与行情后返回。
 * 使用范围：仅 lifecycle 内部使用。
 */
export type LoadTradingDayRuntimeSnapshotResult = Readonly<{
  allOrders: ReadonlyArray<RawOrderFromAPI>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

/**
 * loadTradingDayRuntimeSnapshot 的外部依赖。
 * 类型用途：封装行情客户端、交易、配置及辅助服务，作为 loadTradingDayRuntimeSnapshot 的入参。
 * 数据来源：由启动流程或开盘重建调用方组装传入。
 * 使用范围：仅 lifecycle 内部使用。
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

/** 交易日历预热错误码 */
export type TradingCalendarPrewarmErrorCode =
  | 'TRADING_CALENDAR_LOOKBACK_EXCEEDED'
  | 'TRADING_CALENDAR_INVALID_DATE_KEY';

/** 交易日历预热错误上下文（便于日志与告警） */
export type TradingCalendarPrewarmErrorDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

/** 交易日历预热错误构造参数 */
export type TradingCalendarPrewarmErrorParams = Readonly<{
  code: TradingCalendarPrewarmErrorCode;
  message: string;
  details: TradingCalendarPrewarmErrorDetails;
}>;

/** 按自然月分块时的单块日期区间 */
export type DateRangeChunk = Readonly<{
  startKey: string;
  endKey: string;
  dateKeys: ReadonlyArray<string>;
}>;

/** 重建阶段预热交易日历快照的入参 */
export type PrewarmTradingCalendarSnapshotParams = Readonly<{
  marketDataClient: MarketDataClient;
  lastState: LastState;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  now: Date;
}>;
