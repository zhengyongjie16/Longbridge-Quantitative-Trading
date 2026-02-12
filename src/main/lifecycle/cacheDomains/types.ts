/**
 * 缓存域模块类型定义
 *
 * 定义各 CacheDomain 的依赖注入类型：
 * - SignalRuntimeDomainDeps：信号运行时域（处理器、队列、指标缓存等）
 * - SeatDomainDeps：席位域（交易配置、标的注册表、轮证列表缓存）
 * - OrderDomainDeps：订单域（交易执行器）
 * - RiskDomainDeps：风控域（信号处理器、日内亏损追踪、清仓冷却追踪）
 * - MarketDataDomainDeps：行情域（行情客户端）
 * - GlobalStateDomainDeps：全局状态域（全局状态、开盘重建回调）
 */
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

export type SeatDomainDeps = Readonly<{
  tradingConfig: MultiMonitorTradingConfig;
  symbolRegistry: SymbolRegistry;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  warrantListCache: WarrantListCache;
}>;

export type OrderDomainDeps = Readonly<{
  trader: Trader;
}>;

export type RiskDomainDeps = Readonly<{
  signalProcessor: SignalProcessor;
  dailyLossTracker: DailyLossTracker;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  liquidationCooldownTracker: LiquidationCooldownTracker;
}>;

export type MarketDataDomainDeps = Readonly<{
  marketDataClient: MarketDataClient;
}>;

export type GlobalStateDomainDeps = Readonly<{
  lastState: LastState;
  runOpenRebuild: (now: Date) => Promise<void>;
}>;
