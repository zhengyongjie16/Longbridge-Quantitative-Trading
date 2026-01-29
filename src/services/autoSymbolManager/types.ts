import type {
  Quote,
  MarketDataClient,
  MonitorConfig,
  OrderRecorder,
  PendingOrder,
  Position,
  RiskChecker,
  SeatState,
  SeatVersion,
  SymbolRegistry,
  Trader,
} from '../../types/index.js';

export type SeatDirection = 'LONG' | 'SHORT';

export type AutoSymbolManagerDeps = {
  readonly monitorConfig: MonitorConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly orderRecorder: OrderRecorder;
  readonly riskChecker: RiskChecker;
  readonly now?: () => Date;
};

export type EnsureSeatOnStartupParams = {
  readonly direction: SeatDirection;
  readonly initialSymbol: string | null;
};

export type SearchOnTickParams = {
  readonly direction: SeatDirection;
  readonly currentTime: Date;
  readonly canTradeNow: boolean;
};

export type SwitchOnDistanceParams = {
  readonly direction: SeatDirection;
  readonly monitorPrice: number | null;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
  readonly positions: ReadonlyArray<Position>;
  readonly pendingOrders: ReadonlyArray<PendingOrder>;
};

export type SwitchState = {
  direction: SeatDirection;
  oldSymbol: string;
  startedAt: number;
  sellSubmitted: boolean;
  sellNotional: number | null;
  shouldRebuy: boolean;
  awaitingQuote: boolean;
};

export type AutoSymbolManager = {
  ensureSeatOnStartup(params: EnsureSeatOnStartupParams): SeatState;
  maybeSearchOnTick(params: SearchOnTickParams): Promise<void>;
  maybeSwitchOnDistance(params: SwitchOnDistanceParams): Promise<void>;
  clearSeat(params: { direction: SeatDirection; reason: string }): SeatVersion;
};
