import type { AutoSearchConfig, MonitorConfig } from '../../types/config.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { Signal } from '../../types/signal.js';
import type { SeatState, SeatStatus, SymbolRegistry } from '../../types/seat.js';
import type {
  MarketDataClient,
  OrderRecorder,
  PendingOrder,
  RiskChecker,
  Trader,
} from '../../types/services.js';
import type { Logger } from '../../utils/logger/types.js';
import type { TradingCalendarSnapshot } from '../../utils/helpers/types.js';
import type { ObjectPool, PoolableSignal } from '../../utils/objectPool/types.js';
import type {
  FindBestWarrantInput,
  WarrantCandidate,
  WarrantListCacheConfig,
} from '../autoSymbolFinder/types.js';

/**
 * 席位注册表内部条目。
 * 类型用途：存储单方向席位状态与版本号，供 SymbolRegistry 读写。
 * 数据来源：由 createSymbolRegistry 内 createSeatEntry 创建并维护。
 * 使用范围：仅 autoSymbolManager 模块内部（SymbolRegistry 实现）使用。
 */
export type SeatEntry = {
  state: SeatState;
  version: number;
};

/**
 * 单个监控标的的席位条目。
 * 类型用途：存储多空两个方向的 SeatEntry，作为 SymbolRegistry Map 的值类型。
 * 数据来源：由 createSymbolRegistry 初始化并维护。
 * 使用范围：仅 autoSymbolManager 模块内部使用。
 */
export type SymbolSeatEntry = {
  long: SeatEntry;
  short: SeatEntry;
};

/**
 * 自动换标管理器的依赖注入参数，包含监控配置、席位注册表与各服务实例。
 * 由 createAutoSymbolManager 工厂函数消费。
 */
export type AutoSymbolManagerDeps = {
  readonly monitorConfig: MonitorConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly orderRecorder: OrderRecorder;
  readonly riskChecker: RiskChecker;
  readonly warrantListCacheConfig?: WarrantListCacheConfig;
  readonly getTradingCalendarSnapshot?: () => TradingCalendarSnapshot;
  readonly now?: () => Date;
};

/**
 * 每 tick 触发自动寻标的入参，包含方向、当前时间与是否可交易标志。
 * 由 autoSearch.maybeSearchOnTick 消费。
 */
export type SearchOnTickParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly currentTime: Date;
  readonly canTradeNow: boolean;
};

/**
 * 距回收价阈值触发换标的入参，包含方向、监控标的价格、行情 Map 与持仓列表。
 * 由 switchStateMachine.maybeSwitchOnDistance 消费。
 */
export type SwitchOnDistanceParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly monitorPrice: number | null;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
  readonly positions: ReadonlyArray<Position>;
};

/**
 * 周期换标触发检查入参，包含方向、当前时间、交易时段与开盘保护状态。
 * 由 switchStateMachine.maybeSwitchOnInterval 消费。
 */
export type SwitchOnIntervalParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly currentTime: Date;
  readonly canTradeNow: boolean;
  readonly openProtectionActive: boolean;
};

/**
 * 换标触发模式。
 * 类型用途：区分距回收价触发与周期触发，供换标状态机决定阶段流。
 * 使用范围：仅 autoSymbolManager 模块内部使用。
 */
export type SwitchMode = 'DISTANCE' | 'PERIODIC';

/**
 * 换标状态机的运行时状态，记录换标流程各阶段的中间数据。
 * 存储于 switchStates Map，由 switchStateMachine 读写。
 */
export type SwitchState = {
  direction: 'LONG' | 'SHORT';
  switchMode: SwitchMode;
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

/**
 * 周期换标等待状态。
 * 类型用途：记录周期到期后等待空仓触发换标的状态。
 * 使用范围：仅 autoSymbolManager 模块内部使用。
 */
export type PeriodicSwitchPendingState = {
  pending: boolean;
  pendingSinceMs: number | null;
};

/**
 * 换标流程阶段枚举，描述状态机从撤单到完成的各个步骤。
 * 仅在 autoSymbolManager 模块内部使用。
 */
type SwitchStage =
  | 'CANCEL_PENDING'
  | 'SELL_OUT'
  | 'BIND_NEW'
  | 'WAIT_QUOTE'
  | 'REBUY'
  | 'COMPLETE'
  | 'FAILED';

/**
 * 日内换标抑制记录，防止同一标的在同一交易日重复触发换标。
 * 存储于 switchSuppressions Map，仅在 autoSymbolManager 模块内部使用。
 */
export type SwitchSuppression = {
  readonly symbol: string;
  readonly dateKey: string;
};

/**
 * 自动换标管理器接口，提供每 tick 寻标、距离阈值换标、挂起状态查询与状态重置方法。
 * 由 createAutoSymbolManager 实现，供主循环消费。
 */
export interface AutoSymbolManager {
  maybeSearchOnTick: (params: SearchOnTickParams) => Promise<void>;
  maybeSwitchOnInterval: (params: SwitchOnIntervalParams) => Promise<void>;
  maybeSwitchOnDistance: (params: SwitchOnDistanceParams) => Promise<void>;
  hasPendingSwitch: (direction: 'LONG' | 'SHORT') => boolean;
  resetAllState: () => void;
}

/**
 * 内部类型：信号对象池，仅暴露 acquire/release 方法。
 * 仅在 autoSymbolManager 模块内部使用。
 */
type SignalObjectPool = Pick<ObjectPool<PoolableSignal>, 'acquire' | 'release'>;

/**
 * 内部类型：换标状态 Map，以方向为键存储当前换标状态。
 * 仅在 autoSymbolManager 模块内部使用。
 */
type SwitchStateMap = Map<'LONG' | 'SHORT', SwitchState>;

/**
 * 内部类型：换标抑制 Map，以方向为键存储日内抑制记录。
 * 仅在 autoSymbolManager 模块内部使用。
 */
type SwitchSuppressionMap = Map<'LONG' | 'SHORT', SwitchSuppression>;

/**
 * 内部类型：周期换标等待状态 Map，以方向为键存储 pending 状态。
 * 仅在 autoSymbolManager 模块内部使用。
 */
type PeriodicSwitchPendingMap = Map<'LONG' | 'SHORT', PeriodicSwitchPendingState>;

/**
 * 内部类型：已交易分钟数解析函数，用于计算分均成交额。
 * 仅在 autoSymbolManager 模块内部使用。
 */
type TradingMinutesResolver = (date: Date | null | undefined) => number;

/**
 * 内部类型：交易时段累计时长计算函数。
 * 仅在 autoSymbolManager 模块内部使用。
 */
type TradingDurationCalculator = (params: {
  readonly startMs: number;
  readonly endMs: number;
  readonly calendarSnapshot: TradingCalendarSnapshot;
}) => number;

/**
 * 内部类型：交易日历快照提供函数。
 * 仅在 autoSymbolManager 模块内部使用。
 */
type TradingCalendarSnapshotProvider = () => TradingCalendarSnapshot;

/**
 * 内部类型：香港日期键解析函数，用于跨日冻结判断。
 * 仅在 autoSymbolManager 模块内部使用。
 */
type HKDateKeyResolver = (date: Date | null | undefined) => string | null;

/**
 * 内部类型：开盘保护检查函数，判断当前时间是否在开盘延迟保护窗口内。
 * 仅在 autoSymbolManager 模块内部使用。
 */
type MorningOpenProtectionChecker = (date: Date | null | undefined, minutes: number) => boolean;

/**
 * 解析自动寻标阈值输入参数的完整依赖，包含配置、标的、日志前缀等。
 * 仅在 autoSymbolManager 模块内部使用。
 */
export type ResolveAutoSearchThresholdInputParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly autoSearchConfig: AutoSearchConfig;
  readonly monitorSymbol: string;
  readonly logPrefix: string;
  readonly logger: Logger;
};

/**
 * 构建 FindBestWarrantInput 的完整依赖参数，包含行情客户端、缓存配置与阈值。
 * 仅在 autoSymbolManager 模块内部使用。
 */
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

/**
 * 解析自动寻标阈值的函数类型。
 * 类型用途：返回 minDistancePct 与 minTurnoverPerMinute，无配置时返回 null。
 * 数据来源：由 createThresholdResolver 实现并注入。
 * 使用范围：供 autoSearch 与 switchStateMachine 消费。
 */
export type ResolveAutoSearchThresholdInput = (
  params: Pick<ResolveAutoSearchThresholdInputParams, 'direction' | 'logPrefix'>,
) => Readonly<{
  minDistancePct: number;
  minTurnoverPerMinute: number;
}> | null;

/**
 * 构建 FindBestWarrantInput 的函数类型。
 * 类型用途：根据方向、时间与阈值等参数构造 FindBestWarrantInput。
 * 数据来源：由 createThresholdResolver 实现并注入。
 * 使用范围：供寻标与换标流程消费。
 */
export type BuildFindBestWarrantInput = (
  params: Pick<
    BuildFindBestWarrantInputParams,
    'direction' | 'currentTime' | 'minDistancePct' | 'minTurnoverPerMinute'
  >,
) => Promise<FindBestWarrantInput>;

/**
 * 阈值解析器的依赖注入参数，包含自动寻标配置、行情客户端与缓存配置。
 * 由 createThresholdResolver 工厂函数消费。
 */
export type ThresholdResolverDeps = {
  readonly autoSearchConfig: AutoSearchConfig;
  readonly monitorSymbol: string;
  readonly marketDataClient: MarketDataClient;
  readonly warrantListCacheConfig?: WarrantListCacheConfig;
  readonly logger: Logger;
  readonly getTradingMinutesSinceOpen: TradingMinutesResolver;
};

/**
 * 构建订单信号的入参，包含动作、标的、行情、原因与席位版本。
 * 由 signalBuilder.buildOrderSignal 消费。
 */
export type BuildOrderSignalParams = {
  readonly action: Signal['action'];
  readonly symbol: string;
  readonly quote: Quote | null;
  readonly reason: string;
  readonly orderTypeOverride: Signal['orderTypeOverride'];
  readonly quantity: number | null;
  readonly seatVersion: number;
};

/**
 * 订单信号构建函数类型。
 * 类型用途：根据 BuildOrderSignalParams 构造订单 Signal。
 * 数据来源：由 createSignalBuilder 实现并注入。
 * 使用范围：供换标状态机消费。
 */
export type OrderSignalBuilder = (params: BuildOrderSignalParams) => Signal;

/**
 * 信号构建器工厂的依赖注入参数。
 * 类型用途：包含信号对象池，供 createSignalBuilder 消费。
 * 使用范围：仅 autoSymbolManager 模块内部使用。
 */
export type SignalBuilderDeps = {
  readonly signalObjectPool: SignalObjectPool;
};

/**
 * 席位不可用原因枚举，描述席位无法用于交易的具体状态。
 * 由 resolveSeatUnavailableReason 返回，仅在 autoSymbolManager 模块内部使用。
 */
export type SeatUnavailableReason =
  | 'SEAT_EMPTY'
  | 'SEAT_FROZEN_TODAY'
  | 'SEAT_SEARCHING'
  | 'SEAT_SWITCHING';

/**
 * 构建席位状态的参数（对象参数模式），包含标的、状态、时间戳与冻结信息。
 * 由 seatStateManager.buildSeatState 消费，仅在 autoSymbolManager 模块内部使用。
 */
export type BuildSeatStateParams = {
  readonly symbol: string | null;
  readonly status: SeatStatus;
  readonly lastSwitchAt: number | null;
  readonly lastSearchAt: number | null;
  readonly lastSeatReadyAt: number | null;
  readonly callPrice?: number | null;
  readonly searchFailCountToday: number;
  readonly frozenTradingDayKey: string | null;
};

/**
 * 席位状态构建函数类型。
 * 类型用途：根据 BuildSeatStateParams 构造 SeatState。
 * 数据来源：由 createSeatStateManager 实现并注入。
 * 使用范围：供寻标与换标流程消费。
 */
export type SeatStateBuilder = (params: BuildSeatStateParams) => SeatState;

/**
 * 席位状态更新函数类型。
 * 类型用途：负责写入注册表并按需递增版本号；bumpOnSymbolChange 为 true 时标的变更会触发版本号递增。
 * 使用范围：由 createSeatStateManager 实现，供寻标与换标流程调用。
 */
export type SeatStateUpdater = (
  direction: 'LONG' | 'SHORT',
  nextState: SeatState,
  bumpOnSymbolChange: boolean,
) => void;

/**
 * 席位状态管理器的依赖注入参数，包含注册表、状态 Map 与日志工具。
 * 由 createSeatStateManager 工厂函数消费。
 */
export type SeatStateManagerDeps = {
  readonly monitorSymbol: string;
  readonly symbolRegistry: SymbolRegistry;
  readonly switchStates: SwitchStateMap;
  readonly switchSuppressions: SwitchSuppressionMap;
  readonly now: () => Date;
  readonly logger: Logger;
  readonly getHKDateKey: HKDateKeyResolver;
};

/**
 * 席位状态管理器接口，提供席位构建、更新、抑制与清空操作。
 * 由 createSeatStateManager 实现，供 autoSearch 与 switchStateMachine 消费。
 */
export interface SeatStateManager {
  buildSeatState: SeatStateBuilder;
  updateSeatState: SeatStateUpdater;
  resolveSuppression: (direction: 'LONG' | 'SHORT', seatSymbol: string) => SwitchSuppression | null;
  markSuppression: (direction: 'LONG' | 'SHORT', seatSymbol: string) => void;
  clearSeat: (params: { direction: 'LONG' | 'SHORT'; reason: string }) => number;
}

/**
 * 内部类型：寻标函数，调用 autoSymbolFinder 返回最佳候选标的。
 * 仅在 autoSymbolManager 模块内部使用。
 */
type FindBestWarrant = (input: FindBestWarrantInput) => Promise<WarrantCandidate | null>;

/**
 * 自动寻标子模块的依赖注入参数，包含席位管理、阈值解析与寻标函数。
 * 由 createAutoSearch 工厂函数消费。
 */
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

/**
 * 自动寻标子模块接口，提供每 tick 触发寻标的方法。
 * 由 createAutoSearch 实现，供 autoSymbolManager 消费。
 */
export interface AutoSearchManager {
  maybeSearchOnTick: (params: SearchOnTickParams) => Promise<void>;
}

/**
 * 换标状态机的依赖注入参数，包含交易器、风控、席位管理与信号构建等完整依赖。
 * 由 createSwitchStateMachine 工厂函数消费。
 */
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
  readonly periodicSwitchPending: PeriodicSwitchPendingMap;
  readonly resolveSuppression: (
    direction: 'LONG' | 'SHORT',
    seatSymbol: string,
  ) => SwitchSuppression | null;
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
    readonly switchDistanceRange: AutoSearchConfig['switchDistanceRangeBull'];
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
  readonly calculateTradingDurationMsBetween: TradingDurationCalculator;
  readonly getTradingCalendarSnapshot: TradingCalendarSnapshotProvider;
};

/**
 * 换标状态机接口，提供距离阈值触发换标与挂起状态查询方法。
 * 由 createSwitchStateMachine 实现，供 autoSymbolManager 消费。
 */
export interface SwitchStateMachine {
  maybeSwitchOnInterval: (params: SwitchOnIntervalParams) => Promise<void>;
  maybeSwitchOnDistance: (params: SwitchOnDistanceParams) => Promise<void>;
  hasPendingSwitch: (direction: 'LONG' | 'SHORT') => boolean;
}
