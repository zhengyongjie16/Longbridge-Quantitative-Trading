import type { IndicatorSnapshot } from '../../types/quote.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { MarketDataClient } from '../../types/services.js';

/**
 * monitor indicator 显示 route 状态。
 * 类型用途：维护单 monitor route 的 single-flight、dirty collapse 与最新指标快照。
 * 数据来源：由 monitorDisplayRuntime.requestRender 写入。
 * 使用范围：仅 monitorDisplayRuntime 模块内部使用。
 */
export type MonitorDisplayRouteState = {
  inFlight: boolean;
  dirty: boolean;
  latestMonitorSnapshot: IndicatorSnapshot | null;
};

/**
 * monitor indicator 显示 runtime 契约。
 * 类型用途：统一 monitor indicator 显示 owner 的启停与渲染请求能力。
 * 数据来源：由 createMonitorDisplayRuntime 创建。
 * 使用范围：app 装配、lifecycle、cleanup 与 businessEventProgram 使用。
 */
export interface MonitorDisplayRuntime {
  readonly start: () => void;
  readonly requestRender: (params: {
    readonly monitorSymbol: string;
    readonly monitorSnapshot: IndicatorSnapshot;
  }) => void;
  readonly stopAndDrain: () => Promise<void>;
}

/**
 * monitor indicator 显示 runtime 依赖。
 * 类型用途：封装 createMonitorDisplayRuntime 所需的行情读取、上下文与纯渲染端口。
 * 数据来源：由 app 顶层装配注入。
 * 使用范围：仅 monitorDisplayRuntime 模块使用。
 */
export type MonitorDisplayRuntimeDeps = Readonly<{
  marketDataClient: Pick<MarketDataClient, 'getQuotes' | 'getCandlestickSnapshot'>;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  lastState: Pick<LastState, 'isTradingEnabled' | 'canTrade'>;
  marketMonitor: {
    readonly renderMonitorIndicators: (params: {
      readonly monitorSymbol: string;
      readonly monitorSnapshot: IndicatorSnapshot;
      readonly monitorQuote: Awaited<ReturnType<MarketDataClient['getQuotes']>> extends Map<
        string,
        infer TValue
      >
        ? TValue
        : never;
      readonly indicatorProfile: MonitorContext['indicatorProfile'];
      readonly klineTimestamp: ReturnType<
        NonNullable<MarketDataClient['getCandlestickSnapshot']>
      > extends { readonly lastBarTimestamp: infer TValue }
        ? TValue
        : number | null;
    }) => void;
  };
}>;
