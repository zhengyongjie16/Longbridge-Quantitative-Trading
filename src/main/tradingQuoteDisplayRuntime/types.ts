import type { QuoteUpdatedEvent, MarketDataClient } from '../../types/services.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { TradingRiskRoute } from '../tradingRiskEventRuntime/types.js';

/**
 * trading quote 显示 route 状态。
 * 类型用途：维护单 route 的 single-flight、dirty collapse 与最新行情事件快照。
 * 数据来源：由 tradingQuoteDisplayRuntime 在 quote event 到达时写入。
 * 使用范围：仅 tradingQuoteDisplayRuntime 模块内部使用。
 */
export type TradingQuoteDisplayRouteState = {
  inFlight: boolean;
  dirty: boolean;
  latestEvent: QuoteUpdatedEvent | null;
  latestRoute: TradingRiskRoute | null;
};

/**
 * trading quote 显示 runtime 契约。
 * 类型用途：统一交易标的行情显示 owner 的启停能力。
 * 数据来源：由 createTradingQuoteDisplayRuntime 创建。
 * 使用范围：app 装配、lifecycle 与 cleanup 使用。
 */
export interface TradingQuoteDisplayRuntime {
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
}

/**
 * trading quote 显示 runtime 依赖。
 * 类型用途：封装 createTradingQuoteDisplayRuntime 所需的 quote 事件、席位映射与渲染端口。
 * 数据来源：由 app 顶层装配注入。
 * 使用范围：仅 tradingQuoteDisplayRuntime 模块使用。
 */
export type TradingQuoteDisplayRuntimeDeps = Readonly<{
  marketDataClient: Pick<MarketDataClient, 'onQuoteUpdated' | 'getQuotes'>;
  symbolRegistry: SymbolRegistry;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  lastState: Pick<LastState, 'isTradingEnabled' | 'canTrade'>;
  renderTradingQuote: (params: {
    readonly event: QuoteUpdatedEvent;
    readonly tradingSymbol: string;
    readonly monitorSymbol: string;
    readonly direction: 'LONG' | 'SHORT';
    readonly monitorQuote: Awaited<ReturnType<MarketDataClient['getQuotes']>> extends Map<
      string,
      infer TValue
    >
      ? TValue
      : never;
  }) => void;
}>;
