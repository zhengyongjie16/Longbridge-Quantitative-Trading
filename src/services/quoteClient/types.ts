import type { Candlestick, Config, Market, Period, TradeSessions } from 'longbridge';

/**
 * withRetry 重试配置。
 * 类型用途：控制 API 调用的重试次数与间隔，作为 withRetry 的参数。
 * 使用范围：仅 quoteClient 模块内部使用。
 * 数据来源：由当前模块的入参、返回值或运行时派生数据提供（如适用）。
 */
export type RetryConfig = {
  readonly retries: number;
  readonly delayMs: number;
};

/**
 * Longbridge 静态信息结构。
 * 类型用途：提取标的名称与每手股数，供行情缓存组装使用。
 * 数据来源：Longbridge staticInfo API 返回值的结构映射。
 * 使用范围：仅 quoteClient 模块内部使用。
 */
export type StaticInfo = {
  readonly nameHk?: string | null;
  readonly nameCn?: string | null;
  readonly nameEn?: string | null;
  readonly lotSize?: number | null;
};

/**
 * 实时行情最小结构。
 * 类型用途：抽象 QuoteContext.realtimeQuote 返回项中 quoteClient 实际消费的字段子集。
 * 数据来源：Longbridge realtimeQuote 返回值。
 * 使用范围：quoteClient 模块内部使用。
 */
export type RealtimeQuoteLike = Readonly<{
  readonly symbol: string;
  readonly lastDone: { readonly toNumber: () => number } | number | string | null | undefined;
  readonly timestamp?: Date | null;
}>;

/**
 * 初始昨收价最小结构。
 * 类型用途：抽象 QuoteContext.quote 返回项中 prevClose 初始化所需字段。
 * 数据来源：Longbridge quote 返回值。
 * 使用范围：quoteClient 模块内部使用。
 */
export type SeedQuoteLike = Readonly<{
  readonly symbol: string;
  readonly prevClose: { readonly toNumber: () => number } | number | string | null | undefined;
}>;

/**
 * 标的静态信息最小结构。
 * 类型用途：抽象 QuoteContext.staticInfo 返回项中名称、手数与轮证扩展字段。
 * 数据来源：Longbridge staticInfo 返回值。
 * 使用范围：quoteClient 模块内部使用。
 */
export type QuoteStaticInfoLike = Readonly<{
  readonly symbol: string;
  readonly nameHk?: string | null;
  readonly nameCn?: string | null;
  readonly nameEn?: string | null;
  readonly lotSize?: number | null;
  readonly callPrice?: number | null;
  readonly expiryDate?: string | null;
  readonly issuePrice?: number | null;
  readonly conversionRatio?: number | null;
  readonly warrantType?: 'BULL' | 'BEAR' | null;
  readonly underlyingSymbol?: string | null;
}>;

/**
 * 交易日接口日期对象最小结构。
 * 类型用途：抽象交易日 API 返回值中的日期对象，仅保留 toString 转换能力。
 * 数据来源：Longbridge tradingDays 返回值中的 NaiveDate。
 * 使用范围：quoteClient 模块内部使用。
 */
export type NaiveDateLike = Readonly<{
  readonly toString: () => string;
}>;

/**
 * K 线 push 数据结构（最小语义子集）。
 * 类型用途：抽象 QuoteContext.setOnCandlestick 的 push data 数据形态。
 * 数据来源：Longbridge PushCandlestickEvent.data。
 * 使用范围：quoteClient 模块内部使用。
 */
export type PushCandlestickLike = Readonly<{
  readonly period: Period;
  readonly candlestick: Candlestick;
  readonly isConfirmed: boolean;
}>;

/**
 * K 线 push 事件结构（最小语义子集）。
 * 类型用途：抽象 QuoteContext.setOnCandlestick 的事件形态。
 * 数据来源：Longbridge PushCandlestickEvent。
 * 使用范围：quoteClient 模块内部使用。
 */
export type PushCandlestickEventLike = Readonly<{
  readonly symbol: string;
  readonly data: PushCandlestickLike;
}>;

/**
 * QuoteContext 最小契约。
 * 类型用途：约束 quoteClient 对 Longbridge QuoteContext 的依赖边界，便于测试替身注入与类型校验。
 * 数据来源：Longbridge QuoteContext API 能力映射。
 * 使用范围：quoteClient 模块内部使用。
 */
export interface QuoteContextLike {
  readonly quote: (symbols: string[]) => Promise<ReadonlyArray<unknown>>;
  readonly staticInfo: (symbols: string[]) => Promise<ReadonlyArray<unknown>>;
  readonly subscribe: (symbols: string[], subTypes: number[]) => Promise<void>;
  readonly unsubscribe: (symbols: string[], subTypes: number[]) => Promise<void>;
  readonly realtimeQuote: (symbols: string[]) => Promise<ReadonlyArray<unknown>>;
  readonly subscribeCandlesticks: (
    symbol: string,
    period: Period,
    tradeSessions?: TradeSessions,
  ) => Promise<ReadonlyArray<unknown>>;
  readonly unsubscribeCandlesticks: (symbol: string, period: Period) => Promise<void>;
  readonly realtimeCandlesticks: (
    symbol: string,
    period: Period,
    count: number,
  ) => Promise<ReadonlyArray<unknown>>;
  readonly setOnCandlestick: (
    callback: (err: null | Error, event: PushCandlestickEventLike) => void,
  ) => void;
  readonly tradingDays: (
    market: Market,
    begin: unknown,
    end: unknown,
  ) => Promise<{
    readonly tradingDays: ReadonlyArray<unknown>;
    readonly halfTradingDays: ReadonlyArray<unknown>;
  }>;
}

/**
 * 行情数据客户端工厂依赖。
 * 类型用途：供 createMarketDataClient 注入 SDK Config 与可替换的 QuoteContext factory。
 * 数据来源：主程序或测试替身注入。
 * 使用范围：quoteClient 模块内部使用。
 */
export type MarketDataClientDeps = {
  readonly config: Config;
  readonly quoteContextFactory?: (config: Config) => Promise<QuoteContextLike>;
};
