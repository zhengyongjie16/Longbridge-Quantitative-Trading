/**
 * 行情数据客户端模块类型定义
 *
 */

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

