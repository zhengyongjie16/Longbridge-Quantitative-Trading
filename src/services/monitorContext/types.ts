/**
 * 监控上下文工厂类型定义
 *
 * MonitorContext 是每个监控标的的运行时上下文，
 * 包含该标的的配置、状态、策略和各种服务引用。
 *
 * 依赖项说明：
 * - config：监控配置（标的代码、信号配置等）
 * - state：监控状态（最后信号、最后价格等）
 * - strategy：技术指标策略实例
 * - orderRecorder：订单记录器（持仓追踪）
 * - riskChecker：风险检查器
 * - unrealizedLossMonitor：浮亏监控器
 */
import type {
  MonitorConfig,
  MonitorContext,
  MonitorState,
  OrderRecorder,
  Quote,
  RiskChecker,
  SymbolRegistry,
} from '../../types/index.js';
import type { HangSengMultiIndicatorStrategy } from '../../core/strategy/types.js';
import type { UnrealizedLossMonitor } from '../../core/unrealizedLossMonitor/types.js';
import type { DelayedSignalVerifier } from '../../main/asyncProgram/delayedSignalVerifier/types.js';
import type { AutoSymbolManager } from '../autoSymbolManager/types.js';
import type { DailyLossTracker } from '../../core/risk/types.js';

export type MonitorContextFactoryDeps = {
  readonly config: MonitorConfig;
  readonly state: MonitorState;
  readonly symbolRegistry: SymbolRegistry;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
  readonly strategy: HangSengMultiIndicatorStrategy;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
  readonly riskChecker: RiskChecker;
  readonly unrealizedLossMonitor: UnrealizedLossMonitor;
  readonly delayedSignalVerifier: DelayedSignalVerifier;
  readonly autoSymbolManager: AutoSymbolManager;
};

export type MonitorContextFactory = (deps: MonitorContextFactoryDeps) => MonitorContext;
