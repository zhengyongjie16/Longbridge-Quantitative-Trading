/**
 * 行情数据客户端模块类型定义
 *
 */

import type { Config } from 'longport';

/**
 * 重试配置类型
 */
export type RetryConfig = {
  readonly retries: number;
  readonly delayMs: number;
};

// ==================== 依赖类型定义 ====================

/**
 * 交易日缓存依赖类型
 */
export type TradingDayCacheDeps = Record<string, never>;

/**
 * 行情数据客户端依赖类型
 */
export type MarketDataClientDeps = {
  readonly config?: Config | null;
  /** 需要订阅的标的列表（WebSocket 订阅模式必须提供） */
  readonly symbols: ReadonlyArray<string>;
};

