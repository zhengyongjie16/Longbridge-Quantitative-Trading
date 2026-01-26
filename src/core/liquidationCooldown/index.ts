/**
 * 清仓冷却追踪器
 *
 * 记录保护性清仓成交时间，并计算剩余冷却时间。
 */

import type {
  GetRemainingMsParams,
  LiquidationCooldownTracker,
  LiquidationCooldownTrackerDeps,
  RecordCooldownParams,
} from './types.js';
import { buildCooldownKey, convertMinutesToMs } from './utils.js';

/**
 * 创建清仓冷却追踪器
 */
export function createLiquidationCooldownTracker(
  deps: LiquidationCooldownTrackerDeps,
): LiquidationCooldownTracker {
  const cooldownMap = new Map<string, number>();
  const { nowMs } = deps;

  function recordCooldown({ symbol, direction, executedTimeMs }: RecordCooldownParams): void {
    if (!Number.isFinite(executedTimeMs) || executedTimeMs <= 0) {
      return;
    }
    cooldownMap.set(buildCooldownKey(symbol, direction), executedTimeMs);
  }

  function getRemainingMs({
    symbol,
    direction,
    cooldownMinutes,
  }: GetRemainingMsParams): number {
    const cooldownMs = convertMinutesToMs(cooldownMinutes);
    if (cooldownMs <= 0) {
      return 0;
    }

    const key = buildCooldownKey(symbol, direction);
    const executedTimeMs = cooldownMap.get(key);
    if (executedTimeMs == null || !Number.isFinite(executedTimeMs)) {
      return 0;
    }

    const remainingMs = executedTimeMs + cooldownMs - nowMs();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      cooldownMap.delete(key);
      return 0;
    }
    return remainingMs;
  }

  return {
    recordCooldown,
    getRemainingMs,
  };
}
