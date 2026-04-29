import type { DoomsdayProtection } from '../../core/doomsdayProtection/types.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { MarketDataClient, Trader } from '../../types/services.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { DayLifecycleManager } from '../lifecycle/types.js';
import type { QuoteSubscriptionRuntime } from '../quoteSubscriptionRuntime/types.js';
import type { TradingGateEventRuntime } from '../tradingGateEventRuntime/types.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../asyncProgram/monitorTaskProcessor/types.js';

/**
 * 时间驱动主程序上下文。
 * 类型用途：承载 timeDriverProgram 运行所需的全部依赖。
 * 数据来源：由 app 装配层在 src/app/runApp.ts 中组装并注入。
 * 使用范围：仅在 timeDriverProgram 及其调用链内部使用。
 */
export type TimeDriverProgramContext = Readonly<{
  marketDataClient: MarketDataClient;
  trader: Trader;
  lastState: LastState;
  doomsdayProtection: DoomsdayProtection;
  tradingConfig: MultiMonitorTradingConfig;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
  tradingGateEventRuntime: Pick<TradingGateEventRuntime, 'emitGateStateChanged'>;
  quoteSubscriptionRuntime: Pick<QuoteSubscriptionRuntime, 'reconcilePositionHoldFromCurrentTruth'>;
  dayLifecycleManager: DayLifecycleManager;
}>;
