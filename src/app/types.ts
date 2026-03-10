import type { Config } from 'longport';
import type {
  RuntimeSymbolValidationInput,
  RuntimeSymbolValidationResult,
} from '../config/types.js';
import type { Position } from '../types/account.js';
import type { GateMode, RunMode, SymbolRegistry } from '../types/seat.js';
import type { LastState, MonitorContext, MonitorState } from '../types/state.js';
import type { MonitorConfig, MultiMonitorTradingConfig } from '../types/config.js';
import type { Quote } from '../types/quote.js';
import type {
  MarketDataClient,
  OrderRecorder,
  RawOrderFromAPI,
  RiskChecker,
  Trader,
  TradingDayInfo,
} from '../types/services.js';
import type { DailyLossTracker, UnrealizedLossMonitor } from '../types/risk.js';
import type { HangSengMultiIndicatorStrategy } from '../core/strategy/types.js';
import type { AutoSymbolManager } from '../services/autoSymbolManager/types.js';
import type {
  WarrantListCache,
  WarrantListCacheConfig,
} from '../services/autoSymbolFinder/types.js';
import type {
  LiquidationCooldownTracker,
  TradeLogHydrator,
} from '../services/liquidationCooldown/types.js';
import type { LossOffsetLifecycleCoordinator } from '../core/riskController/lossOffsetLifecycleCoordinator/types.js';
import type { RefreshGate } from '../utils/types.js';
import type { MarketMonitor } from '../services/marketMonitor/types.js';
import type { DoomsdayProtection } from '../core/doomsdayProtection/types.js';
import type { SignalProcessor } from '../core/signalProcessor/types.js';
import type { IndicatorCache } from '../main/asyncProgram/indicatorCache/types.js';
import type {
  BuyTaskType,
  SellTaskType,
  TaskQueue,
} from '../main/asyncProgram/tradeTaskQueue/types.js';
import type { MonitorTaskQueue } from '../main/asyncProgram/monitorTaskQueue/types.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskProcessor,
} from '../main/asyncProgram/monitorTaskProcessor/types.js';
import type { OrderMonitorWorker } from '../main/asyncProgram/orderMonitorWorker/types.js';
import type { PostTradeRefresher } from '../main/asyncProgram/postTradeRefresher/types.js';
import type { Processor } from '../main/asyncProgram/types.js';
import type {
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
  RebuildTradingDayStateDeps,
  RebuildTradingDayStateParams,
  CacheDomain,
  DayLifecycleManager,
  DayLifecycleManagerDeps,
} from '../main/lifecycle/types.js';
import type { Signal } from '../types/signal.js';
import type { Logger } from '../utils/logger/types.js';
import type { StartupGate } from '../main/startup/types.js';
import type {
  GlobalStateDomainDeps,
  MarketDataDomainDeps,
  OrderDomainDeps,
  RiskDomainDeps,
  SeatDomainDeps,
  SignalRuntimeDomainDeps,
} from '../main/lifecycle/cacheDomains/types.js';
import type { MainProgramContext } from '../main/mainProgram/types.js';
import type { DisplayAccountAndPositionsParams } from '../services/accountDisplay/types.js';

/**
 * 启动门禁策略。
 * 类型用途：表达 startup gate 与 runtime gate 的组合策略。
 * 数据来源：由 app 组装层根据 RUN_MODE 解析生成。
 * 使用范围：仅 app 启动装配链路使用。
 */
export type GatePolicies = Readonly<{
  startupGate: GateMode;
  runtimeGate: GateMode;
}>;

/**
 * app 环境参数。
 * 类型用途：统一表达从入口传入 app 组装层的环境变量对象。
 * 数据来源：由 src/index.ts 调用 runApp 时传入 process.env。
 * 使用范围：runApp 与 pre-gate runtime 创建链路使用。
 */
export type AppEnvironmentParams = Readonly<{
  env: NodeJS.ProcessEnv;
}>;

/**
 * 交易日信息缓存条目。
 * 类型用途：按交易日缓存 `isTradingDay/isHalfDay`，避免重复调用交易日接口。
 * 数据来源：由 createTradingDayInfoResolver 查询并缓存。
 * 使用范围：仅 app 启动门禁装配使用。
 */
export type CachedTradingDayInfo = Readonly<{
  dateStr: string;
  info: TradingDayInfo;
}>;

/**
 * 交易日信息解析器依赖。
 * 类型用途：创建带缓存的交易日解析函数时注入依赖。
 * 数据来源：由 app 启动组装 marketDataClient、日期键函数和错误回调。
 * 使用范围：仅 app 启动门禁装配使用。
 */
export type TradingDayInfoResolverDeps = Readonly<{
  marketDataClient: Pick<MarketDataClient, 'isTradingDay'>;
  getHKDateKey: (currentTime: Date) => string | null;
  onResolveError: (err: unknown) => void;
}>;

/**
 * 交易日信息解析函数签名。
 * 类型用途：统一 startup gate 所需的 resolveTradingDayInfo 函数类型。
 * 数据来源：由 createTradingDayInfoResolver 创建并返回。
 * 使用范围：仅 app 启动门禁装配使用。
 */
export type TradingDayInfoResolver = (currentTime: Date) => Promise<TradingDayInfo>;

/**
 * 运行时标的校验收集器。
 * 类型用途：聚合 requiredSymbols 去重集合和 runtimeValidationInputs 校验输入数组。
 * 数据来源：由 app 运行时标的收集阶段初始化并持续写入。
 * 使用范围：仅 app 装配层运行时校验链路使用。
 */
export type MutableRuntimeValidationCollector = {
  requiredSymbols: Set<string>;
  runtimeValidationInputs: RuntimeSymbolValidationInput[];
};

/**
 * 运行时标的校验收集结果。
 * 类型用途：对外暴露 runtimeValidationInputs 与 requiredSymbols 的只读视图，避免调用方越过收集流程直接改写。
 * 数据来源：由 collectRuntimeValidationSymbols 返回。
 * 使用范围：仅 app 顶层装配与测试替身使用。
 */
export type RuntimeValidationCollector = Readonly<{
  requiredSymbols: ReadonlySet<string>;
  runtimeValidationInputs: ReadonlyArray<RuntimeSymbolValidationInput>;
}>;

/**
 * 运行时标的校验收集参数。
 * 类型用途：封装 collectRuntimeValidationSymbols 所需的配置、席位注册表与持仓列表。
 * 数据来源：由 app 顶层装配在 startup snapshot 后传入。
 * 使用范围：仅 app 运行时标的校验链路使用。
 */
export type RuntimeValidationCollectionParams = Readonly<{
  tradingConfig: MultiMonitorTradingConfig;
  symbolRegistry: SymbolRegistry;
  positions: ReadonlyArray<Position>;
}>;

/**
 * 追加运行时标的校验输入的参数。
 * 类型用途：封装单次 pushRuntimeValidationSymbol 所需字段与收集器引用。
 * 数据来源：由 app 运行时校验收集流程组装。
 * 使用范围：仅 app 装配层运行时校验链路使用。
 */
export type PushRuntimeValidationSymbolParams = Readonly<{
  symbol: string | null;
  label: string;
  requireLotSize: boolean;
  required: boolean;
  collector: MutableRuntimeValidationCollector;
}>;

/**
 * 解析监控标的席位代码的参数。
 * 类型用途：为 resolveSeatSymbolsByMonitor 传入 symbolRegistry 和 monitorSymbol。
 * 数据来源：由 app 运行时校验收集流程传入。
 * 使用范围：仅 app 装配层使用。
 */
export type ResolveSeatSymbolsByMonitorParams = Readonly<{
  symbolRegistry: SymbolRegistry;
  monitorSymbol: string;
}>;

/**
 * 单个监控标的的双向席位标的代码。
 * 类型用途：表达 monitorSymbol 对应的 long/short 就绪席位代码。
 * 数据来源：由 symbolRegistry 查询并组合得到。
 * 使用范围：仅 app 运行时校验收集流程使用。
 */
export type ResolvedSeatSymbols = Readonly<{
  longSeatSymbol: string | null;
  shortSeatSymbol: string | null;
}>;

/**
 * 开盘重建执行参数。
 * 类型用途：封装 runTradingDayOpenRebuild 所需的当前时间和重建相关函数依赖。
 * 数据来源：由 app 生命周期装配时组装并传入。
 * 使用范围：仅 app 重建接线 helper 使用。
 */
export type RunTradingDayOpenRebuildParams = Readonly<{
  now: Date;
  loadTradingDayRuntimeSnapshot: (
    params: LoadTradingDayRuntimeSnapshotParams,
  ) => Promise<LoadTradingDayRuntimeSnapshotResult>;
  rebuildTradingDayState: (params: RebuildTradingDayStateParams) => Promise<void>;
}>;

/**
 * 监控上下文工厂依赖注入参数。
 * 类型用途：供 createMonitorContext 工厂函数消费，用于构造 MonitorContext。
 * 数据来源：由 app 顶层装配链路在每个 monitor 上下文创建时传入。
 * 使用范围：仅 app createMonitorContext 使用。
 */
export type MonitorContextFactoryDeps = Readonly<{
  config: MonitorConfig;
  state: MonitorState;
  symbolRegistry: SymbolRegistry;
  quotesMap: ReadonlyMap<string, Quote | null>;
  strategy: HangSengMultiIndicatorStrategy;
  orderRecorder: OrderRecorder;
  dailyLossTracker: DailyLossTracker;
  riskChecker: RiskChecker;
  unrealizedLossMonitor: UnrealizedLossMonitor;
  delayedSignalVerifier: MonitorContext['delayedSignalVerifier'];
  autoSymbolManager: AutoSymbolManager;
}>;

/**
 * 退出清理上下文。
 * 类型用途：作为 createCleanup 的入参，封装程序退出时需要释放的处理器与资源引用。
 * 数据来源：由 app 顶层装配在全部 runtime 创建后组装传入。
 * 使用范围：仅 app createCleanup 使用。
 */
export type CleanupContext = Readonly<{
  buyProcessor: Processor;
  sellProcessor: Processor;
  monitorTaskProcessor: MonitorTaskProcessor;
  orderMonitorWorker: OrderMonitorWorker;
  postTradeRefresher: PostTradeRefresher;
  marketDataClient: MarketDataClient;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  indicatorCache: IndicatorCache;
  lastState: LastState;
}>;

/**
 * 退出清理控制器。
 * 类型用途：表达 createCleanup 返回的 execute/registerExitHandlers 能力集合。
 * 数据来源：由 createCleanup 创建。
 * 使用范围：仅 app 顶层装配与测试使用。
 */
export type CleanupController = Readonly<{
  execute: () => Promise<void>;
  registerExitHandlers: () => void;
}>;

/**
 * 退出清理失败条目。
 * 类型用途：记录单个 cleanup 步骤失败的步骤名与原始错误。
 * 数据来源：由 createCleanup 在执行各清理步骤时收集。
 * 使用范围：仅 app cleanup 装配链路内部使用。
 */
export type CleanupFailure = Readonly<{
  step: string;
  error: unknown;
}>;

/**
 * 启动快照加载结果。
 * 类型用途：表达 startup snapshot load 成功或失败后的统一结果。
 * 数据来源：由 loadStartupSnapshot 返回。
 * 使用范围：仅 app 顶层装配与测试使用。
 */
export type StartupSnapshotResult = Readonly<{
  allOrders: ReadonlyArray<RawOrderFromAPI>;
  quotesMap: ReadonlyMap<string, Quote | null>;
  startupRebuildPending: boolean;
  now: Date;
}>;

/**
 * 启动快照加载参数。
 * 类型用途：封装 startup snapshot load 所需依赖与当前时间。
 * 数据来源：由 app 顶层装配阶段组装传入。
 * 使用范围：仅 app loadStartupSnapshot 使用。
 */
export type LoadStartupSnapshotParams = Readonly<{
  now: Date;
  lastState: LastState;
  loadTradingDayRuntimeSnapshot: (
    params: LoadTradingDayRuntimeSnapshotParams,
  ) => Promise<LoadTradingDayRuntimeSnapshotResult>;
  applyStartupSnapshotFailureState: (lastState: LastState, now: Date) => void;
  logger: Pick<Logger, 'error'>;
  formatError: (error: unknown) => string;
}>;

/**
 * 延迟验证通过后的分流注册参数。
 * 类型用途：封装注册 DelayedSignalVerifier 回调所需的共享状态与队列。
 * 数据来源：由 app 顶层装配在 monitor contexts 创建完成后传入。
 * 使用范围：仅 app 延迟验证接线使用。
 */
export type RegisterDelayedSignalHandlersParams = Readonly<{
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  lastState: LastState;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  logger: Pick<Logger, 'debug' | 'warn'>;
  releaseSignal: (signal: Signal) => void;
}>;

/**
 * 批量监控上下文装配参数。
 * 类型用途：封装 createMonitorContexts 所需的 pre/post gate 运行时对象与启动 quotesMap。
 * 数据来源：由 app 顶层装配在 startup snapshot 之后组装传入。
 * 使用范围：仅 monitor 批量装配链路使用。
 */
export type CreateMonitorContextsParams = Readonly<{
  preGateRuntime: PreGateRuntime;
  postGateRuntime: MutableMonitorContextsPostGateRuntime;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

/**
 * 启动前阶段运行时对象。
 * 类型用途：集中表达 pre-gate 阶段创建并在后续阶段共享的对象所有权。
 * 数据来源：由 createPreGateRuntime 创建。
 * 使用范围：仅 app 顶层装配与后续 runtime 工厂使用。
 */
export type PreGateRuntime = Readonly<{
  config: Config;
  tradingConfig: MultiMonitorTradingConfig;
  symbolRegistry: SymbolRegistry;
  warrantListCache: WarrantListCache;
  warrantListCacheConfig: WarrantListCacheConfig;
  marketDataClient: MarketDataClient;
  runMode: RunMode;
  gatePolicies: GatePolicies;
  startupTradingDayInfo: TradingDayInfo;
  startupGate: StartupGate;
}>;

/**
 * post-gate runtime 创建参数。
 * 类型用途：封装 createPostGateRuntime 所需的环境、pre-gate runtime 与统一时间源。
 * 数据来源：由 app 顶层装配在 startup gate 通过后组装传入。
 * 使用范围：仅 post-gate runtime 创建链路使用。
 */
export type CreatePostGateRuntimeParams = Readonly<{
  env: NodeJS.ProcessEnv;
  preGateRuntime: PreGateRuntime;
  now: Date;
}>;

/**
 * 启动后阶段共享运行时对象。
 * 类型用途：集中表达 post-gate 阶段唯一创建并跨模块共享的对象所有权。
 * 数据来源：由 createPostGateRuntime 创建。
 * 使用范围：仅 app 顶层装配与后续 runtime 工厂使用。
 */
export type PostGateRuntime = Readonly<{
  liquidationCooldownTracker: LiquidationCooldownTracker;
  dailyLossTracker: DailyLossTracker;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  lossOffsetLifecycleCoordinator: LossOffsetLifecycleCoordinator;
  refreshGate: RefreshGate;
  lastState: LastState;
  trader: Trader;
  tradeLogHydrator: TradeLogHydrator;
  loadTradingDayRuntimeSnapshot: (
    params: LoadTradingDayRuntimeSnapshotParams,
  ) => Promise<LoadTradingDayRuntimeSnapshotResult>;
  marketMonitor: MarketMonitor;
  doomsdayProtection: DoomsdayProtection;
  signalProcessor: SignalProcessor;
  indicatorCache: IndicatorCache;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
}>;

/**
 * post-gate runtime 的可变监控上下文注册态。
 * 类型用途：仅在 app 装配阶段暴露 monitorContexts 的写能力，其余运行时消费方保持只读视图。
 * 数据来源：由 createPostGateRuntime 创建，并在 createMonitorContexts 阶段短暂使用。
 * 使用范围：仅 app 顶层装配链路使用。
 */
export type MutableMonitorContextsPostGateRuntime = Omit<PostGateRuntime, 'monitorContexts'> & {
  readonly monitorContexts: Map<string, MonitorContext>;
};

/**
 * 异步运行时对象。
 * 类型用途：集中表达顶层单次创建的异步处理器所有权。
 * 数据来源：由 createAsyncRuntime 创建。
 * 使用范围：仅 app 顶层装配与 cleanup/lifecycle 使用。
 */
export type AsyncRuntime = Readonly<{
  orderMonitorWorker: OrderMonitorWorker;
  postTradeRefresher: PostTradeRefresher;
  monitorTaskProcessor: MonitorTaskProcessor;
  buyProcessor: Processor;
  sellProcessor: Processor;
}>;

/**
 * 异步运行时工厂依赖。
 * 类型用途：封装 createAsyncRuntime 所需的 pre/post gate runtime。
 * 数据来源：由 app 顶层装配在 monitor context 完成后传入。
 * 使用范围：仅异步运行时创建链路使用。
 */
export type AsyncRuntimeFactoryDeps = Readonly<{
  preGateRuntime: PreGateRuntime;
  postGateRuntime: PostGateRuntime;
}>;

/**
 * 生命周期运行时工厂依赖。
 * 类型用途：封装 lifecycle cache domains 与 dayLifecycleManager 创建所需的共享依赖。
 * 数据来源：由 app 顶层装配在 async runtime 创建后传入。
 * 使用范围：仅 lifecycle 运行时创建链路使用。
 */
export type LifecycleRuntimeFactoryDeps = Readonly<{
  preGateRuntime: PreGateRuntime;
  postGateRuntime: PostGateRuntime;
  asyncRuntime: AsyncRuntime;
  rebuildTradingDayState: (params: RebuildTradingDayStateParams) => Promise<void>;
}>;

/**
 * app 主入口依赖集合。
 * 类型用途：为 createRunApp 显式注入装配链路依赖，避免隐藏模块状态并提升测试可验证性。
 * 数据来源：生产环境使用默认依赖对象，测试可注入受控替身。
 * 使用范围：仅 app 顶层入口装配与相关测试使用。
 */
export type RunAppDeps = Readonly<{
  getShushCow: () => void;
  createPreGateRuntime: (params: AppEnvironmentParams) => Promise<PreGateRuntime>;
  createPostGateRuntime: (
    params: CreatePostGateRuntimeParams,
  ) => Promise<MutableMonitorContextsPostGateRuntime>;
  loadStartupSnapshot: (params: LoadStartupSnapshotParams) => Promise<StartupSnapshotResult>;
  collectRuntimeValidationSymbols: (
    params: RuntimeValidationCollectionParams,
  ) => RuntimeValidationCollector;
  createMonitorContexts: (params: CreateMonitorContextsParams) => void;
  createRebuildTradingDayState: (
    deps: RebuildTradingDayStateDeps,
  ) => (params: RebuildTradingDayStateParams) => Promise<void>;
  displayAccountAndPositions: (params: DisplayAccountAndPositionsParams) => Promise<void>;
  registerDelayedSignalHandlers: (params: RegisterDelayedSignalHandlersParams) => void;
  createAsyncRuntime: (params: AsyncRuntimeFactoryDeps) => AsyncRuntime;
  createLifecycleRuntime: (
    params: LifecycleRuntimeFactoryDeps,
    factories?: LifecycleRuntimeFactories,
  ) => DayLifecycleManager;
  createCleanup: (context: CleanupContext) => CleanupController;
  mainProgram: (context: MainProgramContext) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  formatError: (error: unknown) => string;
  validateRuntimeSymbolsFromQuotesMap: (
    params: ValidateRuntimeSymbolsParams,
  ) => RuntimeSymbolValidationResult;
  applyStartupSnapshotFailureState: (lastState: LastState, now: Date) => void;
}>;

/**
 * 生命周期运行时工厂集合。
 * 类型用途：显式表达 cache domain 与 dayLifecycleManager 的创建依赖，便于装配测试复核接线路径。
 * 数据来源：生产环境使用默认工厂集合，测试可注入受控工厂。
 * 使用范围：仅 app 生命周期装配与相关测试使用。
 */
export type LifecycleRuntimeFactories = Readonly<{
  createSignalRuntimeDomain: (deps: SignalRuntimeDomainDeps) => CacheDomain;
  createMarketDataDomain: (deps: MarketDataDomainDeps) => CacheDomain;
  createSeatDomain: (deps: SeatDomainDeps) => CacheDomain;
  createOrderDomain: (deps: OrderDomainDeps) => CacheDomain;
  createRiskDomain: (deps: RiskDomainDeps) => CacheDomain;
  createGlobalStateDomain: (deps: GlobalStateDomainDeps) => CacheDomain;
  executeTradingDayOpenRebuild: (params: RunTradingDayOpenRebuildParams) => Promise<void>;
  createDayLifecycleManager: (deps: DayLifecycleManagerDeps) => DayLifecycleManager;
}>;

/**
 * 运行时标的校验器入参。
 * 类型用途：封装 validateRuntimeSymbolsFromQuotesMap 所需的校验输入与 quotes 快照。
 * 数据来源：由 app 顶层装配在 startup snapshot 后组装。
 * 使用范围：仅 app 顶层入口依赖声明与测试替身使用。
 */
type ValidateRuntimeSymbolsParams = Readonly<{
  inputs: ReadonlyArray<RuntimeSymbolValidationInput>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;
