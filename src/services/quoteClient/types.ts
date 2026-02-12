/**
 * 行情数据客户端模块类型定义
 *
 * 包含：RetryConfig、StaticInfo、MarketDataClientDeps
 */
import type { Config } from 'longport';

/**
 * 重试配置类型
 */
export type RetryConfig = {
  readonly retries: number;
  readonly delayMs: number;
};

/**
 * 静态信息类型（来自 LongPort API）
 * 包含标的的基本信息，如名称和交易单位
 * 仅内部使用
 */
export type StaticInfo = {
  readonly nameHk?: string | null;
  readonly nameCn?: string | null;
  readonly nameEn?: string | null;
  readonly lotSize?: number | null;
  readonly lot_size?: number | null;
  readonly lot?: number | null;
};

// ==================== 依赖类型定义 ====================

/**
 * 行情数据客户端依赖类型
 */
export type MarketDataClientDeps = {
  readonly config: Config;
};
