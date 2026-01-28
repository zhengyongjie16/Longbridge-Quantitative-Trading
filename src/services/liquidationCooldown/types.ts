/**
 * 清仓冷却模块类型定义
 *
 * 定义冷却追踪器所需的方向、入参和依赖类型。
 */

import type { MultiMonitorTradingConfig, LiquidationCooldownConfig } from '../../types/index.js';
import type { TradeRecord } from '../../core/trader/types.js';
import type { Logger } from '../../utils/logger/types.js';

/**
 * 冷却方向（做多/做空）
 */
export type LiquidationDirection = 'LONG' | 'SHORT';

/**
 * 记录清仓冷却的参数
 */
export type RecordCooldownParams = {
  readonly symbol: string;
  readonly direction: LiquidationDirection;
  readonly executedTimeMs: number;
};

/**
 * 查询剩余冷却时间的参数
 */
export type GetRemainingMsParams = {
  readonly symbol: string;
  readonly direction: LiquidationDirection;
  readonly cooldownConfig: LiquidationCooldownConfig | null;
};

/**
 * 冷却追踪器依赖
 */
export type LiquidationCooldownTrackerDeps = {
  readonly nowMs: () => number;
};

/**
 * 冷却追踪器接口
 */
export interface LiquidationCooldownTracker {
  recordCooldown(params: RecordCooldownParams): void;
  getRemainingMs(params: GetRemainingMsParams): number;
}

export type TradeLogHydratorDeps = {
  readonly readFileSync: (path: string, encoding: BufferEncoding) => string;
  readonly existsSync: (path: string) => boolean;
  readonly cwd: () => string;
  readonly nowMs: () => number;
  readonly logger: Logger;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
};

export interface TradeLogHydrator {
  hydrate(): void;
}

export type NormalizedTradeRecord = {
  readonly record: TradeRecord;
  readonly direction: LiquidationDirection;
};
