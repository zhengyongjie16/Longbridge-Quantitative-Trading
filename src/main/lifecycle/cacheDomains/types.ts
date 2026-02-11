import type { LastState, MarketDataClient, MonitorContext, MultiMonitorTradingConfig, Signal, SymbolRegistry, Trader } from '../../../types/index.js';
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

export type SignalRuntimeDomainDeps = Readonly<{
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly buyProcessor: Processor;
  readonly sellProcessor: Processor;
  readonly monitorTaskProcessor: MonitorTaskProcessor;
  readonly orderMonitorWorker: OrderMonitorWorker;
  readonly postTradeRefresher: PostTradeRefresher;
  readonly indicatorCache: IndicatorCache;
  readonly buyTaskQueue: TaskQueue<BuyTaskType>;
  readonly sellTaskQueue: TaskQueue<SellTaskType>;
  readonly monitorTaskQueue: MonitorTaskQueue<MonitorTaskType, MonitorTaskData>;
  readonly refreshGate: RefreshGate;
  readonly releaseSignal: (signal: Signal) => void;
}>;

export type SeatDomainDeps = Readonly<{
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly warrantListCache: WarrantListCache;
}>;

export type OrderDomainDeps = Readonly<{
  readonly trader: Trader;
}>;

export type RiskDomainDeps = Readonly<{
  readonly signalProcessor: SignalProcessor;
  readonly dailyLossTracker: DailyLossTracker;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
}>;

export type MarketDataDomainDeps = Readonly<{
  readonly marketDataClient: MarketDataClient;
}>;

export type GlobalStateDomainDeps = Readonly<{
  readonly lastState: LastState;
  readonly runOpenRebuild: (now: Date) => Promise<void>;
}>;
