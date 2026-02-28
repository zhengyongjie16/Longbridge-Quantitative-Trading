import type { AutoSymbolManager } from '../../../services/autoSymbolManager/types.js';
import type { RefreshGate } from '../../../utils/types.js';
import type { MonitorTaskQueue, MonitorTask } from '../monitorTaskQueue/types.js';
import type { LastState } from '../../../types/state.js';
import type { Quote } from '../../../types/quote.js';
import type { MultiMonitorTradingConfig } from '../../../types/config.js';
import type { SymbolRegistry } from '../../../types/seat.js';
import type {
  RawOrderFromAPI,
  OrderRecorder,
  RiskChecker,
  Trader,
} from '../../../types/services.js';
import type {
  DailyLossTracker,
  UnrealizedLossMonitor,
} from '../../../core/riskController/types.js';

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
 * 类型用途：携带监控价格与双向席位快照，供处理器检查是否触发换标流程。
 * 数据来源：由 processMonitor 在 AUTO_SYMBOL_SWITCH_DISTANCE 调度时组装并入队。
 * 使用范围：仅 monitorTaskProcessor、processMonitor 内部使用。
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
 * 席位刷新任务数据。
 * 类型用途：换标完成后触发的任务数据，携带新旧标的信息与行情，供处理器执行席位更新与缓存刷新。
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
  quote: Quote | null;
  symbolName: string | null;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

/**
 * 强平距离检查任务数据。
 * 类型用途：携带监控价格与双向席位行情，供处理器检查是否触及强平距离阈值。
 * 数据来源：由 processMonitor 在 LIQUIDATION_DISTANCE_CHECK 调度时组装并入队。
 * 使用范围：仅 monitorTaskProcessor、processMonitor 内部使用。
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
 * 浮亏检查任务数据。
 * 类型用途：携带双向席位标的与行情，供处理器检查当前浮亏是否超过阈值。
 * 数据来源：由 processMonitor 在 UNREALIZED_LOSS_CHECK 调度时组装并入队。
 * 使用范围：仅 monitorTaskProcessor、processMonitor 内部使用。
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
 * 监控任务类型枚举（任务 type 字段字面量）。
 * 类型用途：标识监控任务的处理类型，供 MonitorTaskProcessor 分发到对应处理逻辑。
 * 数据来源：由 processMonitor 在 scheduleLatest 时根据业务选择 type 入队。
 * 使用范围：monitorTaskQueue、monitorTaskProcessor、mainProgram、processMonitor 等，仅内部使用。
 */
export type MonitorTaskType =
  | 'AUTO_SYMBOL_TICK'
  | 'AUTO_SYMBOL_SWITCH_DISTANCE'
  | 'SEAT_REFRESH'
  | 'LIQUIDATION_DISTANCE_CHECK'
  | 'UNREALIZED_LOSS_CHECK';

/**
 * 监控任务数据联合类型。
 * 类型用途：与 MonitorTaskType 一一对应的任务 data 类型联合，供 MonitorTask<MonitorTaskType, MonitorTaskData> 使用。
 * 数据来源：由各调度点组装的具体任务数据入队时确定。
 * 使用范围：仅 monitorTaskProcessor、monitorTaskQueue、processMonitor 内部使用。
 */
export type MonitorTaskData =
  | AutoSymbolTickTaskData
  | AutoSymbolSwitchDistanceTaskData
  | SeatRefreshTaskData
  | LiquidationDistanceCheckTaskData
  | UnrealizedLossCheckTaskData;

/**
 * 监控任务处理状态（任务处理结果）。
 * 类型用途：任务处理完成后的结果状态，供 onProcessed 回调使用。
 * 数据来源：由 MonitorTaskProcessor 在处理单任务后根据执行结果设置。
 * 使用范围：仅 monitorTaskProcessor 及注册 onProcessed 的调用方使用，内部使用。
 */
export type MonitorTaskStatus = 'processed' | 'skipped' | 'failed';

/**
 * 监控任务处理上下文（处理器执行任务时的运行时依赖）。
 * 类型用途：处理器执行监控任务时所需的上下文，含 symbolRegistry、orderRecorder、riskChecker、行情等；由 getMonitorContext(monitorSymbol) 获取。
 * 数据来源：由 mainProgram 的 getMonitorContext 按 monitorSymbol 从 monitorContexts 等组装返回。
 * 使用范围：仅 monitorTaskProcessor 内部使用。
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
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskType, MonitorTaskData>;
  refreshGate: RefreshGate;
  getMonitorContext: (monitorSymbol: string) => MonitorTaskContext | null;
  clearMonitorDirectionQueues: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => void;
  trader: Trader;
  lastState: LastState;
  tradingConfig: MultiMonitorTradingConfig;
  /** 生命周期门禁：false 时任务直接跳过 */
  getCanProcessTask?: () => boolean;
  onProcessed?: (
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
    status: MonitorTaskStatus,
  ) => void;
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
