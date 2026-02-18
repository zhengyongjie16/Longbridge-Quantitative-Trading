import type { LastState, MonitorContext } from '../../../types/state.js';
import type { Signal } from '../../../types/signal.js';
import type { MultiMonitorTradingConfig } from '../../../types/config.js';
import type { SymbolRegistry } from '../../../types/seat.js';
import type { MarketDataClient, Trader } from '../../../types/services.js';
import type { Processor } from '../../asyncProgram/types.js';
import type { TaskQueue, BuyTaskType, SellTaskType } from '../../asyncProgram/tradeTaskQueue/types.js';
import type { MonitorTaskData, MonitorTaskProcessor, MonitorTaskType } from '../../asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTaskQueue } from '../../asyncProgram/monitorTaskQueue/types.js';
import type { OrderMonitorWorker } from '../../asyncProgram/orderMonitorWorker/types.js';
import type { PostTradeRefresher } from '../../asyncProgram/postTradeRefresher/types.js';
import type { RefreshGate } from '../../../utils/refreshGate/types.js';
import type { IndicatorCache } from '../../asyncProgram/indicatorCache/types.js';
import type { WarrantListCache } from '../../../services/autoSymbolFinder/types.js';
import type { SignalProcessor } from '../../../core/signalProcessor/types.js';
import type { DailyLossTracker } from '../../../core/riskController/types.js';
import type { LiquidationCooldownTracker } from '../../../services/liquidationCooldown/types.js';

/**
 * createSignalRuntimeDomain 的依赖注入参数。
 * 包含所有异步处理器、任务队列、指标缓存及信号释放回调。
 */
export type SignalRuntimeDomainDeps = Readonly<{
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  buyProcessor: Processor;
  sellProcessor: Processor;
  monitorTaskProcessor: MonitorTaskProcessor;
  orderMonitorWorker: OrderMonitorWorker;
  postTradeRefresher: PostTradeRefresher;
  indicatorCache: IndicatorCache;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskType, MonitorTaskData>;
  refreshGate: RefreshGate;
  releaseSignal: (signal: Signal) => void;
}>;

/**
 * createSeatDomain 的依赖注入参数。
 * 包含交易配置、标的注册表、监控上下文及轮证列表缓存。
 */
export type SeatDomainDeps = Readonly<{
  tradingConfig: MultiMonitorTradingConfig;
  symbolRegistry: SymbolRegistry;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  warrantListCache: WarrantListCache;
}>;

/**
 * createOrderDomain 的依赖注入参数。
 * 仅包含交易执行器。
 */
export type OrderDomainDeps = Readonly<{
  trader: Trader;
}>;

/**
 * createRiskDomain 的依赖注入参数。
 * 包含信号处理器、日内亏损追踪、监控上下文及清仓冷却追踪器。
 */
export type RiskDomainDeps = Readonly<{
  signalProcessor: SignalProcessor;
  dailyLossTracker: DailyLossTracker;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  liquidationCooldownTracker: LiquidationCooldownTracker;
}>;

/**
 * createMarketDataDomain 的依赖注入参数。
 * 仅包含行情客户端。
 */
export type MarketDataDomainDeps = Readonly<{
  marketDataClient: MarketDataClient;
}>;

/**
 * createGlobalStateDomain 的依赖注入参数。
 * 包含全局状态对象和开盘重建回调。
 */
export type GlobalStateDomainDeps = Readonly<{
  lastState: LastState;
  runOpenRebuild: (now: Date) => Promise<void>;
}>;
