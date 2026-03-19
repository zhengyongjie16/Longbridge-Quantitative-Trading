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
 * 行情数据客户端工厂的依赖注入参数。
 * 类型用途：供 createMarketDataClient 初始化 QuoteContext。
 * 数据来源：由主程序传入 Longbridge Config。
 * 使用范围：仅 quoteClient 模块使用。
 */
export type RealtimeQuoteLike = Readonly<{
  readonly symbol: string;
  readonly lastDone: { readonly toNumber: () => number } | number | string | null | undefined;
  readonly timestamp?: Date | null;
}>;

export type SeedQuoteLike = Readonly<{
  readonly symbol: string;
  readonly prevClose: { readonly toNumber: () => number } | number | string | null | undefined;
}>;

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

export type NaiveDateLike = Readonly<{
  readonly toString: () => string;
}>;

export interface QuoteContextLike {
  readonly quote: (symbols: string[]) => Promise<SeedQuoteLike[]>;
  readonly staticInfo: (symbols: string[]) => Promise<QuoteStaticInfoLike[]>;
  readonly subscribe: (symbols: string[], subTypes: number[]) => Promise<void>;
  readonly unsubscribe: (symbols: string[], subTypes: number[]) => Promise<void>;
  readonly realtimeQuote: (symbols: string[]) => Promise<RealtimeQuoteLike[]>;
  readonly subscribeCandlesticks: (
    symbol: string,
    period: Period,
    tradeSessions?: TradeSessions,
  ) => Promise<Candlestick[]>;
  readonly unsubscribeCandlesticks: (symbol: string, period: Period) => Promise<void>;
  readonly realtimeCandlesticks: (
    symbol: string,
    period: Period,
    count: number,
  ) => Promise<Candlestick[]>;
  readonly tradingDays: (
    market: Market,
    begin: unknown,
    end: unknown,
  ) => Promise<{
    readonly tradingDays: ReadonlyArray<NaiveDateLike>;
    readonly halfTradingDays: ReadonlyArray<NaiveDateLike>;
  }>;
}

export type MarketDataClientDeps = {
  readonly config: Config;
  readonly quoteContextFactory?: (config: Config) => Promise<QuoteContextLike>;
};
