import type { Config } from 'longport';

/**
 * withRetry 重试配置。
 * 类型用途：控制 API 调用的重试次数与间隔，作为 withRetry 的参数。
 * 使用范围：仅 quoteClient 模块内部使用。
 */
export type RetryConfig = {
  readonly retries: number;
  readonly delayMs: number;
};

/**
 * LongPort 静态信息结构。
 * 类型用途：提取标的名称与每手股数，供行情缓存组装使用。
 * 数据来源：LongPort staticInfo API 返回值的结构映射。
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
 * 数据来源：由主程序传入 LongPort Config。
 * 使用范围：仅 quoteClient 模块使用。
 */
export type MarketDataClientDeps = {
  readonly config: Config;
};
