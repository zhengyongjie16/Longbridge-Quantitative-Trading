import type { MonitorConfig } from '../../types/config.js';
import type { MonitorState } from '../../types/state.js';
import type { Quote } from '../../types/quote.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { OrderRecorder, RiskChecker } from '../../types/services.js';
import type { HangSengMultiIndicatorStrategy } from '../../core/strategy/types.js';
import type { DailyLossTracker, UnrealizedLossMonitor } from '../../core/riskController/types.js';
import type { DelayedSignalVerifier } from '../../main/asyncProgram/delayedSignalVerifier/types.js';
import type { AutoSymbolManager } from '../autoSymbolManager/types.js';

/**
 * 监控上下文工厂的依赖注入参数。
 * 类型用途：供 createMonitorContext 工厂函数消费，用于构造 MonitorContext。
 * 数据来源：由主程序 startup/seat 注入。
 * 使用范围：仅 monitorContext 模块使用。
 */
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
