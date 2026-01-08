/**
 * 行情数据客户端模块类型定义
 *
 */

import type { Config } from 'longport';
import type { TradingDayInfo } from '../../types/index.js';

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

