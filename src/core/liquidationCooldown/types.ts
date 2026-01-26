/**
 * 清仓冷却模块类型定义
 *
 * 定义冷却追踪器所需的方向、入参和依赖类型。
 */

import type { LiquidationCooldownConfig } from '../../types/index.js';

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
