import type { DoomsdayProtection } from '../../core/doomsdayProtection/types.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { MarketDataClient, Trader } from '../../types/services.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { DayLifecycleManager } from '../lifecycle/types.js';
import type { QuoteSubscriptionRuntime } from '../quoteSubscriptionRuntime/types.js';
import type { TimeWakeupPlan } from '../timeWakeupPlanner/types.js';
import type { TradingGateEventRuntime } from '../tradingGateEventRuntime/types.js';

/**
 * 单次时间唤醒评估结果。
 * 类型用途：向 TimeWakeupRuntime 暴露下一次系统级 one-shot 唤醒计划。
 * 数据来源：timeWakeupEvaluationProgram 汇总生命周期、末日保护与交易边界候选后生成。
 * 使用范围：TimeWakeupRuntime 调度下一次时间评估。
 */
export type TimeWakeupEvaluationResult = Readonly<{
  plan: TimeWakeupPlan;
}>;

/**
 * 单次时间唤醒评估上下文。
 * 类型用途：承载 timeWakeupEvaluationProgram 运行所需的全部依赖。
 * 数据来源：app 装配层在启动时组装并注入。
 * 使用范围：仅 timeWakeupEvaluationProgram 及 TimeWakeupRuntime 调用链内部使用。
 */
export type TimeWakeupEvaluationContext = Readonly<{
  marketDataClient: MarketDataClient;
  trader: Trader;
  lastState: LastState;
  doomsdayProtection: DoomsdayProtection;
  tradingConfig: MultiMonitorTradingConfig;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  tradingGateEventRuntime: Pick<TradingGateEventRuntime, 'emitGateStateChanged'>;
  quoteSubscriptionRuntime: Pick<QuoteSubscriptionRuntime, 'reconcilePositionHoldFromCurrentTruth'>;
  dayLifecycleManager: DayLifecycleManager;
  now?: () => Date;
}>;
