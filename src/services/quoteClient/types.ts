import type { Candlestick, Config, Market, Period, TradeSessions } from 'longbridge';
import type { CandlestickCacheSnapshot } from '../../types/services.js';

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

/**
 * K 线缓存存储结构。
 * 类型用途：维护缓存快照映射与单 key 最大保留根数。
 * 数据来源：createCandlestickCacheStore 创建。
 * 使用范围：quoteClient 模块内部使用。
 */
export type CandlestickCacheStore = {
  readonly maxCandles: number;
  readonly snapshots: Map<string, CandlestickCacheSnapshot>;
};

/**
 * seed K 线序列参数。
 * 类型用途：订阅成功后将初始 K 线序列写入本地缓存。
 * 数据来源：subscribeCandlesticks 返回值。
 * 使用范围：quoteClient 模块内部使用。
 */
export type SeedCandlestickSeriesParams = {
  readonly store: CandlestickCacheStore;
  readonly symbol: string;
  readonly period: Period;
  readonly candles: ReadonlyArray<unknown>;
};

/**
 * push 更新参数。
 * 类型用途：处理 setOnCandlestick 推送事件并更新本地缓存。
 * 数据来源：QuoteContext candlestick push event。
 * 使用范围：quoteClient 模块内部使用。
 */
export type ApplyCandlestickPushParams = {
  readonly store: CandlestickCacheStore;
  readonly symbol: string;
  readonly period: Period;
  readonly candlestick: unknown;
  readonly isConfirmed: boolean;
};

/**
 * 标准化 K 线字段值。
 * 类型用途：约束缓存标准化过程中可保留的 K 线数值字段类型。
 * 数据来源：由原始 SDK K 线字段标准化得到。
 * 使用范围：仅 quoteClient/candlestickCache 内部使用。
 */
export type NormalizedCandleValue = number | string | null | undefined;
