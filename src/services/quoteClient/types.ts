import type { Config } from 'longport';

/**
 * withRetry 重试配置
 * 用途：控制 API 调用的重试次数与间隔
 * 仅 quoteClient 内部使用
 */
export type RetryConfig = {
  readonly retries: number;
  readonly delayMs: number;
};

/**
 * LongPort 静态信息结构
 * 数据来源：LongPort staticInfo API 返回值的结构映射
 * 用途：提取标的名称与每手股数，供行情缓存组装使用
 * 仅 quoteClient 内部使用
 */
export type StaticInfo = {
  readonly nameHk?: string | null;
  readonly nameCn?: string | null;
  readonly nameEn?: string | null;
  readonly lotSize?: number | null;
};

/**
 * createMarketDataClient 依赖注入参数
 * 用途：传入 LongPort Config 以初始化 QuoteContext
 */
export type MarketDataClientDeps = {
  readonly config: Config;
};
