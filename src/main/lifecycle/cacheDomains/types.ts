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
