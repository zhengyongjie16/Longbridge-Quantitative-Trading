import type { AutoSymbolManagerPort } from '../../../types/monitorContextPorts.js';
import type { RefreshGate } from '../../../utils/types.js';
import type { QuoteRetryRequirement } from '../../../utils/quoteRetry/types.js';
import type { MonitorTaskQueue, MonitorTask, MonitorTaskInput } from '../monitorTaskQueue/types.js';
import type { LastState } from '../../../types/state.js';
import type { Position } from '../../../types/account.js';
import type { MultiMonitorTradingConfig } from '../../../types/config.js';
import type { Quote } from '../../../types/quote.js';
import type { Signal } from '../../../types/signal.js';
import type { SeatState, SymbolRegistry } from '../../../types/seat.js';
import type {
  RawOrderFromAPI,
  OrderRecorder,
  RiskChecker,
  Trader,
  MarketDataClient,
} from '../../../types/services.js';
import type { DailyLossTracker, UnrealizedLossMonitor } from '../../../types/risk.js';

/**
 * 席位快照（任务创建时点的席位状态）。
 * 类型用途：任务创建时记录席位版本号与标的代码，处理时用于校验席位是否已变更，避免执行过期任务。
 * 数据来源：由 processMonitor 在调度任务时从 symbolRegistry 等获取并写入任务数据。
 * 使用范围：仅 monitorTaskProcessor、processMonitor 内部使用。
 */
export type SeatSnapshot = Readonly<{
  seatVersion: number;
  symbol: string | null;
}>;

/**
 * 自动换标 Tick 任务数据。
 * 类型用途：每秒由主循环触发的监控任务数据，携带当前席位状态与时间信息，供处理器判断是否需换标。
 * 数据来源：由 processMonitor 在 AUTO_SYMBOL_TICK 调度时组装并入队。
 * 使用范围：仅 monitorTaskProcessor、processMonitor 内部使用。
 */
export type AutoSymbolTickTaskData = Readonly<{
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  symbol: string | null;
  currentTimeMs: number;
  canTradeNow: boolean;
  openProtectionActive: boolean;
}>;

/**
 * 自动换标切换距离检查任务数据。
 * 类型用途：携带监控价格与双向席位快照，供处理器检查是否触发换标流程；实际执行时行情统一由状态机按需获取。
 * 数据来源：由 processMonitor 在 AUTO_SYMBOL_SWITCH_DISTANCE 调度时组装并入队。
 * 使用范围：仅 monitorTaskProcessor、processMonitor 内部使用。
 */
export type AutoSymbolSwitchDistanceTaskData = Readonly<{
  monitorSymbol: string;
  monitorPrice: number | null;
  seatSnapshots: Readonly<{
    long: SeatSnapshot;
    short: SeatSnapshot;
  }>;
}>;

/**
 * 席位刷新任务数据。
 * 类型用途：换标完成后触发的任务数据，仅携带席位校验与标的信息；行情统一在执行时获取，避免入队快照与执行态双真相。
 * 数据来源：由 processMonitor 在 SEAT_REFRESH 调度时组装并入队。
 * 使用范围：仅 monitorTaskProcessor、processMonitor 内部使用。
 */
export type SeatRefreshTaskData = Readonly<{
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  previousSymbol: string | null;
  nextSymbol: string;
  callPrice?: number | null;
  symbolName: string | null;
}>;

/**
 * 强平距离检查任务数据。
 * 类型用途：携带监控价格与双向席位快照，供处理器检查是否触及强平距离阈值；行情统一在执行时获取。
 * 数据来源：由 processMonitor 在 LIQUIDATION_DISTANCE_CHECK 调度时组装并入队。
 * 使用范围：仅 monitorTaskProcessor、processMonitor 内部使用。
 */
export type LiquidationDistanceCheckTaskData = Readonly<{
  monitorSymbol: string;
  monitorPrice: number;
  retryAttempts?: number;
  long: Readonly<{
    seatVersion: number;
    symbol: string | null;
    symbolName: string | null;
  }>;
  short: Readonly<{
    seatVersion: number;
    symbol: string | null;
    symbolName: string | null;
  }>;
}>;

/**
 * 浮亏检查任务数据。
 * 类型用途：携带双向席位快照，供处理器检查当前浮亏是否超过阈值；行情统一在执行时获取。
 * 数据来源：由 processMonitor 在 UNREALIZED_LOSS_CHECK 调度时组装并入队。
 * 使用范围：仅 monitorTaskProcessor、processMonitor 内部使用。
 */
export type UnrealizedLossCheckTaskData = Readonly<{
  monitorSymbol: string;
  retryAttempts?: number;
  long: Readonly<{
    seatVersion: number;
    symbol: string | null;
  }>;
  short: Readonly<{
    seatVersion: number;
    symbol: string | null;
  }>;
}>;

/**
 * 监控任务类型到 payload 的映射。
 * 类型用途：表达 task.type 与 task.data 的一一对应关系，确保队列与处理器形成判别联合。
 * 数据来源：由各调度点组装的具体任务数据入队时确定。
 * 使用范围：仅 monitorTaskProcessor、monitorTaskQueue、processMonitor 内部使用。
 */
export type MonitorTaskDataMap = Readonly<{
  AUTO_SYMBOL_TICK: AutoSymbolTickTaskData;
  AUTO_SYMBOL_SWITCH_DISTANCE: AutoSymbolSwitchDistanceTaskData;
  SEAT_REFRESH: SeatRefreshTaskData;
  LIQUIDATION_DISTANCE_CHECK: LiquidationDistanceCheckTaskData;
  UNREALIZED_LOSS_CHECK: UnrealizedLossCheckTaskData;
}>;

/**
 * 监控任务处理状态（任务处理结果）。
 * 类型用途：任务处理完成后的结果状态，供 onProcessed 回调使用。
 * 数据来源：由 MonitorTaskProcessor 在处理单任务后根据执行结果设置。
 * 使用范围：仅 monitorTaskProcessor 及注册 onProcessed 的调用方使用，内部使用。
 */
export type MonitorTaskStatus = 'processed' | 'skipped' | 'failed';

/**
 * 监控任务 quote retry 重新入队请求。
 * 类型用途：由 handler 返回给 processor 层，由 processor 统一注册 timeout 并重新回灌 monitorTaskQueue。
 * 数据来源：liquidationDistance / unrealizedLoss handler 在发现 unresolved quote 时构造。
 * 使用范围：仅 monitorTaskProcessor 内部使用。
 */
export type MonitorTaskRetryRequest<
  TType extends keyof MonitorTaskDataMap = keyof MonitorTaskDataMap,
> = Readonly<{
  task: MonitorTaskInput<MonitorTaskDataMap, TType>;
  retryKey: string;
  attempts: number;
  requirement: QuoteRetryRequirement;
}>;

/**
 * 清仓执行项。
 * 类型用途：LIQUIDATION_DISTANCE_CHECK 处理中用于串联下单、清理与浮亏刷新的单边任务载体。
 * 数据来源：由 liquidationDistance handler 在风控通过后创建。
 * 使用范围：仅 monitorTaskProcessor/liquidationDistance handler 使用。
 */
export type LiquidationTask = Readonly<{
  signal: Signal;
  direction: 'LONG' | 'SHORT';
  quote: Quote | null;
}>;

/**
 * createLiquidationTask 入参。
 * 类型用途：聚合单边清仓信号构造所需上下文，避免函数参数列表过长。
 * 数据来源：由 liquidationDistance handler 组装。
 * 使用范围：仅 monitorTaskProcessor/liquidationDistance handler 使用。
 */
export type CreateLiquidationTaskParams = Readonly<{
  symbol: string;
  symbolName: string | null;
  direction: 'LONG' | 'SHORT';
  position: Position | null;
  quote: Quote | null;
  seatVersion: number;
  monitorPrice: number;
  riskChecker: RiskChecker;
}>;

/**
 * 监控任务处理上下文（处理器执行任务时的运行时依赖）。
 * 类型用途：处理器执行监控任务时所需的上下文，含 symbolRegistry、orderRecorder、riskChecker、名称缓存等；由 getMonitorContext(monitorSymbol) 获取。
 * 数据来源：由 mainProgram 的 getMonitorContext 按 monitorSymbol 从 monitorContexts 等组装返回。
 * 使用范围：仅 monitorTaskProcessor 内部使用。
 */
export type MonitorTaskContext = Readonly<{
  symbolRegistry: SymbolRegistry;
  autoSymbolManager: AutoSymbolManagerPort;
  orderRecorder: OrderRecorder;
  dailyLossTracker: DailyLossTracker;
  riskChecker: RiskChecker;
  unrealizedLossMonitor: UnrealizedLossMonitor;
  longSymbolName: string;
  shortSymbolName: string;
  monitorSymbolName: string;
}>;

/**
 * 刷新辅助函数集合（席位刷新任务用工具）。
 * 类型用途：封装席位刷新任务所需的订单拉取与账户缓存刷新，供 MonitorTaskProcessor 内部调用。
 * 数据来源：由 MonitorTaskProcessor 实现模块注入或闭包提供。
 * 使用范围：仅 MonitorTaskProcessor 内部使用。
 */
export type RefreshHelpers = Readonly<{
  ensureAllOrders: (
    monitorSymbol: string,
    orderRecorder: MonitorTaskContext['orderRecorder'],
  ) => Promise<ReadonlyArray<RawOrderFromAPI>>;
  refreshAccountCaches: () => Promise<void>;
}>;

/**
 * MonitorTaskProcessor 依赖注入配置（创建监控任务处理器时的参数）。
 * 类型用途：创建 MonitorTaskProcessor 所需的全部外部依赖（队列、refreshGate、getMonitorContext、trader 等）。
 * 数据来源：由主程序/启动流程组装并传入工厂。
 * 使用范围：仅 monitorTaskProcessor 及启动流程使用，内部使用。
 */
export type MonitorTaskProcessorDeps = Readonly<{
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
  refreshGate: RefreshGate;
  getMonitorContext: (monitorSymbol: string) => MonitorTaskContext | null;
  clearMonitorDirectionQueues: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => void;
  trader: Trader;
  marketDataClient: MarketDataClient;
  lastState: LastState;
  tradingConfig: MultiMonitorTradingConfig;

  /** 一次性路径 quote retry 调度器 */
  scheduleRetry?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

  /** 一次性路径 quote retry 清理器 */
  clearRetry?: (handle: ReturnType<typeof setTimeout>) => void;

  /** 生命周期门禁：false 时任务直接跳过 */
  getCanProcessTask?: () => boolean;
  onProcessed?: (task: MonitorTask<MonitorTaskDataMap>, status: MonitorTaskStatus) => void;
}>;

/**
 * MonitorTaskProcessor 行为契约。
 * 类型用途：监控任务处理器的公开接口（start/stop/stopAndDrain/restart），与 Processor 一致，供主程序/ lifecycle 调度。
 * 数据来源：主程序通过工厂创建并持有，任务由 processMonitor 经 monitorTaskQueue 入队。
 * 使用范围：mainProgram、lifecycle、processMonitor 等，仅内部使用。
 */
export interface MonitorTaskProcessor {
  readonly start: () => void;
  readonly stop: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly restart: () => void;
}

/**
 * 监控上下文与席位就绪结果。
 * 类型用途：evaluateMonitorContextAndSeatReadiness 的返回值，供 liquidationDistance、unrealizedLoss 等 handler 使用。
 * 数据来源：由 evaluateMonitorContextAndSeatReadiness 在校验与解析后构造。
 * 使用范围：仅 monitorTaskProcessor 各 handler 内部使用。
 */
export type MonitorContextAndSeatReadiness = Readonly<{
  context: MonitorTaskContext;
  seatReadiness: Readonly<{
    longSeat: SeatState;
    shortSeat: SeatState;
    isLongReady: boolean;
    isShortReady: boolean;
    longSymbol: string;
    shortSymbol: string;
  }>;
}>;

/**
 * quote retry 注册表条目。
 * 类型用途：记录一次待执行的监控任务重试定时器句柄。
 * 数据来源：由 MonitorTaskProcessor 在 scheduleTaskRetry 时创建。
 * 使用范围：仅 monitorTaskProcessor/index 内部使用。
 */
export type RetryRegistryEntry = Readonly<{
  handle: ReturnType<typeof setTimeout>;
}>;
