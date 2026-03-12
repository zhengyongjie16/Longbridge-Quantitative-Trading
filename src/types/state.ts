import type { SignalType, Signal } from './signal.js';
import type { MonitorValues } from './data.js';
import type { IndicatorSnapshot, Quote } from './quote.js';
import type { AccountSnapshot, Position } from './account.js';
import type { MonitorConfig } from './config.js';
import type { SeatState, SymbolRegistry, LifecycleState } from './seat.js';
import type { OrderRecorder, PositionCache, RiskChecker, TradingDayInfo } from './services.js';
import type { DailyLossTracker, UnrealizedLossMonitor } from './risk.js';

/**
 * 策略动作类型。
 * 类型用途：限定策略与指标画像中参与信号判定的动作集合（不含 HOLD）。
 * 数据来源：由 SignalType 收窄得到。
 * 使用范围：IndicatorUsageProfile、strategy 模块等需要按动作索引指标集合的场景。
 */
export type StrategyAction = 'BUYCALL' | 'SELLCALL' | 'BUYPUT' | 'SELLPUT';

/**
 * 指标画像中的指标名称。
 * 类型用途：统一表达运行时可计算的指标键，供展示与延迟验证等链路复用。
 * 数据来源：由 signalConfig / verificationConfig 编译生成。
 * 使用范围：IndicatorUsageProfile、strategy、delayedSignalVerifier、marketMonitor 等模块。
 */
export type ProfileIndicator =
  | 'MFI'
  | 'K'
  | 'D'
  | 'J'
  | 'MACD'
  | 'DIF'
  | 'DEA'
  | 'ADX'
  | `RSI:${number}`
  | `EMA:${number}`
  | `PSY:${number}`;

/**
 * 信号条件支持的指标名称集合。
 * 类型用途：约束 signalConfig 进入策略求值的合法指标键，避免将仅用于延迟验证的指标（如 ADX/MACD/EMA）误用于信号生成。
 * 数据来源：由 signalConfig 编译生成。
 * 使用范围：IndicatorUsageProfile.actionSignalIndicators、strategy 等信号生成链路。
 */
export type SignalIndicator = 'MFI' | 'K' | 'D' | 'J' | `RSI:${number}` | `PSY:${number}`;

/**
 * 延迟验证支持的指标名称集合。
 * 类型用途：约束延迟验证链路可配置的指标键，避免将仅用于信号求值/展示的指标（如 RSI/MFI）误用于延迟验证。
 * 数据来源：由 verificationConfig 编译生成。
 * 使用范围：IndicatorUsageProfile.verificationIndicatorsBySide、DelayedSignalVerifier、signalPipeline 等延迟验证链路。
 */
export type VerificationIndicator =
  | 'K'
  | 'D'
  | 'J'
  | 'MACD'
  | 'DIF'
  | 'DEA'
  | 'ADX'
  | `EMA:${number}`
  | `PSY:${number}`;

/**
 * 指标展示项。
 * 类型用途：定义监控日志输出顺序中的单个展示元素，包含价格/涨跌幅与技术指标项。
 * 数据来源：由 indicatorProfile.displayPlan 编译生成。
 * 使用范围：marketMonitor 展示与变化检测。
 */
export type DisplayIndicatorItem = 'price' | 'changePercent' | ProfileIndicator;

/**
 * 监控标的指标画像。
 * 类型用途：描述单标的在运行期需要计算、校验、延迟验证和展示的指标范围，是全链路唯一输入。
 * 数据来源：monitorContext 编译阶段由 signalConfig + verificationConfig 生成。
 * 使用范围：MonitorContext、indicatorPipeline、strategy、marketMonitor、delayedSignalVerifier。
 */
export type IndicatorUsageProfile = {
  /** 指标族使用开关（族展开后） */
  readonly requiredFamilies: {
    readonly mfi: boolean;
    readonly kdj: boolean;
    readonly macd: boolean;
    readonly adx: boolean;
  };

  /** 周期指标集合（去重排序后） */
  readonly requiredPeriods: {
    readonly rsi: ReadonlyArray<number>;
    readonly ema: ReadonlyArray<number>;
    readonly psy: ReadonlyArray<number>;
  };

  /** 各动作在策略判定时要求存在的指标集合（与配置粒度一致，仅含信号条件支持集） */
  readonly actionSignalIndicators: Readonly<Record<StrategyAction, ReadonlyArray<SignalIndicator>>>;

  /** 延迟验证按买卖方向要求存在的指标集合（与配置粒度一致） */
  readonly verificationIndicatorsBySide: {
    readonly buy: ReadonlyArray<VerificationIndicator>;
    readonly sell: ReadonlyArray<VerificationIndicator>;
  };

  /** 指标展示计划（最终展示顺序） */
  readonly displayPlan: ReadonlyArray<DisplayIndicatorItem>;
};

/**
 * 自动换标管理器行为契约。
 * 类型用途：约束 MonitorContext.autoSymbolManager 的可调用方法，避免 types 层反向依赖业务实现模块。
 * 数据来源：由 autoSymbolManager 模块实现并注入。
 * 使用范围：MonitorContext 与调用方使用。
 */
interface AutoSymbolManager {
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
interface HangSengMultiIndicatorStrategy {
  generateCloseSignals: (
    state: IndicatorSnapshot | null,
    longSymbol: string,
    shortSymbol: string,
    orderRecorder: OrderRecorder,
    indicatorProfile: IndicatorUsageProfile,
  ) => {
    readonly immediateSignals: ReadonlyArray<Signal>;
    readonly delayedSignals: ReadonlyArray<Signal>;
  };
}

/**
 * 延迟信号验证器行为契约。
 * 类型用途：约束 MonitorContext.delayedSignalVerifier 的生命周期与队列操作方法。
 * 数据来源：由 delayedSignalVerifier 模块实现并注入。
 * 使用范围：signalPipeline、mainProgram、cleanup、queue 清理逻辑使用。
 */
interface DelayedSignalVerifier {
  addSignal: (params: {
    readonly signal: Signal;
    readonly monitorSymbol: string;
    readonly verificationIndicators: ReadonlyArray<VerificationIndicator>;
  }) => void;
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

  /** 监控标的指标画像（启动编译，运行期只读） */
  readonly indicatorProfile: IndicatorUsageProfile;

  /** 做多标的行情缓存 */
  longQuote: Quote | null;

  /** 做空标的行情缓存 */
  shortQuote: Quote | null;

  /** 监控标的行情缓存 */
  monitorQuote: Quote | null;
};
