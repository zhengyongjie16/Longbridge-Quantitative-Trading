import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { LastState } from '../../types/state.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient, Trader, Unsubscribe } from '../../types/services.js';

/**
 * Quote 订阅保留原因。
 * 类型用途：表达运行期某个 symbol 当前必须保留 quote 订阅的业务来源。
 * 数据来源：monitor 配置、席位状态、持仓、订单保留集合与事件 runtime 临时 retain。
 * 使用范围：QuoteSubscriptionRuntime 内部状态与外部 retain API。
 */
export type QuoteSubscriptionRetainReason =
  | 'MONITOR_BASE'
  | 'SEAT_BOUND'
  | 'POSITION_HOLD'
  | 'ORDER_HOLD'
  | 'SWITCH_WAKEUP'
  | 'STATIC_LIQUIDATION_WAIT'
  | 'SEAT_REFRESH_WAIT';

/**
 * Quote 订阅 retain 注册参数。
 * 类型用途：表达某个 owner 对一组 symbol 的临时订阅保留请求。
 * 数据来源：SwitchWakeupRuntime、MonitorQuoteEventRuntime、SEAT_REFRESH handler。
 * 使用范围：QuoteSubscriptionRuntime.retainSymbols。
 */
export type QuoteSubscriptionRetainParams = Readonly<{
  ownerKey: string;
  reason: QuoteSubscriptionRetainReason;
  symbols: Iterable<string>;
}>;

/**
 * Quote 订阅 runtime 依赖。
 * 类型用途：创建 runtime 时注入权威状态读取、订阅 API 和事件源。
 * 数据来源：app runtime 装配层。
 * 使用范围：QuoteSubscriptionRuntime 工厂。
 */
export type QuoteSubscriptionRuntimeDeps = Readonly<{
  tradingConfig: MultiMonitorTradingConfig;
  symbolRegistry: SymbolRegistry;
  marketDataClient: Pick<MarketDataClient, 'subscribeSymbols' | 'unsubscribeSymbols'>;
  trader: Pick<Trader, 'getOrderHoldSymbols' | 'onOrderHoldSymbolsChanged'>;
  lastState: LastState;
}>;

/**
 * Quote 订阅 runtime。
 * 类型用途：稳态运行期 quote 订阅集合唯一 owner，向其他 runtime 暴露 retain 与 admission 能力。
 * 数据来源：由 createQuoteSubscriptionRuntime 创建。
 * 使用范围：app 装配、lifecycle、monitor task handler 与事件 runtime。
 */
export interface QuoteSubscriptionRuntime {
  readonly reconcileFromCurrentTruth: () => Promise<void>;
  readonly reconcilePositionHoldFromCurrentTruth: () => Promise<void>;
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly retainSymbols: (params: QuoteSubscriptionRetainParams) => Promise<Unsubscribe>;
  readonly releaseRetain: (
    params: Pick<QuoteSubscriptionRetainParams, 'ownerKey' | 'reason'>,
  ) => Promise<void>;
  readonly waitForAdmission: (symbols: ReadonlyArray<string>) => Promise<void>;
}
