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

/**
 * 静态信息类型（来自 LongPort API）
 * 包含标的的基本信息，如名称和交易单位
 */
export type StaticInfo = {
  readonly nameHk?: string | null;
  readonly nameCn?: string | null;
  readonly nameEn?: string | null;
  readonly lotSize?: number | null;
  readonly lot_size?: number | null;
  readonly lot?: number | null;
};

/**
 * 从静态信息中安全提取 lotSize
 * @param staticInfo 静态信息对象
 * @returns lotSize 值，如果无效则返回 undefined
 */
export const extractLotSize = (staticInfo: unknown): number | undefined => {
  if (!staticInfo || typeof staticInfo !== 'object') {
    return undefined;
  }

  const info = staticInfo as StaticInfo;
  const lotSizeValue = info.lotSize ?? info.lot_size ?? info.lot ?? null;

  if (lotSizeValue === null || lotSizeValue === undefined) {
    return undefined;
  }

  const parsed = Number(lotSizeValue);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return undefined;
};

/**
 * 从静态信息中安全提取名称
 * @param staticInfo 静态信息对象
 * @returns 名称，优先返回香港名称，其次中文名称，最后英文名称
 */
export const extractName = (staticInfo: unknown): string | null => {
  if (!staticInfo || typeof staticInfo !== 'object') {
    return null;
  }

  const info = staticInfo as StaticInfo;
  return info.nameHk ?? info.nameCn ?? info.nameEn ?? null;
};

