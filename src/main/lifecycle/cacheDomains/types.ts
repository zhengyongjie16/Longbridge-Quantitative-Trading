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
 * 信号运行时域依赖。
 * 用于 createSignalRuntimeDomain 的依赖注入，仅 lifecycle 模块使用。
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
 * 席位域依赖。
 * 用于 createSeatDomain 的依赖注入，仅 lifecycle 模块使用。
 */
export type SeatDomainDeps = Readonly<{
  tradingConfig: MultiMonitorTradingConfig;
  symbolRegistry: SymbolRegistry;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  warrantListCache: WarrantListCache;
}>;

/**
 * 订单域依赖。
 * 用于 createOrderDomain 的依赖注入，仅 lifecycle 模块使用。
 */
export type OrderDomainDeps = Readonly<{
  trader: Trader;
}>;

/**
 * 风险域依赖。
 * 用于 createRiskDomain 的依赖注入，仅 lifecycle 模块使用。
 */
export type RiskDomainDeps = Readonly<{
  signalProcessor: SignalProcessor;
  dailyLossTracker: DailyLossTracker;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  liquidationCooldownTracker: LiquidationCooldownTracker;
}>;

/**
 * 行情数据域依赖。
 * 用于 createMarketDataDomain 的依赖注入，仅 lifecycle 模块使用。
 */
export type MarketDataDomainDeps = Readonly<{
  marketDataClient: MarketDataClient;
}>;

/**
 * 全局状态域依赖。
 * 用于 createGlobalStateDomain 的依赖注入，仅 lifecycle 模块使用。
 */
export type GlobalStateDomainDeps = Readonly<{
  lastState: LastState;
  runOpenRebuild: (now: Date) => Promise<void>;
}>;
