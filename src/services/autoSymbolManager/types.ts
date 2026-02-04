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
  AutoSearchConfig,
  MarketDataClient,
  MonitorConfig,
  OrderRecorder,
  PendingOrder,
  Position,
  Quote,
  RiskChecker,
  SeatState,
  SeatStatus,
  SeatVersion,
  Signal,
  SymbolRegistry,
  Trader,
} from '../../types/index.js';
import type { Logger } from '../../utils/logger/types.js';
import type { ObjectPool, PoolableSignal } from '../../utils/objectPool/types.js';
import type {
  FindBestWarrantInput,
  WarrantCandidate,
  WarrantListCacheConfig,
} from '../autoSymbolFinder/types.js';

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
  seatVersion: SeatVersion;
  stage: SwitchStage;
  oldSymbol: string;
  nextSymbol: string | null;
  startedAt: number;
  sellSubmitted: boolean;
  sellNotional: number | null;
  shouldRebuy: boolean;
  awaitingQuote: boolean;
};

type SwitchStage =
  | 'CANCEL_PENDING'
  | 'SELL_OUT'
  | 'BIND_NEW'
  | 'WAIT_QUOTE'
  | 'REBUY'
  | 'COMPLETE'
  | 'FAILED';

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

type SignalObjectPool = Pick<ObjectPool<PoolableSignal>, 'acquire' | 'release'>;

type SwitchStateMap = Map<SeatDirection, SwitchState>;

type SwitchSuppressionMap = Map<SeatDirection, SwitchSuppression>;

type TradingMinutesResolver = (date: Date | null | undefined) => number;

type HKDateKeyResolver = (date: Date | null | undefined) => string | null;

type MorningOpenProtectionChecker = (
  date: Date | null | undefined,
  minutes: number,
) => boolean;

export type ResolveAutoSearchThresholdInputParams = {
  readonly direction: SeatDirection;
  readonly autoSearchConfig: AutoSearchConfig;
  readonly monitorSymbol: string;
  readonly logPrefix: string;
  readonly logger: Logger;
};

export type BuildFindBestWarrantInputParams = {
  readonly direction: SeatDirection;
  readonly monitorSymbol: string;
  readonly autoSearchConfig: AutoSearchConfig;
  readonly currentTime: Date;
  readonly marketDataClient: MarketDataClient;
  readonly warrantListCacheConfig?: WarrantListCacheConfig;
  readonly minPrice: number;
  readonly minTurnoverPerMinute: number;
  readonly getTradingMinutesSinceOpen: TradingMinutesResolver;
  readonly logger: Logger;
};

export type ResolveAutoSearchThresholdInput = (
  params: Pick<ResolveAutoSearchThresholdInputParams, 'direction' | 'logPrefix'>,
) => Readonly<{
  minPrice: number;
  minTurnoverPerMinute: number;
}> | null;

export type BuildFindBestWarrantInput = (
  params: Pick<
    BuildFindBestWarrantInputParams,
    'direction' | 'currentTime' | 'minPrice' | 'minTurnoverPerMinute'
  >,
) => Promise<FindBestWarrantInput>;

export type ThresholdResolverDeps = {
  readonly autoSearchConfig: AutoSearchConfig;
  readonly monitorSymbol: string;
  readonly marketDataClient: MarketDataClient;
  readonly warrantListCacheConfig?: WarrantListCacheConfig;
  readonly logger: Logger;
  readonly getTradingMinutesSinceOpen: TradingMinutesResolver;
};

export type BuildOrderSignalParams = {
  readonly action: Signal['action'];
  readonly symbol: string;
  readonly quote: Quote | null;
  readonly reason: string;
  readonly orderTypeOverride: Signal['orderTypeOverride'];
  readonly quantity: number | null;
  readonly seatVersion: SeatVersion;
};

export type OrderSignalBuilder = (params: BuildOrderSignalParams) => Signal;

export type SignalBuilderDeps = {
  readonly signalObjectPool: SignalObjectPool;
};

export type SeatStateBuilder = (
  symbol: string | null,
  status: SeatStatus,
  lastSwitchAt: number | null,
  lastSearchAt: number | null,
) => SeatState;

export type SeatStateUpdater = (
  direction: SeatDirection,
  nextState: SeatState,
  bumpOnSymbolChange: boolean,
) => void;

export type SeatStateManagerDeps = {
  readonly monitorSymbol: string;
  readonly monitorConfig: MonitorConfig;
  readonly autoSearchConfig: AutoSearchConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly switchStates: SwitchStateMap;
  readonly switchSuppressions: SwitchSuppressionMap;
  readonly now: () => Date;
  readonly logger: Logger;
  readonly getHKDateKey: HKDateKeyResolver;
};

export type SeatStateManager = {
  buildSeatState: SeatStateBuilder;
  updateSeatState: SeatStateUpdater;
  resolveSuppression(direction: SeatDirection, seatSymbol: string): SwitchSuppression | null;
  markSuppression(direction: SeatDirection, seatSymbol: string): void;
  ensureSeatOnStartup(params: EnsureSeatOnStartupParams): SeatState;
  clearSeat(params: { direction: SeatDirection; reason: string }): SeatVersion;
  resetDailySwitchSuppression(): void;
};

type FindBestWarrant = (input: FindBestWarrantInput) => Promise<WarrantCandidate | null>;

export type AutoSearchDeps = {
  readonly autoSearchConfig: AutoSearchConfig;
  readonly monitorSymbol: string;
  readonly symbolRegistry: SymbolRegistry;
  readonly buildSeatState: SeatStateBuilder;
  readonly updateSeatState: SeatStateUpdater;
  readonly resolveAutoSearchThresholdInput: ResolveAutoSearchThresholdInput;
  readonly buildFindBestWarrantInput: BuildFindBestWarrantInput;
  readonly findBestWarrant: FindBestWarrant;
  readonly isWithinMorningOpenProtection: MorningOpenProtectionChecker;
  readonly searchCooldownMs: number;
};

export type AutoSearchManager = {
  maybeSearchOnTick(params: SearchOnTickParams): Promise<void>;
};

export type SwitchStateMachineDeps = {
  readonly autoSearchConfig: AutoSearchConfig;
  readonly monitorConfig: MonitorConfig;
  readonly monitorSymbol: string;
  readonly symbolRegistry: SymbolRegistry;
  readonly trader: Trader;
  readonly orderRecorder: OrderRecorder;
  readonly riskChecker: RiskChecker;
  readonly now: () => Date;
  readonly switchStates: SwitchStateMap;
  readonly resolveSuppression: (direction: SeatDirection, seatSymbol: string) => SwitchSuppression | null;
  readonly markSuppression: (direction: SeatDirection, seatSymbol: string) => void;
  readonly clearSeat: (params: { direction: SeatDirection; reason: string }) => SeatVersion;
  readonly buildSeatState: SeatStateBuilder;
  readonly updateSeatState: SeatStateUpdater;
  readonly resolveAutoSearchThresholds: (
    direction: SeatDirection,
    config: AutoSearchConfig,
  ) => {
    readonly minPrice: number | null;
    readonly minTurnoverPerMinute: number | null;
    readonly switchDistanceRange:
      | AutoSearchConfig['switchDistanceRangeBull']
      | AutoSearchConfig['switchDistanceRangeBear'];
  };
  readonly resolveAutoSearchThresholdInput: ResolveAutoSearchThresholdInput;
  readonly buildFindBestWarrantInput: BuildFindBestWarrantInput;
  readonly findBestWarrant: FindBestWarrant;
  readonly resolveDirectionSymbols: (direction: SeatDirection) => {
    readonly isBull: boolean;
    readonly buyAction: 'BUYCALL' | 'BUYPUT';
    readonly sellAction: 'SELLCALL' | 'SELLPUT';
  };
  readonly calculateBuyQuantityByNotional: (
    notional: number,
    price: number,
    lotSize: number,
  ) => number | null;
  readonly buildOrderSignal: OrderSignalBuilder;
  readonly signalObjectPool: SignalObjectPool;
  readonly pendingOrderStatuses: ReadonlySet<PendingOrder['status']>;
  readonly buySide: PendingOrder['side'];
  readonly logger: Logger;
};

export type SwitchStateMachine = {
  maybeSwitchOnDistance(params: SwitchOnDistanceParams): Promise<void>;
  hasPendingSwitch(direction: SeatDirection): boolean;
};
