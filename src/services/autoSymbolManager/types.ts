/**
 * 自动换标管理器类型定义
 *
 * 包含席位管理与换标流程相关的类型：
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
import type { AutoSearchConfig, MonitorConfig } from '../../types/config.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { Signal } from '../../types/signal.js';
import type { SeatState, SeatStatus, SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient, OrderRecorder, PendingOrder, RiskChecker, Trader } from '../../types/services.js';
import type { Logger } from '../../utils/logger/types.js';
import type { ObjectPool, PoolableSignal } from '../../utils/objectPool/types.js';
import type {
  FindBestWarrantInput,
  WarrantCandidate,
  WarrantListCacheConfig,
} from '../autoSymbolFinder/types.js';

/**
 * 席位注册表内部条目（可变状态，SymbolRegistry 内部使用）
 * 注意：状态与版本号需要在运行中更新，因此不使用 readonly。
 */
export type SeatEntry = {
  state: SeatState;
  version: number;
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

export type SearchOnTickParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly currentTime: Date;
  readonly canTradeNow: boolean;
};

export type SwitchOnDistanceParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly monitorPrice: number | null;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
  readonly positions: ReadonlyArray<Position>;
};

export type SwitchState = {
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  stage: SwitchStage;
  oldSymbol: string;
  nextSymbol: string | null;
  nextCallPrice: number | null;
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

export interface AutoSymbolManager {
  maybeSearchOnTick(params: SearchOnTickParams): Promise<void>;
  maybeSwitchOnDistance(params: SwitchOnDistanceParams): Promise<void>;
  hasPendingSwitch(direction: 'LONG' | 'SHORT'): boolean;
  resetAllState(): void;
}

type SignalObjectPool = Pick<ObjectPool<PoolableSignal>, 'acquire' | 'release'>;

type SwitchStateMap = Map<'LONG' | 'SHORT', SwitchState>;

type SwitchSuppressionMap = Map<'LONG' | 'SHORT', SwitchSuppression>;

type TradingMinutesResolver = (date: Date | null | undefined) => number;

type HKDateKeyResolver = (date: Date | null | undefined) => string | null;

type MorningOpenProtectionChecker = (
  date: Date | null | undefined,
  minutes: number,
) => boolean;

export type ResolveAutoSearchThresholdInputParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly autoSearchConfig: AutoSearchConfig;
  readonly monitorSymbol: string;
  readonly logPrefix: string;
  readonly logger: Logger;
};

export type BuildFindBestWarrantInputParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly monitorSymbol: string;
  readonly autoSearchConfig: AutoSearchConfig;
  readonly currentTime: Date;
  readonly marketDataClient: MarketDataClient;
  readonly warrantListCacheConfig?: WarrantListCacheConfig;
  readonly minDistancePct: number;
  readonly minTurnoverPerMinute: number;
  readonly getTradingMinutesSinceOpen: TradingMinutesResolver;
  readonly logger: Logger;
};

export type ResolveAutoSearchThresholdInput = (
  params: Pick<ResolveAutoSearchThresholdInputParams, 'direction' | 'logPrefix'>,
) => Readonly<{
  minDistancePct: number;
  minTurnoverPerMinute: number;
}> | null;

export type BuildFindBestWarrantInput = (
  params: Pick<
    BuildFindBestWarrantInputParams,
    'direction' | 'currentTime' | 'minDistancePct' | 'minTurnoverPerMinute'
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
  readonly seatVersion: number;
};

export type OrderSignalBuilder = (params: BuildOrderSignalParams) => Signal;

export type SignalBuilderDeps = {
  readonly signalObjectPool: SignalObjectPool;
};

/**
 * 席位不可用原因
 */
export type SeatUnavailableReason =
  | 'SEAT_EMPTY'
  | 'SEAT_FROZEN_TODAY'
  | 'SEAT_SEARCHING'
  | 'SEAT_SWITCHING';

/**
 * 构建席位状态的参数（对象参数模式）
 */
export type BuildSeatStateParams = {
  readonly symbol: string | null;
  readonly status: SeatStatus;
  readonly lastSwitchAt: number | null;
  readonly lastSearchAt: number | null;
  readonly callPrice?: number | null;
  readonly searchFailCountToday: number;
  readonly frozenTradingDayKey: string | null;
};

export type SeatStateBuilder = (params: BuildSeatStateParams) => SeatState;

export type SeatStateUpdater = (
  direction: 'LONG' | 'SHORT',
  nextState: SeatState,
  bumpOnSymbolChange: boolean,
) => void;

export type SeatStateManagerDeps = {
  readonly monitorSymbol: string;
  readonly symbolRegistry: SymbolRegistry;
  readonly switchStates: SwitchStateMap;
  readonly switchSuppressions: SwitchSuppressionMap;
  readonly now: () => Date;
  readonly logger: Logger;
  readonly getHKDateKey: HKDateKeyResolver;
};

export interface SeatStateManager {
  buildSeatState: SeatStateBuilder;
  updateSeatState: SeatStateUpdater;
  resolveSuppression(direction: 'LONG' | 'SHORT', seatSymbol: string): SwitchSuppression | null;
  markSuppression(direction: 'LONG' | 'SHORT', seatSymbol: string): void;
  clearSeat(params: { direction: 'LONG' | 'SHORT'; reason: string }): number;
}

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
  readonly getHKDateKey: HKDateKeyResolver;
  readonly maxSearchFailuresPerDay: number;
  readonly logger: Logger;
};

export interface AutoSearchManager {
  maybeSearchOnTick(params: SearchOnTickParams): Promise<void>;
}

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
  readonly resolveSuppression: (direction: 'LONG' | 'SHORT', seatSymbol: string) => SwitchSuppression | null;
  readonly markSuppression: (direction: 'LONG' | 'SHORT', seatSymbol: string) => void;
  readonly clearSeat: (params: { direction: 'LONG' | 'SHORT'; reason: string }) => number;
  readonly buildSeatState: SeatStateBuilder;
  readonly updateSeatState: SeatStateUpdater;
  readonly resolveAutoSearchThresholds: (
    direction: 'LONG' | 'SHORT',
    config: AutoSearchConfig,
  ) => {
    readonly minDistancePct: number | null;
    readonly minTurnoverPerMinute: number | null;
    readonly switchDistanceRange:
      | AutoSearchConfig['switchDistanceRangeBull']
      | AutoSearchConfig['switchDistanceRangeBear'];
  };
  readonly resolveAutoSearchThresholdInput: ResolveAutoSearchThresholdInput;
  readonly buildFindBestWarrantInput: BuildFindBestWarrantInput;
  readonly findBestWarrant: FindBestWarrant;
  readonly resolveDirectionSymbols: (direction: 'LONG' | 'SHORT') => {
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
  readonly maxSearchFailuresPerDay: number;
  readonly getHKDateKey: HKDateKeyResolver;
};

export interface SwitchStateMachine {
  maybeSwitchOnDistance(params: SwitchOnDistanceParams): Promise<void>;
  hasPendingSwitch(direction: 'LONG' | 'SHORT'): boolean;
}
