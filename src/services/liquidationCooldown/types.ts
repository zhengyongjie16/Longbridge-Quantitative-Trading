import type { LiquidationCooldownConfig, MultiMonitorTradingConfig } from '../../types/config.js';
import type { SeatSymbolSnapshotEntry } from '../../types/seat.js';
import type { Logger } from '../../utils/logger/types.js';

/** 未解析的日志记录（键值对），来源于日志文件逐行解析，仅在 liquidationCooldown 模块内部使用。 */
export type RawRecord = {
  readonly [key: string]: unknown;
};

/**
 * 记录清仓冷却的参数，包含标的代码、方向与保护性清仓成交时间戳。
 * 由 LiquidationCooldownTracker.recordCooldown 消费。
 */
export type RecordCooldownParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly executedTimeMs: number;
};

/**
 * 查询剩余冷却时间的参数，包含标的代码、方向与冷却配置。
 * 由 LiquidationCooldownTracker.getRemainingMs 消费。
 */
export type GetRemainingMsParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly cooldownConfig: LiquidationCooldownConfig | null;
};

/**
 * 冷却追踪器依赖注入参数，包含当前时间获取函数。
 * 由 createLiquidationCooldownTracker 工厂函数消费。
 */
export type LiquidationCooldownTrackerDeps = {
  readonly nowMs: () => number;
};

/**
 * 午夜按策略清理的参数，包含需要清除的冷却键集合。
 * 仅清理属于 half-day / one-day 模式的条目，minutes 模式保留由其自然过期。
 * 由 LiquidationCooldownTracker.clearMidnightEligible 消费。
 */
export type ClearMidnightEligibleParams = {
  readonly keysToClear: ReadonlySet<string>;
};

/**
 * 冷却追踪器接口，提供记录冷却、查询剩余时间与跨日清理方法。
 * 由 createLiquidationCooldownTracker 实现，供风控模块消费。
 */
export interface LiquidationCooldownTracker {
  recordCooldown(params: RecordCooldownParams): void;
  getRemainingMs(params: GetRemainingMsParams): number;
  /** 跨日午夜按策略清理：仅清除指定 keys，minutes 模式条目不受影响 */
  clearMidnightEligible(params: ClearMidnightEligibleParams): void;
}

/**
 * 交易日志水化器的依赖注入参数，包含文件读取、当前时间与冷却追踪器。
 * 由 createTradeLogHydrator 工厂函数消费，仅在 liquidationCooldown 模块内部使用。
 */
export type TradeLogHydratorDeps = {
  readonly readFileSync: (path: string, encoding: BufferEncoding) => string;
  readonly existsSync: (path: string) => boolean;
  readonly cwd: () => string;
  readonly nowMs: () => number;
  readonly logger: Logger;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
};

/**
 * 交易日志水化器接口，负责从历史成交日志中恢复冷却状态。
 * 由 createTradeLogHydrator 实现，在程序启动时调用一次。
 */
export interface TradeLogHydrator {
  hydrate(params: { readonly seatSymbols: ReadonlyArray<SeatSymbolSnapshotEntry> }): void;
}

/**
 * 冷却候选记录，包含监控标的、方向与保护性清仓成交时间。
 * 由 resolveCooldownCandidatesBySeat 返回，供冷却追踪器恢复状态使用。
 */
export type CooldownCandidate = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly executedAtMs: number;
};
