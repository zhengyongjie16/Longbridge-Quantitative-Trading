import type { MonitorContext, LastState } from '../../types/state.js';
import type { MarketDataClient, QuoteUpdatedEvent, Trader } from '../../types/services.js';
import type { SymbolRegistry } from '../../types/seat.js';

/**
 * 风险路由键。
 * 类型用途：以 monitorSymbol + direction 作为单条风险执行链的唯一键，支撑 single-flight 与 latest-only collapse。
 * 数据来源：由 routing index 构建流程生成。
 * 使用范围：仅 tradingRiskEventRuntime 模块内部使用。
 */
export type TradingRiskRouteKey = `${string}:${'LONG' | 'SHORT'}`;

/**
 * 风险路由条目。
 * 类型用途：表示某个 tradingSymbol 当前应路由到的 monitorSymbol / direction / seatVersion。
 * 数据来源：由 symbolRegistry 的权威快照重建。
 * 使用范围：仅 tradingRiskEventRuntime 模块内部使用。
 */
export type TradingRiskRoute = Readonly<{
  readonly routeKey: TradingRiskRouteKey;
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly tradingSymbol: string;
  readonly seatVersion: number;
  readonly monitorContext: MonitorContext;
}>;

/**
 * 风险路由索引。
 * 类型用途：把 tradingSymbol 唯一映射到当前路由条目，并同时保留按 routeKey 的索引。
 * 数据来源：由 tradingRiskEventRuntime 在启动与事件处理过程中基于 symbolRegistry 权威快照重建。
 * 使用范围：仅 tradingRiskEventRuntime 模块内部使用。
 */
export type TradingRiskRoutingIndex = Readonly<{
  readonly routesBySymbol: ReadonlyMap<string, TradingRiskRoute>;
  readonly routesByKey: ReadonlyMap<string, TradingRiskRoute>;
}>;

/**
 * 单 route 的执行收敛状态。
 * 类型用途：维护 latest-only collapse 所需的 in-flight、dirty 与 latest event。
 * 数据来源：由 TradingRiskEventRuntime 在运行期维护。
 * 使用范围：仅 tradingRiskEventRuntime 模块内部使用。
 */
export type RouteExecutionState = {
  inFlight: boolean;
  dirty: boolean;
  latestRoute: TradingRiskRoute | null;
  latestEvent: QuoteUpdatedEvent | null;
};

/**
 * 成交后一致性 runtime 的最小门禁状态。
 * 类型用途：TradingRiskEventRuntime 判断 baseline / freshness 是否已经准备好执行风险链路。
 * 数据来源：由 postTradeConsistencyRuntime.getStatus() 提供。
 * 使用范围：仅 tradingRiskEventRuntime 模块内部使用。
 */
export type TradingRiskConsistencyStatus = Readonly<{
  readonly started: boolean;
  readonly currentVersion: number;
  readonly staleVersion: number;
}>;

/**
 * 成交后一致性 runtime 的最小端口。
 * 类型用途：为 TradingRiskEventRuntime 提供 freshness 等待与 baseline 状态查询能力。
 * 数据来源：由 app 层成交后一致性 runtime 实现并注入。
 * 使用范围：仅 tradingRiskEventRuntime 模块内部使用。
 */
export interface TradingRiskConsistencyPort {
  /** 等待当前 freshness 追平 staleVersion。 */
  waitForFresh: () => Promise<void>;

  /** 获取当前 runtime 的 baseline / freshness 状态。 */
  getStatus: () => TradingRiskConsistencyStatus;
}

/**
 * 风险运行时依赖。
 * 类型用途：创建 TradingRiskEventRuntime 所需的外部依赖，包含行情、席位、baseline 与交易执行依赖。
 * 数据来源：由上层组装后注入。
 * 使用范围：仅 tradingRiskEventRuntime 模块内部使用。
 */
export type TradingRiskEventRuntimeDeps = Readonly<{
  readonly marketDataClient: Pick<MarketDataClient, 'onQuoteUpdated'>;
  readonly trader: Trader;
  readonly symbolRegistry: SymbolRegistry;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly lastState: Pick<LastState, 'canTrade' | 'isTradingEnabled' | 'isHalfDay'>;
  readonly postTradeConsistencyRuntime: TradingRiskConsistencyPort;
  readonly doomsdayProtectionEnabled: boolean;
  readonly now: () => Date;
}>;

/**
 * 风险运行时接口。
 * 类型用途：TradingRiskEventRuntime 的公开行为契约，负责启动 quote 订阅与优雅停机。
 * 数据来源：由 createTradingRiskEventRuntime 返回。
 * 使用范围：app lifecycle / cleanup / startup 装配使用。
 */
export interface TradingRiskEventRuntime {
  /** 启动 quote 监听并开始处理风险事件。 */
  start: () => void;

  /** 停止监听并等待当前 in-flight 风险执行完成；若存在 freshness wait，上层应先 abortWaiting 再调用。 */
  stopAndDrain: () => Promise<void>;
}
