/**
 * @module types/state
 * @description 主入口模块类型定义
 *
 * 定义主程序运行时的状态类型
 */
import type { SignalType, Signal } from './signal.js';
import type { MonitorValues } from './data.js';
import type { IndicatorSnapshot, Quote } from './quote.js';
import type { AccountSnapshot, Position } from './account.js';
import type { MonitorConfig } from './config.js';
import type { SeatState, SymbolRegistry, LifecycleState } from './seat.js';
import type { PositionCache, OrderRecorder, RiskChecker, TradingDayInfo } from './services.js';

/**
 * 单个监控标的的运行时状态
 * 在主循环中持续更新
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
 * 系统全局状态
 * 主循环中的共享状态，被多个模块使用
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
  /** 各监控标的状态（monitorSymbol -> MonitorState） */
  readonly monitorStates: ReadonlyMap<string, MonitorState>;
  /** 订阅标的集合（运行时动态维护） */
  allTradingSymbols: ReadonlySet<string>;
};

/**
 * 监控标的上下文
 * 聚合单个监控标的的配置、状态和服务实例
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
  readonly autoSymbolManager: import('../services/autoSymbolManager/types.js').AutoSymbolManager;
  /** 策略实例 */
  readonly strategy: import('../core/strategy/types.js').HangSengMultiIndicatorStrategy;
  /** 订单记录器 */
  readonly orderRecorder: OrderRecorder;
  /** 当日亏损跟踪器 */
  readonly dailyLossTracker: import('../core/riskController/types.js').DailyLossTracker;
  /** 风险检查器 */
  readonly riskChecker: RiskChecker;
  /** 浮亏监控器 */
  readonly unrealizedLossMonitor: import('../core/riskController/types.js').UnrealizedLossMonitor;
  /** 延迟信号验证器 */
  readonly delayedSignalVerifier: import('../main/asyncProgram/delayedSignalVerifier/types.js').DelayedSignalVerifier;
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
