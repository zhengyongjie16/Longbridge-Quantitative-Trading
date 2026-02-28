import type { SignalType, Signal } from './signal.js';
import type { MonitorValues } from './data.js';
import type { IndicatorSnapshot, Quote } from './quote.js';
import type { AccountSnapshot, Position } from './account.js';
import type { OrderSide } from 'longport';
import type { MonitorConfig } from './config.js';
import type { SeatState, SymbolRegistry, LifecycleState } from './seat.js';
import type {
  OrderRecorder,
  PositionCache,
  RawOrderFromAPI,
  RiskChecker,
  Trader,
  TradingDayInfo,
} from './services.js';

/**
 * 自动换标管理器行为契约。
 * 类型用途：约束 MonitorContext.autoSymbolManager 的可调用方法，避免 types 层反向依赖业务实现模块。
 * 数据来源：由 autoSymbolManager 模块实现并注入。
 * 使用范围：MonitorContext 与调用方使用。
 */
export interface AutoSymbolManager {
  maybeSearchOnTick: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly currentTime: Date;
    readonly canTradeNow: boolean;
  }) => Promise<void>;
  maybeSwitchOnInterval: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly currentTime: Date;
    readonly canTradeNow: boolean;
    readonly openProtectionActive: boolean;
  }) => Promise<void>;
  maybeSwitchOnDistance: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly monitorPrice: number | null;
    readonly quotesMap: ReadonlyMap<string, Quote | null>;
    readonly positions: ReadonlyArray<Position>;
  }) => Promise<void>;
  hasPendingSwitch: (direction: 'LONG' | 'SHORT') => boolean;
  resetAllState: () => void;
}

/**
 * 恒生多指标策略行为契约。
 * 类型用途：约束 MonitorContext.strategy 的信号生成方法。
 * 数据来源：由 strategy 模块实现并注入。
 * 使用范围：processMonitor/signalPipeline 等调用方使用。
 */
export interface HangSengMultiIndicatorStrategy {
  generateCloseSignals: (
    state: IndicatorSnapshot | null,
    longSymbol: string,
    shortSymbol: string,
    orderRecorder: OrderRecorder,
  ) => {
    readonly immediateSignals: ReadonlyArray<Signal>;
    readonly delayedSignals: ReadonlyArray<Signal>;
  };
}

/**
 * 当日亏损跟踪器行为契约。
 * 类型用途：约束 MonitorContext.dailyLossTracker 的核心方法。
 * 数据来源：由 riskController 模块实现并注入。
 * 使用范围：监控任务、成交处理与风险计算链路使用。
 */
export interface DailyLossTracker {
  resetAll: (now: Date) => void;
  recalculateFromAllOrders: (
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
    now: Date,
  ) => void;
  recordFilledOrder: (input: {
    readonly monitorSymbol: string;
    readonly symbol: string;
    readonly isLongSymbol: boolean;
    readonly side: OrderSide;
    readonly executedPrice: number;
    readonly executedQuantity: number;
    readonly executedTimeMs: number;
    readonly orderId?: string | null;
  }) => void;
  getLossOffset: (monitorSymbol: string, isLongSymbol: boolean) => number;
}

/**
 * 浮亏监控器行为契约。
 * 类型用途：约束 MonitorContext.unrealizedLossMonitor 的调用签名。
 * 数据来源：由 riskController 模块实现并注入。
 * 使用范围：monitorTaskProcessor 等调用方使用。
 */
export interface UnrealizedLossMonitor {
  monitorUnrealizedLoss: (context: {
    readonly longQuote: Quote | null;
    readonly shortQuote: Quote | null;
    readonly longSymbol: string;
    readonly shortSymbol: string;
    readonly monitorSymbol: string;
    readonly riskChecker: RiskChecker;
    readonly trader: Trader;
    readonly orderRecorder: OrderRecorder;
    readonly dailyLossTracker: DailyLossTracker;
  }) => Promise<void>;
}

/**
 * 延迟信号验证器行为契约。
 * 类型用途：约束 MonitorContext.delayedSignalVerifier 的生命周期与队列操作方法。
 * 数据来源：由 delayedSignalVerifier 模块实现并注入。
 * 使用范围：signalPipeline、mainProgram、cleanup、queue 清理逻辑使用。
 */
export interface DelayedSignalVerifier {
  addSignal: (signal: Signal, monitorSymbol: string) => void;
  onVerified: (callback: (signal: Signal, monitorSymbol: string) => void) => void;
  cancelAll: () => number;
  cancelAllForSymbol: (monitorSymbol: string) => void;
  cancelAllForDirection: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => number;
  getPendingCount: () => number;
  destroy: () => void;
}

/**
 * 单个监控标的的运行时状态。
 * 类型用途：承载单监控标的的当前价格、信号、待延迟验证信号、指标快照等，在主循环中持续更新，作为 MonitorContext.state、LastState.monitorStates 的值类型。
 * 数据来源：主循环/processMonitor 根据行情与策略输出更新。
 * 使用范围：LastState、MonitorContext、主循环、pipeline 等；全项目可引用。
 */
export type MonitorState = {
  /** 监控标的代码 */
  readonly monitorSymbol: string;
  /**
   * 运行中持续更新的状态字段（性能考虑保持可变）
   * - monitorPrice/longPrice/shortPrice/signal/pendingDelayedSignals/monitorValues/lastMonitorSnapshot/lastCandleFingerprint
   */
  /** 监控标的当前价格 */
  monitorPrice: number | null;
  /** 做多标的当前价格 */
  longPrice: number | null;
  /** 做空标的当前价格 */
  shortPrice: number | null;
  /** 当前信号 */
  signal: SignalType | null;
  /** 待处理的延迟验证信号 */
  pendingDelayedSignals: ReadonlyArray<Signal>;
  /** 监控指标值 */
  monitorValues: MonitorValues | null;
  /** 最新指标快照 */
  lastMonitorSnapshot: IndicatorSnapshot | null;
  /** K 线指纹（length_lastClose），用于 pipeline 层 K 线未变时复用快照 */
  lastCandleFingerprint: string | null;
};

/**
 * 系统全局状态。
 * 类型用途：主循环中的共享状态，聚合可交易标志、半日市、账户/持仓缓存、各监控标的状态等，供 processMonitor、门禁、买卖流程等使用。
 * 数据来源：主循环与各子模块（gate、refresh、策略等）共同维护。
 * 使用范围：主循环、MonitorContext、RiskCheckContext、买卖处理器等；全项目可引用。
 */
export type LastState = {
  /**
   * 运行中持续更新的状态字段（性能考虑保持可变）
   * - canTrade/isHalfDay/openProtectionActive/cachedAccount/cachedPositions/cachedTradingDayInfo/allTradingSymbols
   */
  /** 当前是否可交易 */
  canTrade: boolean | null;
  /** 是否为半日市 */
  isHalfDay: boolean | null;
  /** 开盘保护是否生效中 */
  openProtectionActive: boolean | null;
  /** 当前港股日期键（用于跨日检测） */
  currentDayKey: string | null;
  /** 生命周期状态 */
  lifecycleState: LifecycleState;
  /** 是否待开盘重建 */
  pendingOpenRebuild: boolean;
  /** 目标交易日键（待重建） */
  targetTradingDayKey: string | null;
  /** 生命周期交易门禁（仅 ACTIVE 为 true） */
  isTradingEnabled: boolean;
  /** 账户快照缓存 */
  cachedAccount: AccountSnapshot | null;
  /** 持仓列表缓存 */
  cachedPositions: ReadonlyArray<Position>;
  /** 持仓缓存（O(1) 查找） */
  readonly positionCache: PositionCache;
  /** 交易日信息缓存 */
  cachedTradingDayInfo: TradingDayInfo | null;
  /** 交易日历快照（YYYY-MM-DD -> 是否交易日/半日市） */
  tradingCalendarSnapshot?: ReadonlyMap<string, TradingDayInfo>;
  /** 各监控标的状态（monitorSymbol -> MonitorState） */
  readonly monitorStates: ReadonlyMap<string, MonitorState>;
  /** 订阅标的集合（运行时动态维护） */
  allTradingSymbols: ReadonlySet<string>;
};

/**
 * 监控标的上下文。
 * 类型用途：聚合单监控标的的配置、运行时状态、注册表、策略、风控、行情缓存等，作为单标的处理流程的入参。
 * 数据来源：主程序/startup 根据配置与 LastState 组装；运行中字段由主循环更新。
 * 使用范围：processMonitor、主循环、买卖处理器、策略等；全项目可引用。
 */
export type MonitorContext = {
  /** 监控标的配置 */
  readonly config: MonitorConfig;
  /** 运行时状态 */
  readonly state: MonitorState;
  /** 标的注册表 */
  readonly symbolRegistry: SymbolRegistry;
  /**
   * 运行中会更新的席位缓存（保持可变，避免频繁重建上下文）
   */
  /** 席位状态缓存 */
  seatState: {
    readonly long: SeatState;
    readonly short: SeatState;
  };
  /** 席位版本缓存 */
  seatVersion: {
    readonly long: number;
    readonly short: number;
  };
  /** 自动换标管理器 */
  readonly autoSymbolManager: AutoSymbolManager;
  /** 策略实例 */
  readonly strategy: HangSengMultiIndicatorStrategy;
  /** 订单记录器 */
  readonly orderRecorder: OrderRecorder;
  /** 当日亏损跟踪器 */
  readonly dailyLossTracker: DailyLossTracker;
  /** 风险检查器 */
  readonly riskChecker: RiskChecker;
  /** 浮亏监控器 */
  readonly unrealizedLossMonitor: UnrealizedLossMonitor;
  /** 延迟信号验证器 */
  readonly delayedSignalVerifier: DelayedSignalVerifier;
  /** 做多标的名称缓存 */
  longSymbolName: string;
  /** 做空标的名称缓存 */
  shortSymbolName: string;
  /** 监控标的名称缓存 */
  monitorSymbolName: string;
  /** 已校验的监控标的代码 */
  readonly normalizedMonitorSymbol: string;
  /** RSI 指标周期配置 */
  rsiPeriods: ReadonlyArray<number>;
  /** EMA 指标周期配置 */
  emaPeriods: ReadonlyArray<number>;
  /** PSY 指标周期配置 */
  psyPeriods: ReadonlyArray<number>;
  /** 做多标的行情缓存 */
  longQuote: Quote | null;
  /** 做空标的行情缓存 */
  shortQuote: Quote | null;
  /** 监控标的行情缓存 */
  monitorQuote: Quote | null;
};
