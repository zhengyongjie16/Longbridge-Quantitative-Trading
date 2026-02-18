import type { AutoSymbolManager } from '../../../services/autoSymbolManager/types.js';
import type { RefreshGate } from '../../../utils/refreshGate/types.js';
import type { MonitorTaskQueue, MonitorTask } from '../monitorTaskQueue/types.js';
import type { LastState } from '../../../types/state.js';
import type { Quote } from '../../../types/quote.js';
import type { MultiMonitorTradingConfig } from '../../../types/config.js';
import type { SymbolRegistry } from '../../../types/seat.js';
import type { RawOrderFromAPI, OrderRecorder, RiskChecker, Trader } from '../../../types/services.js';
import type { DailyLossTracker, UnrealizedLossMonitor } from '../../../core/riskController/types.js';

/**
 * 席位快照
 *
 * 任务创建时记录当前席位的版本号和标的代码，
 * 处理时用于验证席位是否已变更，防止执行过期任务。
 */
export type SeatSnapshot = Readonly<{
  seatVersion: number;
  symbol: string | null;
}>;

/**
 * 自动换标 Tick 任务数据
 *
 * 每秒由主循环触发，携带当前席位状态和时间信息，
 * 供自动换标处理器判断是否需要切换标的。
 */
export type AutoSymbolTickTaskData = Readonly<{
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  symbol: string | null;
  currentTimeMs: number;
  canTradeNow: boolean;
}>;

/**
 * 自动换标切换距离检查任务数据
 *
 * 携带当前监控价格和双向席位快照，
 * 供处理器检查是否需要触发换标流程。
 */
export type AutoSymbolSwitchDistanceTaskData = Readonly<{
  monitorSymbol: string;
  monitorPrice: number | null;
  quotesMap: ReadonlyMap<string, Quote | null>;
  seatSnapshots: Readonly<{
    long: SeatSnapshot;
    short: SeatSnapshot;
  }>;
}>;

/**
 * 席位刷新任务数据
 *
 * 换标完成后触发，携带新旧标的信息和行情数据，
 * 供处理器执行席位状态更新和相关缓存刷新。
 */
export type SeatRefreshTaskData = Readonly<{
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  previousSymbol: string | null;
  nextSymbol: string;
  callPrice?: number | null;
  quote: Quote | null;
  symbolName: string | null;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

/**
 * 强平距离检查任务数据
 *
 * 携带当前监控价格和双向席位的行情信息，
 * 供处理器检查是否触及强平距离阈值。
 */
export type LiquidationDistanceCheckTaskData = Readonly<{
  monitorSymbol: string;
  monitorPrice: number;
  long: Readonly<{
    seatVersion: number;
    symbol: string | null;
    quote: Quote | null;
    symbolName: string | null;
  }>;
  short: Readonly<{
    seatVersion: number;
    symbol: string | null;
    quote: Quote | null;
    symbolName: string | null;
  }>;
}>;

/**
 * 浮亏检查任务数据
 *
 * 携带双向席位的标的代码和行情，
 * 供处理器检查当前浮亏是否超过阈值。
 */
export type UnrealizedLossCheckTaskData = Readonly<{
  monitorSymbol: string;
  long: Readonly<{
    seatVersion: number;
    symbol: string | null;
    quote: Quote | null;
  }>;
  short: Readonly<{
    seatVersion: number;
    symbol: string | null;
    quote: Quote | null;
  }>;
}>;

/**
 * 监控任务类型枚举
 *
 * 标识任务的处理类型，供处理器分发到对应的处理逻辑。
 */
export type MonitorTaskType =
  | 'AUTO_SYMBOL_TICK'
  | 'AUTO_SYMBOL_SWITCH_DISTANCE'
  | 'SEAT_REFRESH'
  | 'LIQUIDATION_DISTANCE_CHECK'
  | 'UNREALIZED_LOSS_CHECK';

/**
 * 监控任务数据联合类型
 *
 * 所有监控任务数据类型的联合，与 MonitorTaskType 一一对应。
 */
export type MonitorTaskData =
  | AutoSymbolTickTaskData
  | AutoSymbolSwitchDistanceTaskData
  | SeatRefreshTaskData
  | LiquidationDistanceCheckTaskData
  | UnrealizedLossCheckTaskData;

/**
 * 监控任务处理状态
 *
 * 任务处理完成后的结果状态，供 onProcessed 回调使用。
 */
export type MonitorTaskStatus = 'processed' | 'skipped' | 'failed';

/**
 * 监控任务处理上下文
 *
 * 处理器执行任务时所需的运行时上下文，
 * 由 getMonitorContext 按 monitorSymbol 动态获取。
 */
export type MonitorTaskContext = Readonly<{
  symbolRegistry: SymbolRegistry;
  autoSymbolManager: AutoSymbolManager;
  orderRecorder: OrderRecorder;
  dailyLossTracker: DailyLossTracker;
  riskChecker: RiskChecker;
  unrealizedLossMonitor: UnrealizedLossMonitor;
  longSymbolName: string;
  shortSymbolName: string;
  monitorSymbolName: string;
  longQuote: Quote | null;
  shortQuote: Quote | null;
  monitorQuote: Quote | null;
}>;

/**
 * 刷新辅助函数集合
 *
 * 封装席位刷新任务所需的账户/持仓缓存刷新操作，
 * 仅供 MonitorTaskProcessor 内部使用。
 */
export type RefreshHelpers = Readonly<{
  ensureAllOrders: (
    monitorSymbol: string,
    orderRecorder: MonitorTaskContext['orderRecorder'],
  ) => Promise<ReadonlyArray<RawOrderFromAPI>>;
  refreshAccountCaches: () => Promise<void>;
}>;

/**
 * MonitorTaskProcessor 依赖注入配置
 *
 * 创建监控任务处理器所需的全部外部依赖，
 * 通过工厂函数注入，避免直接耦合。
 */
export type MonitorTaskProcessorDeps = Readonly<{
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskType, MonitorTaskData>;
  refreshGate: RefreshGate;
  getMonitorContext: (monitorSymbol: string) => MonitorTaskContext | null;
  clearQueuesForDirection: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => void;
  trader: Trader;
  lastState: LastState;
  tradingConfig: MultiMonitorTradingConfig;
  /** 生命周期门禁：false 时任务直接跳过 */
  getCanProcessTask?: () => boolean;
  onProcessed?: (task: MonitorTask<MonitorTaskType, MonitorTaskData>, status: MonitorTaskStatus) => void;
}>;

/**
 * MonitorTaskProcessor 行为契约
 *
 * 监控任务处理器的公开接口，支持启动、停止和优雅排空。
 */
export interface MonitorTaskProcessor {
  readonly start: () => void;
  readonly stop: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly restart: () => void;
}
