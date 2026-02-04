/**
 * 监控任务处理器类型定义
 *
 * 定义监控任务相关的类型：
 * - MonitorTaskType：任务类型枚举
 * - MonitorTaskData：各类型任务的数据结构
 * - MonitorTaskContext：任务处理所需的监控上下文
 * - MonitorTaskProcessor：处理器接口
 *
 * 席位快照（SeatSnapshot）：
 * - 用于任务创建时记录当前席位状态
 * - 处理时验证席位是否已变更，防止执行过期任务
 */
import type { AutoSymbolManager, SeatDirection } from '../../../services/autoSymbolManager/types.js';
import type { RefreshGate } from '../../../utils/refreshGate/types.js';
import type { MonitorTaskQueue, MonitorTask } from '../monitorTaskQueue/types.js';
import type {
  LastState,
  MarketDataClient,
  Quote,
  RawOrderFromAPI,
  SeatVersion,
  SymbolRegistry,
} from '../../../types/index.js';
import type { DailyLossTracker } from '../../../core/risk/types.js';
import type { OrderRecorder, RiskChecker, Trader } from '../../../types/index.js';
import type { UnrealizedLossMonitor } from '../../../core/unrealizedLossMonitor/types.js';
import type { MultiMonitorTradingConfig } from '../../../types/index.js';

export type SeatSnapshot = Readonly<{
  seatVersion: SeatVersion;
  symbol: string | null;
}>;

export type AutoSymbolTickTaskData = Readonly<{
  monitorSymbol: string;
  direction: SeatDirection;
  seatVersion: SeatVersion;
  symbol: string | null;
  currentTimeMs: number;
  canTradeNow: boolean;
}>;

export type AutoSymbolSwitchDistanceTaskData = Readonly<{
  monitorSymbol: string;
  monitorPrice: number | null;
  quotesMap: ReadonlyMap<string, Quote | null>;
  seatSnapshots: Readonly<{
    long: SeatSnapshot;
    short: SeatSnapshot;
  }>;
}>;

export type SeatRefreshTaskData = Readonly<{
  monitorSymbol: string;
  direction: SeatDirection;
  seatVersion: SeatVersion;
  previousSymbol: string | null;
  nextSymbol: string;
  quote: Quote | null;
  symbolName: string | null;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

export type LiquidationDistanceCheckTaskData = Readonly<{
  monitorSymbol: string;
  monitorPrice: number;
  long: Readonly<{
    seatVersion: SeatVersion;
    symbol: string | null;
    quote: Quote | null;
    symbolName: string | null;
  }>;
  short: Readonly<{
    seatVersion: SeatVersion;
    symbol: string | null;
    quote: Quote | null;
    symbolName: string | null;
  }>;
}>;

export type UnrealizedLossCheckTaskData = Readonly<{
  monitorSymbol: string;
  long: Readonly<{
    seatVersion: SeatVersion;
    symbol: string | null;
    quote: Quote | null;
  }>;
  short: Readonly<{
    seatVersion: SeatVersion;
    symbol: string | null;
    quote: Quote | null;
  }>;
}>;

export type MonitorTaskType =
  | 'AUTO_SYMBOL_TICK'
  | 'AUTO_SYMBOL_SWITCH_DISTANCE'
  | 'SEAT_REFRESH'
  | 'LIQUIDATION_DISTANCE_CHECK'
  | 'UNREALIZED_LOSS_CHECK';

export type MonitorTaskData =
  | AutoSymbolTickTaskData
  | AutoSymbolSwitchDistanceTaskData
  | SeatRefreshTaskData
  | LiquidationDistanceCheckTaskData
  | UnrealizedLossCheckTaskData;

export type MonitorTaskStatus = 'processed' | 'skipped' | 'failed';

export type MonitorTaskContext = Readonly<{
  readonly symbolRegistry: SymbolRegistry;
  readonly autoSymbolManager: AutoSymbolManager;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
  readonly riskChecker: RiskChecker;
  readonly unrealizedLossMonitor: UnrealizedLossMonitor;
  readonly longSymbolName: string;
  readonly shortSymbolName: string;
  readonly monitorSymbolName: string;
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
  readonly monitorQuote: Quote | null;
}>;

export type RefreshHelpers = Readonly<{
  ensureAllOrders: (
    monitorSymbol: string,
    orderRecorder: MonitorTaskContext['orderRecorder'],
  ) => Promise<ReadonlyArray<RawOrderFromAPI>>;
  refreshAccountCaches: () => Promise<void>;
}>;

export type MonitorTaskProcessorDeps = Readonly<{
  readonly monitorTaskQueue: MonitorTaskQueue<MonitorTaskType, MonitorTaskData>;
  readonly refreshGate: RefreshGate;
  readonly getMonitorContext: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly clearQueuesForDirection: (monitorSymbol: string, direction: SeatDirection) => void;
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly lastState: LastState;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly onProcessed?: (task: MonitorTask<MonitorTaskType, MonitorTaskData>, status: MonitorTaskStatus) => void;
}>;

export type MonitorTaskProcessor = Readonly<{
  start: () => void;
  stop: () => void;
}>;
