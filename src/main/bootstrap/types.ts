import type { RuntimeSymbolValidationInput } from '../../config/types.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type {
  MonitorTaskData,
  MonitorTaskType,
} from '../asyncProgram/monitorTaskProcessor/types.js';
import type { BuyTaskType, SellTaskType, TaskQueue } from '../asyncProgram/tradeTaskQueue/types.js';
import type {
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
  RebuildTradingDayStateParams,
} from '../lifecycle/types.js';
import type { Logger } from '../../utils/logger/types.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { Signal } from '../../types/signal.js';
import type { MarketDataClient, TradingDayInfo } from '../../types/services.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { Quote } from '../../types/quote.js';
import type { QueueClearResult } from '../../types/queue.js';

/**
 * 席位方向。
 * 类型用途：约束席位操作方向，仅允许 LONG 或 SHORT。
 * 数据来源：由主流程和席位管理逻辑传入。
 * 使用范围：仅启动与 bootstrap 模块使用。
 */
export type SeatDirection = 'LONG' | 'SHORT';

/**
 * 单个监控标的的双向席位标的代码。
 * 类型用途：表达 monitorSymbol 对应的 long/short 就绪席位代码。
 * 数据来源：由 symbolRegistry 查询并组合得到。
 * 使用范围：仅启动阶段运行时校验流程使用。
 */
export type ResolvedSeatSymbols = Readonly<{
  longSeatSymbol: string | null;
  shortSeatSymbol: string | null;
}>;

/**
 * 交易日信息缓存条目。
 * 类型用途：按交易日缓存 `isTradingDay/isHalfDay`，避免重复调用交易日接口。
 * 数据来源：由 marketDataClient.isTradingDay(currentTime) 返回并缓存。
 * 使用范围：仅启动门控解析流程使用。
 */
export type CachedTradingDayInfo = Readonly<{
  dateStr: string;
  info: TradingDayInfo;
}>;

/**
 * 交易日信息解析器依赖。
 * 类型用途：创建带缓存的交易日解析函数时注入依赖。
 * 数据来源：由启动流程组装 marketDataClient、时间键函数和错误回调。
 * 使用范围：仅 bootstrap/rebuild 使用。
 */
export type TradingDayInfoResolverDeps = Readonly<{
  marketDataClient: Pick<MarketDataClient, 'isTradingDay'>;
  getHKDateKey: (currentTime: Date) => string | null;
  onResolveError: (err: unknown) => void;
}>;

/**
 * 交易日信息解析函数签名。
 * 类型用途：统一启动门禁所需的 resolveTradingDayInfo 函数类型。
 * 数据来源：由 createTradingDayInfoResolver() 创建并返回。
 * 使用范围：仅启动门禁流程使用。
 */
export type TradingDayInfoResolver = (currentTime: Date) => Promise<TradingDayInfo>;

/**
 * 运行时标的校验收集器。
 * 类型用途：聚合 requiredSymbols 去重集合和 runtimeValidationInputs 校验输入数组。
 * 数据来源：由主入口初始化并在收集阶段持续写入。
 * 使用范围：仅主入口运行时标的校验构建流程使用。
 */
export type RuntimeValidationCollector = Readonly<{
  requiredSymbols: Set<string>;
  runtimeValidationInputs: RuntimeSymbolValidationInput[];
}>;

/**
 * 追加运行时标的校验输入的参数。
 * 类型用途：封装单次 pushRuntimeValidationSymbol 所需字段与收集器引用。
 * 数据来源：由主入口遍历监控标的和持仓时传入。
 * 使用范围：仅主入口运行时标的校验构建流程使用。
 */
export type PushRuntimeValidationSymbolParams = Readonly<{
  symbol: string | null;
  label: string;
  requireLotSize: boolean;
  required: boolean;
  collector: RuntimeValidationCollector;
}>;

/**
 * 解析监控标的席位代码的参数。
 * 类型用途：为 resolveSeatSymbolsByMonitor 传入 symbolRegistry 和 monitorSymbol。
 * 数据来源：由主入口循环监控配置时传入。
 * 使用范围：仅主入口与 bootstrap 协作使用。
 */
export type ResolveSeatSymbolsByMonitorParams = Readonly<{
  symbolRegistry: SymbolRegistry;
  monitorSymbol: string;
}>;

/**
 * 带日志的队列清理参数。
 * 类型用途：清理指定监控标的方向下的延迟/买卖/监控任务并输出日志。
 * 数据来源：由主入口传入 monitorContexts、各任务队列、释放回调与 logger。
 * 使用范围：仅主入口自动换标队列清理流程使用。
 */
export type ClearQueuesForDirectionWithLogParams = Readonly<{
  monitorSymbol: string;
  direction: SeatDirection;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskType, MonitorTaskData>;
  releaseSignal: (signal: Signal) => void;
  logger: Pick<Logger, 'info'>;
}>;

/**
 * 开盘重建执行参数。
 * 类型用途：封装 runTradingDayOpenRebuild 所需的当前时间和重建相关函数依赖。
 * 数据来源：由主入口在创建 lifecycle 前组装并传入。
 * 使用范围：仅 bootstrap/rebuild 使用。
 */
export type RunTradingDayOpenRebuildParams = Readonly<{
  now: Date;
  loadTradingDayRuntimeSnapshot: (
    params: LoadTradingDayRuntimeSnapshotParams,
  ) => Promise<LoadTradingDayRuntimeSnapshotResult>;
  rebuildTradingDayState: (params: RebuildTradingDayStateParams) => Promise<void>;
}>;

/**
 * 队列清理执行函数签名。
 * 类型用途：约束 clearMonitorDirectionQueues 返回结构，供 bootstrap/queueCleanup 复用。
 * 数据来源：由 processMonitor utils 实现。
 * 使用范围：仅 bootstrap 模块内部使用。
 */
export type ClearMonitorDirectionQueuesFn = (params: {
  readonly monitorSymbol: string;
  readonly direction: SeatDirection;
  readonly delayedSignalVerifier: MonitorContext['delayedSignalVerifier'];
  readonly buyTaskQueue: TaskQueue<BuyTaskType>;
  readonly sellTaskQueue: TaskQueue<SellTaskType>;
  readonly monitorTaskQueue: MonitorTaskQueue<MonitorTaskType, MonitorTaskData>;
  readonly releaseSignal: (signal: Signal) => void;
}) => QueueClearResult;

/**
 * 账户与持仓展示函数入参。
 * 类型用途：作为 displayAccountAndPositions 的对象参数类型，避免调用方重复内联定义。
 * 数据来源：由主入口与刷新流程组装传入。
 * 使用范围：bootstrap 及生命周期/刷新流程使用。
 */
export type DisplayAccountAndPositionsParams = Readonly<{
  lastState: LastState;
  quotesMap?: ReadonlyMap<string, Quote | null> | null;
}>;
