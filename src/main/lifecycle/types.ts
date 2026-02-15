/**
 * 生命周期模块类型定义
 *
 * 包含：
 * - LifecycleRuntimeFlags：每次 tick 传入的运行时标志（dayKey、交易日、交易时段）
 * - LifecycleMutableState：生命周期管理器持有的可变状态
 * - LifecycleContext：传递给各 CacheDomain 的上下文
 * - CacheDomain：缓存域接口（午夜清理 + 开盘重建）
 * - DayLifecycleManager：生命周期管理器接口
 * - RebuildTradingDayState / LoadTradingDayRuntimeSnapshot：重建和加载的依赖与参数类型
 */
import type { Logger } from '../../utils/logger/types.js';
import type { DailyLossTracker } from '../../core/riskController/types.js';
import type { TradeLogHydrator } from '../../services/liquidationCooldown/types.js';
import type { WarrantListCacheConfig } from '../../services/autoSymbolFinder/types.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { LifecycleState, SymbolRegistry } from '../../types/seat.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import type { MarketDataClient, RawOrderFromAPI, Trader } from '../../types/services.js';

export type LifecycleRuntimeFlags = Readonly<{
  dayKey: string | null;
  canTradeNow: boolean;
  isTradingDay: boolean;
}>;

export type LifecycleMutableState = {
  currentDayKey: string | null;
  lifecycleState: LifecycleState;
  pendingOpenRebuild: boolean;
  targetTradingDayKey: string | null;
  isTradingEnabled: boolean;
};

export type LifecycleContext = Readonly<{
  now: Date;
  runtime: LifecycleRuntimeFlags;
}>;

export interface CacheDomain {
  readonly midnightClear: (ctx: LifecycleContext) => Promise<void> | void;
  readonly openRebuild: (ctx: LifecycleContext) => Promise<void> | void;
}

export interface DayLifecycleManager {
  readonly tick: (now: Date, runtime: LifecycleRuntimeFlags) => Promise<void>;
}

export type DayLifecycleManagerDeps = Readonly<{
  mutableState: LifecycleMutableState;
  cacheDomains: ReadonlyArray<CacheDomain>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  rebuildRetryDelayMs?: number;
}>;

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

export type RebuildTradingDayStateParams = Readonly<{
  allOrders: ReadonlyArray<RawOrderFromAPI>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

export type LoadTradingDayRuntimeSnapshotParams = Readonly<{
  now: Date;
  requireTradingDay: boolean;
  failOnOrderFetchError: boolean;
  resetRuntimeSubscriptions: boolean;
  hydrateCooldownFromTradeLog: boolean;
  forceOrderRefresh: boolean;
}>;

export type LoadTradingDayRuntimeSnapshotResult = Readonly<{
  allOrders: ReadonlyArray<RawOrderFromAPI>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

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
