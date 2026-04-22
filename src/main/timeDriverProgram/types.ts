import type { DoomsdayProtection } from '../../core/doomsdayProtection/types.js';
import type { GateMode } from '../../types/seat.js';
import type { Trader } from '../../types/services.js';
import type { MonitorContext } from '../../types/state.js';
import type { DayLifecycleManager } from '../lifecycle/types.js';
import type { QuoteSubscriptionRuntime } from '../quoteSubscriptionRuntime/types.js';
import type { TradingGateEventRuntime } from '../tradingGateEventRuntime/types.js';
import type { MonitorRuntimeContext } from '../processMonitor/types.js';

/**
 * 时间驱动主程序上下文。
 * 类型用途：承载 timeDriverProgram 运行所需的全部依赖。
 * 数据来源：由 app 装配层在 src/app/runApp.ts 中组装并注入。
 * 使用范围：仅在 timeDriverProgram 及其调用链内部使用。
 */
export type TimeDriverProgramContext = MonitorRuntimeContext &
  Readonly<{
    trader: Trader;
    doomsdayProtection: DoomsdayProtection;
    monitorContexts: ReadonlyMap<string, MonitorContext>;
    runtimeGateMode: GateMode;
    tradingGateEventRuntime: Pick<TradingGateEventRuntime, 'emitGateStateChanged'>;
    quoteSubscriptionRuntime: Pick<
      QuoteSubscriptionRuntime,
      'reconcilePositionHoldFromCurrentTruth'
    >;
    dayLifecycleManager: DayLifecycleManager;
  }>;
