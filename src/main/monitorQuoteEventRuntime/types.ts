import type { MonitorContext, LastState } from '../../types/state.js';
import type {
  MarketDataClient,
  PostTradeConsistencyFreshnessPort,
  Trader,
} from '../../types/services.js';
import type { SwitchDriveResult } from '../../types/monitorContextPorts.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { QuoteSubscriptionRuntime } from '../quoteSubscriptionRuntime/types.js';

/**
 * Monitor quote freshness 状态快照。
 * 类型用途：描述 runtime 判断 baseline 与 freshness 门禁所需的最小状态。
 * 数据来源：由 postTradeConsistencyRuntime.getStatus 返回。
 * 使用范围：monitorQuoteEventRuntime 模块内部依赖与相关测试使用。
 */
export type MonitorQuoteFreshnessStatus = Readonly<{
  /** freshness runtime 是否已经启动 */
  started: boolean;

  /** 当前已追平版本 */
  currentVersion: number;

  /** 当前待追平版本 */
  staleVersion: number;
}>;

/**
 * Monitor quote freshness 依赖。
 * 类型用途：收口 monitor quote runtime 与 switch wakeup runtime 共用的 freshness 等待依赖。
 * 数据来源：由 app 层 postTradeConsistencyRuntime 实现并注入。
 * 使用范围：monitorQuoteEventRuntime 模块内部依赖与相关测试使用。
 */
export type MonitorQuoteFreshnessDeps = Readonly<{
  /** 等待 freshness 追平 */
  waitForFresh: PostTradeConsistencyFreshnessPort['waitForFresh'];

  /** 读取 freshness 状态快照 */
  getStatus: () => MonitorQuoteFreshnessStatus;

  /** 订阅 freshness 追平事件；monitor quote runtime 可不订阅 */
  onFreshReached?: PostTradeConsistencyFreshnessPort['onFreshReached'];
}>;

/**
 * Switch wakeup freshness 依赖。
 * 类型用途：收口 switch wakeup runtime 所需的 freshness 等待与事件订阅依赖。
 * 数据来源：由 app 层 postTradeConsistencyRuntime 实现并注入。
 * 使用范围：switchWakeupRuntime 模块内部依赖使用。
 */
export type SwitchWakeupFreshnessDeps = Readonly<{
  /** 等待 freshness 追平 */
  waitForFresh: PostTradeConsistencyFreshnessPort['waitForFresh'];

  /** 读取 freshness 状态快照 */
  getStatus: () => MonitorQuoteFreshnessStatus;

  /** 订阅 freshness 追平事件 */
  onFreshReached: PostTradeConsistencyFreshnessPort['onFreshReached'];
}>;

/**
 * Switch wakeup route key。
 * 类型用途：以 monitorSymbol + direction + seatVersion 唯一标识一条 pending switch 推进链，支撑 single-flight 与旧版本自然失效。
 * 数据来源：由 SwitchWakeupRuntime 在 handoffPendingSwitch 时构造。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type SwitchWakeupRouteKey = `${string}:${'LONG' | 'SHORT'}:${number}`;

/**
 * Switch wakeup route。
 * 类型用途：描述当前 runtime 持有的一条 pending switch 权威路由身份。
 * 数据来源：由 handoffPendingSwitch 参数与 monitorContexts 权威快照组合得到。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type SwitchWakeupRoute = Readonly<{
  /** 路由键 */
  routeKey: SwitchWakeupRouteKey;

  /** 监控标的 */
  monitorSymbol: string;

  /** 方向 */
  direction: 'LONG' | 'SHORT';

  /** 席位版本 */
  seatVersion: number;

  /** 当前 monitor context */
  monitorContext: MonitorContext;
}>;

/**
 * 单 route 的执行收敛状态。
 * 类型用途：维护 single-flight、latest-only collapse 与显式 wakeup 注册状态。
 * 数据来源：由 SwitchWakeupRuntime 在运行期维护。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type SwitchWakeupRouteState = {
  /** 当前路由快照 */
  route: SwitchWakeupRoute;

  /** 是否已有推进执行在途 */
  inFlight: boolean;

  /** 是否在在途期间又收到新的 wakeup */
  dirty: boolean;

  /** 当前 route 生效中的显式 wakeups */
  wakeups: ReadonlyArray<Extract<SwitchDriveResult, { kind: 'WAIT' }>['wakeups'][number]>;

  /** 当前 route 的 retry timer 句柄 */
  retryTimerHandle: ReturnType<typeof setTimeout> | null;

  /** 当前 route 为 SYMBOL_QUOTE wakeup 显式保留的标的集合 */
  retainedQuoteSymbols: ReadonlySet<string>;
};

/**
 * SwitchWakeupRuntime handoff 参数。
 * 类型用途：把事件驱动 owner 拿到的 pending switch driveResult 交给 runtime 接管后续推进。
 * 数据来源：由 monitor quote runtime 或 AUTO_SYMBOL_TICK 等现有 owner 在拿到 driveResult 后传入。
 * 使用范围：仅 app/main 顶层事件接线与相关测试使用。
 */
export type SwitchWakeupHandoffParams = Readonly<{
  /** 监控标的 */
  monitorSymbol: string;

  /** 方向 */
  direction: 'LONG' | 'SHORT';

  /** 发起 handoff 时的权威 monitor context */
  monitorContext: MonitorContext;

  /** 本轮单步推进结果 */
  driveResult: SwitchDriveResult;
}>;

/**
 * Switch wakeup runtime 依赖。
 * 类型用途：创建 runtime 所需的事件源、权威快照读取依赖与 timer 能力。
 * 数据来源：由 app post-gate runtime 统一组装并注入。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type SwitchWakeupRuntimeDeps = Readonly<{
  /** 行情事件源 */
  marketDataClient: Pick<MarketDataClient, 'onQuoteUpdated'>;

  /** 订单事件源 */
  trader: Pick<Trader, 'onOrderStateChanged'>;

  /** 权威席位注册表 */
  symbolRegistry: SymbolRegistry;

  /** 全量 monitor contexts */
  monitorContexts: ReadonlyMap<string, MonitorContext>;

  /** 全局运行时状态 */
  lastState: Pick<LastState, 'canTrade' | 'isTradingEnabled' | 'isHalfDay' | 'cachedPositions'>;

  /** 成交后一致性 freshness 端口 */
  postTradeConsistencyRuntime: SwitchWakeupFreshnessDeps;

  /** quote 订阅 retain 端口 */
  quoteSubscriptionRuntime?: Pick<QuoteSubscriptionRuntime, 'retainSymbols' | 'releaseRetain'>;

  /** 是否启用末日保护 5 分钟接管门禁 */
  doomsdayProtectionEnabled: boolean;

  /** 当前时间源 */
  now: () => Date;

  /** 安排 retry timer */
  scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

  /** 清理 retry timer */
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}>;

/**
 * 静态距回收价清仓执行结果。
 * 类型用途：表达 monitor quote 驱动静态清仓的一次执行结果，以及 WAIT 场景下的显式唤醒注册信息。
 * 数据来源：由 staticLiquidationExecutor 在单次执行结束时返回。
 * 使用范围：monitorQuoteEventRuntime 及相关测试使用。
 */
export type StaticLiquidationRuntimeResult =
  | Readonly<{
      kind: 'NOOP';
    }>
  | Readonly<{
      kind: 'COMPLETED';
    }>
  | Readonly<{
      kind: 'WAIT';
      wakeupSymbols: ReadonlyArray<string>;
      retryAtMs: number | null;
    }>;

/**
 * Monitor quote 事件运行时行为契约。
 * 类型用途：统一拥有 monitor quote 驱动执行与生命周期启停能力。
 * 数据来源：由 createMonitorQuoteEventRuntime 创建。
 * 使用范围：app cleanup、lifecycle 与相关测试使用。
 */
export interface MonitorQuoteEventRuntime {
  /** 启动事件监听。 */
  start: () => void;

  /** 停止监听并等待所有在途执行完成。 */
  stopAndDrain: () => Promise<void>;
}

/**
 * Switch wakeup runtime 行为契约。
 * 类型用途：统一拥有 pending switch 的事件驱动推进与生命周期启停能力。
 * 数据来源：由 createSwitchWakeupRuntime 创建。
 * 使用范围：app cleanup、lifecycle、monitorTaskProcessor 与相关测试使用。
 */
export interface SwitchWakeupRuntime {
  /** 启动事件监听。 */
  start: () => void;

  /** 停止监听并等待所有在途推进完成。 */
  stopAndDrain: () => Promise<void>;

  /** 把已有 pending switch 的显式 wakeups 交给 runtime 接管。 */
  handoffPendingSwitch: (params: SwitchWakeupHandoffParams) => void;
}
