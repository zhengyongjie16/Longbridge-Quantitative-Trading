import type { SwitchWakeupRuntime } from '../../monitorQuoteEventRuntime/types.js';
import type { MonitorTaskQueue, MonitorTask } from '../monitorTaskQueue/types.js';
import type { LastState, MonitorContext } from '../../../types/state.js';
import type { MultiMonitorTradingConfig } from '../../../types/config.js';
import type { SeatState } from '../../../types/seat.js';
import type {
  PostTradeConsistencyFreshnessPort,
  RawOrderFromAPI,
  Trader,
  MarketDataClient,
} from '../../../types/services.js';
import type { QuoteSubscriptionRuntime } from '../../quoteSubscriptionRuntime/types.js';

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
 * 席位刷新任务数据。
 * 类型用途：seat 进入 ACTIVATING 后触发的激活屏障任务数据，仅携带席位校验与标的信息；行情统一在执行时获取，避免入队快照与执行态双真相。
 * 数据来源：由 SeatActivationDispatcher 在 seat 进入 ACTIVATING 时组装并入队。
 * 使用范围：仅 monitorTaskProcessor、SeatActivationDispatcher 内部使用。
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
 * 监控任务类型到 payload 的映射。
 * 类型用途：表达 task.type 与 task.data 的一一对应关系，确保队列与处理器形成判别联合。
 * 数据来源：由各调度点组装的具体任务数据入队时确定。
 * 使用范围：仅 monitorTaskProcessor、monitorTaskQueue、processMonitor 内部使用。
 */
export type MonitorTaskDataMap = Readonly<{
  AUTO_SYMBOL_TICK: AutoSymbolTickTaskData;
  SEAT_REFRESH: SeatRefreshTaskData;
}>;

/**
 * 监控任务处理状态（任务处理结果）。
 * 类型用途：任务处理完成后的结果状态，供 onProcessed 回调使用。
 * 数据来源：由 MonitorTaskProcessor 在处理单任务后根据执行结果设置。
 * 使用范围：仅 monitorTaskProcessor 及注册 onProcessed 的调用方使用，内部使用。
 */
export type MonitorTaskStatus = 'processed' | 'skipped' | 'failed';

/**
 * 监控任务处理上下文（处理器执行任务时的运行时依赖）。
 * 类型用途：处理器执行监控任务时所需的上下文，含 symbolRegistry、orderRecorder、riskChecker、名称缓存等；由 getMonitorContext(monitorSymbol) 获取。
 * 数据来源：由 timeDriverProgram 的 getMonitorContext 按 monitorSymbol 从 monitorContexts 等组装返回。
 * 使用范围：仅 monitorTaskProcessor 内部使用。
 */
export type MonitorTaskContext = Pick<
  MonitorContext,
  | 'config'
  | 'state'
  | 'symbolRegistry'
  | 'seatState'
  | 'seatVersion'
  | 'autoSymbolManager'
  | 'orderRecorder'
  | 'dailyLossTracker'
  | 'riskChecker'
  | 'longSymbolName'
  | 'shortSymbolName'
  | 'monitorSymbolName'
  | 'normalizedMonitorSymbol'
  | 'indicatorProfile'
  | 'strategy'
  | 'unrealizedLossMonitor'
  | 'delayedSignalVerifier'
>;

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
 * 类型用途：创建 MonitorTaskProcessor 所需的全部外部依赖（队列、getMonitorContext、trader 等）。
 * 数据来源：由主程序/启动流程组装并传入工厂。
 * 使用范围：仅 monitorTaskProcessor 及启动流程使用，内部使用。
 */
export type MonitorTaskProcessorDeps = Readonly<{
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
  getMonitorContext: (monitorSymbol: string) => MonitorTaskContext | null;
  clearMonitorDirectionQueues: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => void;
  trader: Trader;
  marketDataClient: MarketDataClient;
  quoteSubscriptionRuntime: Pick<
    QuoteSubscriptionRuntime,
    'retainSymbols' | 'waitForAdmission' | 'reconcilePositionHoldFromCurrentTruth'
  >;
  switchWakeupRuntime: Pick<SwitchWakeupRuntime, 'handoffPendingSwitch'>;
  lastState: LastState;
  tradingConfig: MultiMonitorTradingConfig;

  /** 生命周期门禁：false 时任务直接跳过 */
  getCanProcessTask?: () => boolean;
  onProcessed?: (task: MonitorTask<MonitorTaskDataMap>, status: MonitorTaskStatus) => void;
}>;

/**
 * MonitorTaskProcessor 行为契约。
 * 类型用途：监控任务处理器的公开接口（start/stop/stopAndDrain/restart），与 Processor 一致，供主程序/ lifecycle 调度。
 * 数据来源：主程序通过工厂创建并持有，任务由 processMonitor 经 monitorTaskQueue 入队。
 * 使用范围：timeDriverProgram、lifecycle、processMonitor 等，仅内部使用。
 */
export interface MonitorTaskProcessor {
  readonly start: () => void;
  readonly stop: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly restart: () => void;
}

/**
 * 监控上下文与席位就绪结果。
 * 类型用途：evaluateMonitorContextAndSeatReadiness 的返回值，供自动换标等 handler 复用。
 * 数据来源：由 evaluateMonitorContextAndSeatReadiness 在校验席位快照后构造。
 * 使用范围：仅 monitorTaskProcessor 模块内部使用。
 */
export type MonitorContextSeatReadinessResult = Readonly<{
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
 * 监控上下文与席位就绪评估参数。
 * 类型用途：evaluateMonitorContextAndSeatReadiness 的入参，封装上下文获取与双向席位快照校验依赖。
 * 数据来源：由 monitorTaskProcessor 各 handler 在处理任务时组装。
 * 使用范围：仅 monitorTaskProcessor 模块内部使用。
 */
export type EvaluateMonitorContextAndSeatReadinessParams = Readonly<{
  getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  postTradeConsistencyRuntime: PostTradeConsistencyFreshnessPort;
  monitorSymbol: string;
  longSnapshot: SeatSnapshot;
  shortSnapshot: SeatSnapshot;
}>;
