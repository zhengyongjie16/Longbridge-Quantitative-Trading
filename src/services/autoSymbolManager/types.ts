/**
 * 自动换标管理器类型定义
 *
 * 包含席位管理与换标流程相关的类型：
 * - SeatDirection：席位方向（做多/做空）
 * - SeatEntry：席位注册表内部条目
 * - SwitchState：换标状态机状态
 * - AutoSymbolManager：管理器接口
 *
 * 换标流程状态：
 * - READY：席位就绪，可正常交易
 * - SEARCHING：正在自动寻标
 * - SWITCHING：正在执行换标（撤单/卖出/买入）
 * - EMPTY：席位为空，等待自动寻标
 */
import type {
  Quote,
  MarketDataClient,
  MonitorConfig,
  OrderRecorder,
  Position,
  RiskChecker,
  SeatState,
  SeatVersion,
  SymbolRegistry,
  Trader,
} from '../../types/index.js';
import type { WarrantListCacheConfig } from '../autoSymbolFinder/types.js';

export type SeatDirection = 'LONG' | 'SHORT';

/**
 * 席位注册表内部条目（可变状态，SymbolRegistry 内部使用）
 * 注意：状态与版本号需要在运行中更新，因此不使用 readonly。
 */
export type SeatEntry = {
  state: SeatState;
  version: SeatVersion;
};

/**
 * 单个监控标的的席位条目（可变状态，SymbolRegistry 内部使用）
 */
export type SymbolSeatEntry = {
  long: SeatEntry;
  short: SeatEntry;
};

export type AutoSymbolManagerDeps = {
  readonly monitorConfig: MonitorConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly orderRecorder: OrderRecorder;
  readonly riskChecker: RiskChecker;
  readonly warrantListCacheConfig?: WarrantListCacheConfig;
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
};

export type SwitchState = {
  direction: SeatDirection;
  oldSymbol: string;
  nextSymbol: string | null;
  startedAt: number;
  sellSubmitted: boolean;
  sellNotional: number | null;
  shouldRebuy: boolean;
  awaitingQuote: boolean;
};

export type SwitchSuppression = {
  readonly symbol: string;
  readonly dateKey: string;
};

export type AutoSymbolManager = {
  ensureSeatOnStartup(params: EnsureSeatOnStartupParams): SeatState;
  maybeSearchOnTick(params: SearchOnTickParams): Promise<void>;
  maybeSwitchOnDistance(params: SwitchOnDistanceParams): Promise<void>;
  hasPendingSwitch(direction: SeatDirection): boolean;
  clearSeat(params: { direction: SeatDirection; reason: string }): SeatVersion;
  resetDailySwitchSuppression(): void;
};
