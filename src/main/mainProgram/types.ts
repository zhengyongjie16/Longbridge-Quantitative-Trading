import type { IndicatorCache } from '../asyncProgram/indicatorCache/types.js';
import type { TaskQueue, BuyTaskType, SellTaskType } from '../asyncProgram/tradeTaskQueue/types.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskData, MonitorTaskType } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { OrderMonitorWorker } from '../asyncProgram/orderMonitorWorker/types.js';
import type { PostTradeRefresher } from '../asyncProgram/postTradeRefresher/types.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { SymbolRegistry, GateMode } from '../../types/seat.js';
import type { MarketDataClient, Trader } from '../../types/services.js';
import type { MarketMonitor } from '../../services/marketMonitor/types.js';
import type { DoomsdayProtection } from '../../core/doomsdayProtection/types.js';
import type { SignalProcessor } from '../../core/signalProcessor/types.js';
import type { DailyLossTracker } from '../../core/riskController/types.js';
import type { DayLifecycleManager } from '../lifecycle/types.js';

/**
 * 主程序上下文
 *
 * 包含 mainProgram 运行所需的所有依赖：
 * - 数据服务：marketDataClient（行情）、trader（交易）
 * - 状态管理：lastState（全局状态）、monitorContexts（监控上下文）
 * - 业务模块：marketMonitor、doomsdayProtection、signalProcessor
 * - 异步架构：indicatorCache、buyTaskQueue、sellTaskQueue
 *
 * 数据来源：由 src/index.ts main() 函数初始化并注入
 * 使用范围：仅在 mainProgram 及其调用链内部使用
 */
export type MainProgramContext = {
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly lastState: LastState;
  readonly marketMonitor: MarketMonitor;
  readonly doomsdayProtection: DoomsdayProtection;
  readonly signalProcessor: SignalProcessor;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly dailyLossTracker: DailyLossTracker;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly symbolRegistry: SymbolRegistry;
  readonly indicatorCache: IndicatorCache;
  readonly buyTaskQueue: TaskQueue<BuyTaskType>;
  readonly sellTaskQueue: TaskQueue<SellTaskType>;
  readonly monitorTaskQueue: MonitorTaskQueue<MonitorTaskType, MonitorTaskData>;
  readonly orderMonitorWorker: OrderMonitorWorker;
  readonly postTradeRefresher: PostTradeRefresher;
  readonly runtimeGateMode: GateMode;
  readonly dayLifecycleManager: DayLifecycleManager;
};
