import type { LiquidationCooldownConfig, MultiMonitorTradingConfig } from '../../types/config.js';
import type { Logger } from '../../utils/logger/types.js';

/**
 * 未解析的日志记录。
 * 类型用途：用于日志文件逐行解析后的中间结构；数据来源为日志文件解析；仅 liquidationCooldown 模块内部使用。
 */
export type RawRecord = {
  readonly [key: string]: unknown;
};

/**
 * 记录清仓冷却的参数。
 * 类型用途：包含标的代码、方向与保护性清仓成交时间戳，由 recordCooldown 消费。
 * 数据来源：由 tradeLogHydrator 在启动恢复时传入。
 * 使用范围：仅 liquidationCooldown 模块使用。
 */
export type RecordCooldownParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly executedTimeMs: number;
};

/**
 * 记录保护性清仓触发的参数。
 * 类型用途：包含标的代码、方向、成交时间与触发上限，由 recordLiquidationTrigger 消费。
 * 数据来源：由 eventFlow 在保护性清仓成交后传入。
 * 使用范围：仅 liquidationCooldown 模块使用。
 */
export type RecordLiquidationTriggerParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly executedTimeMs: number;
  readonly triggerLimit: number;
  readonly cooldownConfig: LiquidationCooldownConfig | null;
};

/**
 * 记录保护性清仓触发的返回结果。
 * 类型用途：告知调用方当前触发是否导致了买入冷却激活。
 * 数据来源：由 recordLiquidationTrigger 返回。
 * 使用范围：仅 liquidationCooldown 模块使用。
 */
export type RecordLiquidationTriggerResult = {
  /** 当前累计触发次数（含本次） */
  readonly currentCount: number;

  /** 本次触发是否导致了买入冷却激活 */
  readonly cooldownActivated: boolean;
};

/**
 * 恢复触发计数器的参数。
 * 类型用途：启动恢复时将模拟得到的当前周期计数写入追踪器。
 * 数据来源：由 tradeLogHydrator 传入。
 * 使用范围：仅 liquidationCooldown 模块使用。
 */
export type RestoreTriggerCountParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly count: number;
};

/**
 * 查询剩余冷却时间的参数。
 * 类型用途：包含标的代码、方向与冷却配置，由 getRemainingMs 消费。
 * 数据来源：由风控模块在判断是否允许买入前传入。
 * 使用范围：仅 liquidationCooldown 模块使用。
 */
export type GetRemainingMsParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly cooldownConfig: LiquidationCooldownConfig | null;

  /** 可选参考时间戳（毫秒）；未提供时使用追踪器注入的 nowMs() */
  readonly currentTimeMs?: number;
};

/**
 * 冷却追踪器工厂的依赖注入参数。
 * 类型用途：包含当前时间获取函数，供 createLiquidationCooldownTracker 消费。
 * 使用范围：仅 liquidationCooldown 模块使用。
 */
export type LiquidationCooldownTrackerDeps = {
  readonly nowMs: () => number;
};

/**
 * 午夜按策略清理的参数。
 * 类型用途：包含需要清除的冷却键集合，由 clearMidnightEligible 消费；仅清理 half-day/one-day 模式条目。
 * 使用范围：仅 liquidationCooldown 模块使用。
 */
export type ClearMidnightEligibleParams = {
  readonly keysToClear: ReadonlySet<string>;
};

/**
 * 冷却追踪器接口，提供触发记录、冷却记录、剩余时间查询与跨日清理能力。
 * 由 createLiquidationCooldownTracker 实现，供风控模块消费。
 */
export interface LiquidationCooldownTracker {
  /**
   * 记录保护性清仓触发事件。
   * 内部累加触发计数器，当计数达到 triggerLimit 时写入冷却记录。
   */
  recordLiquidationTrigger: (
    params: RecordLiquidationTriggerParams,
  ) => RecordLiquidationTriggerResult;

  /** 直接写入冷却时间戳（仅供 tradeLogHydrator 启动恢复使用） */
  recordCooldown: (params: RecordCooldownParams) => void;

  /** 恢复触发计数器（启动恢复专用） */
  restoreTriggerCount: (params: RestoreTriggerCountParams) => void;

  /** 纯查询：返回剩余冷却毫秒数，不产生清理副作用 */
  getRemainingMs: (params: GetRemainingMsParams) => number;

  /**
   * 扫描并消费所有已过期的冷却条目，返回过期事件列表。
   * 过期条目从内部 map 中移除（幂等：同一条目只产出一次事件）。
   * 由 lossOffsetLifecycleCoordinator 在每轮 tick 前调用。
   */
  sweepExpired: (params: SweepExpiredParams) => ReadonlyArray<CooldownExpiredEvent>;

  /** 跨日午夜按策略清理：仅清除指定 keys，minutes 模式条目不受影响 */
  clearMidnightEligible: (params: ClearMidnightEligibleParams) => void;

  /** 重置所有触发计数器（午夜清理调用） */
  resetAllTriggerCounts: () => void;
}

/**
 * 交易日志水化器的依赖注入参数，包含文件读取、当前时间与冷却追踪器。
 * 由 createTradeLogHydrator 工厂函数消费，仅在 liquidationCooldown 模块内部使用。
 */
export type TradeLogHydratorDeps = {
  readonly readFileSync: (path: string, encoding: BufferEncoding) => string;
  readonly existsSync: (path: string) => boolean;
  readonly resolveLogRootDir: () => string;
  readonly nowMs: () => number;
  readonly logger: Logger;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
};

/**
 * 交易日志水化器接口。
 * 类型用途：从历史成交日志中恢复冷却状态，供程序启动时调用一次。
 * 数据来源：由 createTradeLogHydrator 实现并注入。
 * 使用范围：供主程序 startup 消费。
 */
export interface TradeLogHydrator {
  hydrate: () => HydrateResult;
}

/**
 * 冷却候选记录。
 * 类型用途：包含监控标的、方向与保护性清仓成交时间，作为恢复冷却状态的中间结果。
 * 数据来源：由 collectLiquidationRecordsByMonitor 从日志解析返回。
 * 使用范围：仅 liquidationCooldown 模块内部使用。
 */
export type CooldownCandidate = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly executedAtMs: number;
};

/**
 * 冷却过期事件。
 * 类型用途：sweepExpired 返回的过期事件，供 lossOffsetLifecycleCoordinator 消费以触发分段切换。
 * 数据来源：由 sweepExpired 在检测到冷却过期时生成。
 * 使用范围：liquidationCooldown 与 riskController 模块间共享。
 */
export type CooldownExpiredEvent = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';

  /** 冷却结束时间戳（用于分段幂等保护） */
  readonly cooldownEndMs: number;

  /** 过期时的触发计数 */
  readonly triggerCountAtExpire: number;
};

/**
 * sweepExpired 的参数。
 * 类型用途：传入当前时间和冷却配置解析函数，供 sweepExpired 判断过期并产出事件。
 * 数据来源：由 lossOffsetLifecycleCoordinator 在每次 sync 时传入。
 * 使用范围：仅 liquidationCooldown 模块使用。
 */
export type SweepExpiredParams = {
  readonly nowMs: number;
  readonly resolveCooldownConfig: (
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
  ) => LiquidationCooldownConfig | null;
};

/**
 * tradeLogHydrator hydrate 返回的分段边界恢复结果。
 * 类型用途：告知调用方各 monitor+direction 的分段起始时间，供 dailyLossTracker 回算时过滤历史成交。
 * 数据来源：由 hydrate 内部根据冷却恢复状态计算。
 * 使用范围：lifecycle 启动恢复链使用。
 */
export type HydrateResult = {
  /** 按 "monitorSymbol:direction" 为键的分段起始时间（毫秒），未找到冷却记录的方向不包含 */
  readonly segmentStartByDirection: ReadonlyMap<string, number>;
};
