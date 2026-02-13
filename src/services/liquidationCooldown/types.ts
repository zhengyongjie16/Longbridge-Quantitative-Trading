/**
 * 清仓冷却模块类型定义
 *
 * 定义冷却追踪器所需的方向、入参和依赖类型。
 */
import type { LiquidationCooldownConfig, MultiMonitorTradingConfig } from '../../types/config.js';
import type { SeatSymbolSnapshotEntry } from '../../types/seat.js';
import type { Logger } from '../../utils/logger/types.js';

/** 未解析的日志记录（键值对） */
export type RawRecord = {
  readonly [key: string]: unknown;
};

/**
 * 记录清仓冷却的参数
 */
export type RecordCooldownParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly executedTimeMs: number;
};

/**
 * 查询剩余冷却时间的参数
 */
export type GetRemainingMsParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly cooldownConfig: LiquidationCooldownConfig | null;
};

/**
 * 冷却追踪器依赖
 */
export type LiquidationCooldownTrackerDeps = {
  readonly nowMs: () => number;
};

/**
 * 午夜按策略清理的参数
 * 仅清理属于 half-day / one-day 模式的条目，minutes 模式保留由其自然过期
 */
export type ClearMidnightEligibleParams = {
  readonly keysToClear: ReadonlySet<string>;
};

/**
 * 冷却追踪器接口
 */
export interface LiquidationCooldownTracker {
  recordCooldown(params: RecordCooldownParams): void;
  getRemainingMs(params: GetRemainingMsParams): number;
  clear(): void;
  /** 跨日午夜按策略清理：仅清除指定 keys，minutes 模式条目不受影响 */
  clearMidnightEligible(params: ClearMidnightEligibleParams): void;
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
  hydrate(params: { readonly seatSymbols: ReadonlyArray<SeatSymbolSnapshotEntry> }): void;
}

export type CooldownCandidate = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly executedAtMs: number;
};
