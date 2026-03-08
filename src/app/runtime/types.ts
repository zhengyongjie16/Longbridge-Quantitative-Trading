import type { Period } from 'longport';
import type { AccountSnapshot, Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { GateMode, LifecycleState, SeatState } from '../../types/seat.js';
import type { IndicatorUsageProfile, MonitorState } from '../../types/state.js';
import type { PositionCache, TradingDayInfo } from '../../types/services.js';

/**
 * 门禁策略快照。
 * 类型用途：保存单次 tick 的结构化门禁解析结果，为后续 GatePolicyResolver 收口提供单一数据结构。
 * 数据来源：主循环运行时门禁解析。
 * 使用范围：SystemRuntimeStateStore 内部与后续 gate 重构阶段。
 */
export type GatePolicySnapshot = {
  readonly runtimeGateMode: GateMode;
  readonly dayKey: string | null;
  readonly isTradingDay: boolean;
  readonly isHalfDay: boolean;
  readonly canTradeNow: boolean;
  readonly openProtectionActive: boolean;
  readonly executionGateOpen: boolean;
  readonly continuousSessionGateOpen: boolean;
  readonly signalGenerationGateOpen: boolean;
  readonly lifecycleState: LifecycleState;
};

/**
 * 系统运行态。
 * 类型用途：承载跨监控标的共享的 execution/lifecycle/account/position runtime。
 * 数据来源：startup、lifecycle、main loop 与 post-trade refresh。
 * 使用范围：SystemRuntimeStateStore 唯一真相源。
 */
export type SystemRuntimeState = {
  canTrade: boolean | null;
  isHalfDay: boolean | null;
  openProtectionActive: boolean | null;
  currentDayKey: string | null;
  lifecycleState: LifecycleState;
  pendingOpenRebuild: boolean;
  targetTradingDayKey: string | null;
  isTradingEnabled: boolean;
  cachedAccount: AccountSnapshot | null;
  cachedPositions: ReadonlyArray<Position>;
  readonly positionCache: PositionCache;
  gatePolicySnapshot: GatePolicySnapshot | null;
};

/**
 * 交易日读模型状态。
 * 类型用途：承载交易日信息缓存与交易日历快照。
 * 数据来源：startup gate、lifecycle rebuild、trading calendar prewarm。
 * 使用范围：TradingDayReadModelStore 唯一真相源。
 */
export type TradingDayReadModelState = {
  cachedTradingDayInfo: TradingDayInfo | null;
  tradingCalendarSnapshot: ReadonlyMap<string, TradingDayInfo>;
};

/**
 * 单方向席位运行态条目。
 * 类型用途：承载单个方向的席位状态与版本号，作为 SeatRuntimeStore 的底层存储单元。
 * 数据来源：由启动初始化创建，后续由 startup/lifecycle/auto-symbol/seat-refresh 写入。
 * 使用范围：SeatRuntimeStore 唯一真相源。
 */
export type SeatRuntimeDirectionEntry = {
  state: SeatState;
  version: number;
};

/**
 * 单 monitor 的席位运行态条目。
 * 类型用途：聚合 LONG/SHORT 两个方向的席位状态与版本号。
 * 数据来源：由 SeatRuntimeStore 初始化与运行时更新。
 * 使用范围：SeatRuntimeStore 唯一真相源。
 */
export type SeatRuntimeEntry = {
  readonly long: SeatRuntimeDirectionEntry;
  readonly short: SeatRuntimeDirectionEntry;
};

/**
 * 席位运行态。
 * 类型用途：集中持有所有 monitor 的席位状态、版本与按 symbol 解析能力所需的数据。
 * 数据来源：启动阶段按配置初始化，后续由 seat 相关用例更新。
 * 使用范围：SeatRuntimeStore 唯一真相源。
 */
export type SeatRuntimeState = {
  readonly entries: Map<string, SeatRuntimeEntry>;
};

/**
 * 单 monitor 运行态条目。
 * 类型用途：承载原 MonitorContext 中持续可变的席位、名称与行情缓存字段。
 * 数据来源：monitorContext 初始化、seat sync 与主循环行情同步。
 * 使用范围：MonitorRuntimeStore 与 legacy MonitorContext facade。
 */
export type MonitorRuntimeEntry = {
  readonly monitorSymbol: string;
  readonly state: MonitorState;
  seatState: {
    readonly long: SeatState;
    readonly short: SeatState;
  };
  seatVersion: {
    readonly long: number;
    readonly short: number;
  };
  longSymbolName: string;
  shortSymbolName: string;
  monitorSymbolName: string;
  readonly normalizedMonitorSymbol: string;
  readonly indicatorProfile: IndicatorUsageProfile;
  longQuote: Quote | null;
  shortQuote: Quote | null;
  monitorQuote: Quote | null;
};

/**
 * 监控运行态。
 * 类型用途：统一持有 monitorStates 与 monitor runtime entries。
 * 数据来源：启动初始化与 monitorContext 注册。
 * 使用范围：MonitorRuntimeStore 唯一真相源。
 */
export type MonitorRuntimeState = {
  readonly monitorStates: Map<string, MonitorState>;
  readonly entries: Map<string, MonitorRuntimeEntry>;
};

/**
 * 行情运行态。
 * 类型用途：统一维护主循环目标标的集合、quote 订阅集合与 candlestick 订阅集合。
 * 数据来源：mainProgram 订阅规划与 quoteClient 真实订阅执行。
 * 使用范围：MarketDataRuntimeStore 唯一真相源。
 */
export type MarketDataRuntimeState = {
  readonly activeTradingSymbols: Set<string>;
  readonly subscribedQuoteSymbols: Set<string>;
  readonly subscribedCandlesticks: Map<string, Period>;
};

/**
 * 系统运行态 store 契约。
 * 类型用途：限制全局系统运行态的读写入口。
 * 数据来源：由 createSystemRuntimeStateStore 创建。
 * 使用范围：启动装配层与 legacy LastState facade。
 */
export interface SystemRuntimeStateStore {
  getState: () => SystemRuntimeState;
  setCanTrade: (canTrade: boolean | null) => void;
  setIsHalfDay: (isHalfDay: boolean | null) => void;
  setOpenProtectionActive: (openProtectionActive: boolean | null) => void;
  setCurrentDayKey: (currentDayKey: string | null) => void;
  setLifecycleState: (lifecycleState: LifecycleState) => void;
  setPendingOpenRebuild: (pendingOpenRebuild: boolean) => void;
  setTargetTradingDayKey: (targetTradingDayKey: string | null) => void;
  setIsTradingEnabled: (isTradingEnabled: boolean) => void;
  setCachedAccount: (cachedAccount: AccountSnapshot | null) => void;
  setCachedPositions: (cachedPositions: ReadonlyArray<Position>) => void;
  setGatePolicySnapshot: (gatePolicySnapshot: GatePolicySnapshot | null) => void;
}

/**
 * 交易日读模型 store 契约。
 * 类型用途：限制 cachedTradingDayInfo 与 tradingCalendarSnapshot 的读写入口。
 * 数据来源：由 createTradingDayReadModelStore 创建。
 * 使用范围：startup、lifecycle 与 legacy LastState facade。
 */
export interface TradingDayReadModelStore {
  getState: () => TradingDayReadModelState;
  setCachedTradingDayInfo: (cachedTradingDayInfo: TradingDayInfo | null) => void;
  setTradingCalendarSnapshot: (
    tradingCalendarSnapshot: ReadonlyMap<string, TradingDayInfo>,
  ) => void;
}

/**
 * 席位运行态 store 契约。
 * 类型用途：限制席位状态与版本号的唯一读写入口。
 * 数据来源：由 createSeatRuntimeStore 创建。
 * 使用范围：启动、lifecycle、auto symbol 与 legacy SymbolRegistry facade。
 */
export interface SeatRuntimeStore {
  getState: () => SeatRuntimeState;
  getSeatState: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => SeatState;
  getSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => number;
  resolveSeatBySymbol: (symbol: string) => {
    monitorSymbol: string;
    direction: 'LONG' | 'SHORT';
    seatState: SeatState;
    seatVersion: number;
  } | null;
  setSeatState: (
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    nextState: SeatState,
  ) => SeatState;
  bumpSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => number;
}

/**
 * 监控运行态 store 契约。
 * 类型用途：限制 monitor runtime entry 的注册与读取入口。
 * 数据来源：由 createMonitorRuntimeStore 创建。
 * 使用范围：启动装配层、monitorContext 工厂与 legacy LastState facade。
 */
export interface MonitorRuntimeStore {
  getState: () => MonitorRuntimeState;
  ensureEntry: (entry: MonitorRuntimeEntry) => MonitorRuntimeEntry;
  getEntry: (monitorSymbol: string) => MonitorRuntimeEntry | null;
}

/**
 * 行情运行态 store 契约。
 * 类型用途：统一维护 active symbols 与真实订阅集合。
 * 数据来源：由 createMarketDataRuntimeStore 创建。
 * 使用范围：mainProgram、quoteClient 与 legacy LastState facade。
 */
export interface MarketDataRuntimeStore {
  getState: () => MarketDataRuntimeState;
  replaceActiveTradingSymbols: (symbols: ReadonlySet<string>) => void;
  hasSubscribedQuoteSymbol: (symbol: string) => boolean;
  addSubscribedQuoteSymbols: (symbols: ReadonlyArray<string>) => void;
  removeSubscribedQuoteSymbols: (symbols: ReadonlyArray<string>) => void;
  hasSubscribedCandlestick: (key: string) => boolean;
  setSubscribedCandlestick: (key: string, period: Period) => void;
  deleteSubscribedCandlestick: (key: string) => void;
}
