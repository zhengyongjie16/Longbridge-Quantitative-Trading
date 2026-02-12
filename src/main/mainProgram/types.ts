/**
 * @module mainProgram/types
 * @description mainProgram 模块的类型定义
 *
 * 定义主程序运行所需的上下文类型，包含所有外部依赖的引用
 */
import type { IndicatorCache } from '../asyncProgram/indicatorCache/types.js';
import type { TaskQueue, BuyTaskType, SellTaskType } from '../asyncProgram/tradeTaskQueue/types.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskData, MonitorTaskType } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { OrderMonitorWorker } from '../asyncProgram/orderMonitorWorker/types.js';
import type { PostTradeRefresher } from '../asyncProgram/postTradeRefresher/types.js';
import type {
  LastState,
  MonitorContext,
  MarketDataClient,
  Trader,
  MultiMonitorTradingConfig,
  SymbolRegistry,
  GateMode,
} from '../../types/index.js';
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
