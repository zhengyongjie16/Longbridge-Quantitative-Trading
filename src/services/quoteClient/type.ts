/**
 * 行情数据客户端模块类型定义
 *
 */

import type { Config, QuoteContext, Candlestick, AdjustType, TradeSessions, Market } from 'longport';
import type { Quote, TradingDayInfo } from '../../types/index.js';

/**
 * 重试配置类型
 */
export type RetryConfig = {
  readonly retries: number;
  readonly delayMs: number;
};

/**
 * 缓存条目类型
 */
export type CacheEntry<T> = {
  readonly value: T;
  readonly ts: number;
};

/**
 * 交易日缓存条目类型
 */
export type TradingDayCacheEntry = {
  readonly isTradingDay: boolean;
  readonly isHalfDay: boolean;
  readonly timestamp: number;
};

/**
 * 交易日查询结果类型
 */
export type TradingDaysResult = {
  readonly tradingDays: ReadonlyArray<string>;
  readonly halfTradingDays: ReadonlyArray<string>;
};

/**
 * K线周期字符串类型
 */
export type PeriodString = '1m' | '5m' | '15m' | '1h' | '1d';

// ==================== 服务接口定义 ====================

/**
 * 行情缓存接口
 */
export interface QuoteCache<T> {
  get(key: string): T | null;
  set(key: string, value: T): void;
}

/**
 * 交易日缓存接口
 */
export interface TradingDayCache {
  get(dateStr: string): TradingDayInfo | null;
  set(dateStr: string, isTradingDay: boolean, isHalfDay?: boolean): void;
  setBatch(tradingDays: string[], halfTradingDays?: string[]): void;
}

/**
 * 行情数据客户端接口
 */
export interface MarketDataClient {
  _getContext(): Promise<QuoteContext>;
  getLatestQuote(symbol: string): Promise<Quote | null>;
  getCandlesticks(
    symbol: string,
    period?: PeriodString | import('longport').Period,
    count?: number,
    adjustType?: AdjustType,
    tradeSessions?: TradeSessions,
  ): Promise<Candlestick[]>;
  getTradingDays(startDate: Date, endDate: Date, market?: Market): Promise<TradingDaysResult>;
  isTradingDay(date: Date, market?: Market): Promise<TradingDayInfo>;
}

// ==================== 依赖类型定义 ====================

/**
 * 行情缓存依赖类型
 */
export type QuoteCacheDeps = {
  readonly ttlMs?: number;
};

/**
 * 交易日缓存依赖类型
 */
export type TradingDayCacheDeps = Record<string, never>;

/**
 * 行情数据客户端依赖类型
 */
export type MarketDataClientDeps = {
  readonly config?: Config | null;
};

