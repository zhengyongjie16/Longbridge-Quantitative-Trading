/**
 * 清仓冷却追踪器
 *
 * 功能/职责：记录保护性清仓触发与冷却时间，并计算剩余冷却时间。
 * 执行流程：运行时通过 recordLiquidationTrigger 累加触发计数并按上限激活冷却；启动恢复通过 recordCooldown/restoreTriggerCount 恢复状态；买入前通过 getRemainingMs 查询剩余冷却毫秒数；跨日时通过 clearMidnightEligible 与 resetAllTriggerCounts 清理状态。
 */
import type {
  ClearMidnightEligibleParams,
  GetRemainingMsParams,
  LiquidationCooldownTracker,
  LiquidationCooldownTrackerDeps,
  RecordCooldownParams,
  RecordLiquidationTriggerParams,
  RecordLiquidationTriggerResult,
  RestoreTriggerCountParams,
} from './types.js';
import { buildCooldownKey, resolveCooldownEndMs } from './utils.js';

/**
 * 创建清仓冷却追踪器，记录保护性清仓成交时间并计算剩余冷却时长。
 * 内部以 symbol:direction 为键存储成交时间戳，查询时按冷却模式动态计算结束时间。
 * @param deps - 依赖，包含 nowMs（当前时间毫秒）
 * @returns LiquidationCooldownTracker 实例（recordLiquidationTrigger、recordCooldown、restoreTriggerCount、getRemainingMs、clearMidnightEligible、resetAllTriggerCounts）
 */
export function createLiquidationCooldownTracker(
  deps: LiquidationCooldownTrackerDeps,
): LiquidationCooldownTracker {
  const cooldownMap = new Map<string, number>();
  const triggerCountMap = new Map<string, number>();
  const { nowMs } = deps;

  /** 记录保护性清仓成交时间，无效时间戳不写入，避免脏数据影响冷却判断 */
  function recordCooldown({ symbol, direction, executedTimeMs }: RecordCooldownParams): void {
    // 无效时间戳不记录
    if (!Number.isFinite(executedTimeMs) || executedTimeMs <= 0) {
      return;
    }
    cooldownMap.set(buildCooldownKey(symbol, direction), executedTimeMs);
  }

  /**
   * 记录保护性清仓触发事件。
   * 每次触发都会累加计数，达到 triggerLimit 时写入冷却记录。
   */
  function recordLiquidationTrigger({
    symbol,
    direction,
    executedTimeMs,
    triggerLimit,
  }: RecordLiquidationTriggerParams): RecordLiquidationTriggerResult {
    if (
      !Number.isFinite(executedTimeMs) ||
      executedTimeMs <= 0 ||
      !Number.isInteger(triggerLimit) ||
      triggerLimit <= 0
    ) {
      return {
        currentCount: 0,
        cooldownActivated: false,
      };
    }

    const key = buildCooldownKey(symbol, direction);
    const previousCount = triggerCountMap.get(key) ?? 0;
    const currentCount = previousCount + 1;
    triggerCountMap.set(key, currentCount);

    if (currentCount >= triggerLimit) {
      cooldownMap.set(key, executedTimeMs);
      return {
        currentCount,
        cooldownActivated: true,
      };
    }

    return {
      currentCount,
      cooldownActivated: false,
    };
  }

  /** 恢复触发计数器，用于启动时从成交日志恢复当前周期计数。 */
  function restoreTriggerCount({ symbol, direction, count }: RestoreTriggerCountParams): void {
    if (!Number.isInteger(count) || count <= 0) {
      return;
    }
    triggerCountMap.set(buildCooldownKey(symbol, direction), count);
  }

  /**
   * 查询指定标的方向的剩余冷却毫秒数。
   * 冷却已过期或无记录时返回 0，并顺带清除过期条目。
   */
  function getRemainingMs({ symbol, direction, cooldownConfig }: GetRemainingMsParams): number {
    const key = buildCooldownKey(symbol, direction);
    const executedTimeMs = cooldownMap.get(key);
    if (executedTimeMs === undefined || !Number.isFinite(executedTimeMs)) {
      return 0;
    }

    const cooldownEndMs = resolveCooldownEndMs(executedTimeMs, cooldownConfig);
    if (cooldownEndMs === null || !Number.isFinite(cooldownEndMs)) {
      cooldownMap.delete(key);
      triggerCountMap.delete(key);
      return 0;
    }

    const remainingMs = cooldownEndMs - nowMs();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      cooldownMap.delete(key);
      triggerCountMap.delete(key);
      return 0;
    }
    return remainingMs;
  }

  /** 跨日午夜清理：删除指定键集合中的冷却记录，minutes 模式条目不在此处清理 */
  function clearMidnightEligible({ keysToClear }: ClearMidnightEligibleParams): void {
    for (const key of keysToClear) {
      cooldownMap.delete(key);
      triggerCountMap.delete(key);
    }
  }

  /** 重置所有触发计数器。 */
  function resetAllTriggerCounts(): void {
    triggerCountMap.clear();
  }

  return {
    recordLiquidationTrigger,
    recordCooldown,
    restoreTriggerCount,
    getRemainingMs,
    clearMidnightEligible,
    resetAllTriggerCounts,
  };
}
