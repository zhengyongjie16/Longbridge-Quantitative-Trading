import type { Logger } from '../../utils/logger/types.js';
import type {
  MarketDataClient,
  MonitorConfig,
  MultiMonitorTradingConfig,
  Position,
  RawOrderFromAPI,
  SeatSymbolSnapshotEntry,
  StartupGateMode,
  SymbolRegistry,
  TradingDayInfo,
} from '../../types/index.js';
import type { WarrantListCacheConfig } from '../../services/autoSymbolFinder/types.js';

export type StartupGateDeps = {
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly resolveTradingDayInfo: (currentTime: Date) => Promise<TradingDayInfo>;
  readonly isInSession: (currentTime: Date, isHalfDay: boolean) => boolean;
  readonly isInOpenProtection: (currentTime: Date, minutes: number) => boolean;
  readonly openProtection: {
    readonly enabled: boolean;
    readonly minutes: number | null;
  };
  readonly intervalMs: number;
  readonly logger: Logger;
};

export type StartupGate = {
  wait(params: { readonly mode: StartupGateMode }): Promise<TradingDayInfo>;
};

export type SeatSnapshotInput = {
  readonly monitors: ReadonlyArray<
    Pick<MonitorConfig, 'monitorSymbol' | 'autoSearchConfig' | 'longSymbol' | 'shortSymbol'>
  >;
  readonly positions: ReadonlyArray<Position>;
  readonly orders: ReadonlyArray<RawOrderFromAPI>;
};

export type SeatSnapshot = {
  readonly entries: ReadonlyArray<SeatSymbolSnapshotEntry>;
};

export type PrepareSeatsOnStartupDeps = {
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly positions: ReadonlyArray<Position>;
  readonly orders: ReadonlyArray<RawOrderFromAPI>;
  readonly marketDataClient: MarketDataClient;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly intervalMs: number;
  readonly logger: Logger;
  readonly getTradingMinutesSinceOpen: (currentTime: Date) => number;
  readonly isWithinMorningOpenProtection: (currentTime: Date, minutes: number) => boolean;
  readonly warrantListCacheConfig?: WarrantListCacheConfig;
};

export type PreparedSeats = {
  readonly seatSymbols: ReadonlyArray<SeatSymbolSnapshotEntry>;
};
