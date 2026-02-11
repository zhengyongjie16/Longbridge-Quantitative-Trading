import type { Logger } from '../../utils/logger/types.js';
import type { DailyLossTracker } from '../../core/riskController/types.js';
import type { TradeLogHydrator } from '../../services/liquidationCooldown/types.js';
import type { WarrantListCacheConfig } from '../../services/autoSymbolFinder/types.js';
import type {
  LastState,
  LifecycleState,
  MarketDataClient,
  MonitorContext,
  MultiMonitorTradingConfig,
  Quote,
  RawOrderFromAPI,
  SymbolRegistry,
  Trader,
} from '../../types/index.js';

export type LifecycleRuntimeFlags = Readonly<{
  readonly dayKey: string | null;
  readonly canTradeNow: boolean;
  readonly isTradingDay: boolean;
}>;

export type LifecycleMutableState = {
  currentDayKey: string | null;
  lifecycleState: LifecycleState;
  pendingOpenRebuild: boolean;
  targetTradingDayKey: string | null;
  isTradingEnabled: boolean;
};

export type LifecycleContext = Readonly<{
  readonly now: Date;
  readonly runtime: LifecycleRuntimeFlags;
}>;

export type CacheDomain = Readonly<{
  readonly name: string;
  midnightClear: (ctx: LifecycleContext) => Promise<void> | void;
  openRebuild: (ctx: LifecycleContext) => Promise<void> | void;
}>;

export type DayLifecycleManager = Readonly<{
  tick: (now: Date, runtime: LifecycleRuntimeFlags) => Promise<void>;
  getState: () => LifecycleState;
  isTradingEnabled: () => boolean;
}>;

export type DayLifecycleManagerDeps = Readonly<{
  readonly mutableState: LifecycleMutableState;
  readonly cacheDomains: ReadonlyArray<CacheDomain>;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly rebuildRetryDelayMs?: number;
}>;

export type RebuildTradingDayStateDeps = Readonly<{
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly lastState: LastState;
  readonly symbolRegistry: SymbolRegistry;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly dailyLossTracker: DailyLossTracker;
  readonly displayAccountAndPositions: (params: {
    readonly lastState: LastState;
    readonly quotesMap: ReadonlyMap<string, Quote | null>;
  }) => Promise<void>;
}>;

export type RebuildTradingDayStateParams = Readonly<{
  readonly allOrders: ReadonlyArray<RawOrderFromAPI>;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
}>;

export type LoadTradingDayRuntimeSnapshotParams = Readonly<{
  readonly now: Date;
  readonly requireTradingDay: boolean;
  readonly failOnOrderFetchError: boolean;
  readonly resetRuntimeSubscriptions: boolean;
  readonly hydrateCooldownFromTradeLog: boolean;
  readonly forceOrderRefresh: boolean;
}>;

export type LoadTradingDayRuntimeSnapshotResult = Readonly<{
  readonly allOrders: ReadonlyArray<RawOrderFromAPI>;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
}>;

export type LoadTradingDayRuntimeSnapshotDeps = Readonly<{
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly lastState: LastState;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly dailyLossTracker: DailyLossTracker;
  readonly tradeLogHydrator: TradeLogHydrator;
  readonly warrantListCacheConfig: WarrantListCacheConfig;
}>;
