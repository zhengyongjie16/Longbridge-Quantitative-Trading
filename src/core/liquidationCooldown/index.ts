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
import {
  buildCooldownKey,
  convertMinutesToMs,
  resolveHongKongTimeMs,
} from './utils.js';
import type { LiquidationCooldownConfig } from '../../types/index.js';
import { getHKTime } from '../../utils/helpers/tradingTime.js';

/**
 * 创建清仓冷却追踪器
 */
export function createLiquidationCooldownTracker(
  deps: LiquidationCooldownTrackerDeps,
): LiquidationCooldownTracker {
  const cooldownMap = new Map<string, number>();
  const { nowMs } = deps;

  function resolveCooldownEndMs(
    executedTimeMs: number,
    cooldownConfig: LiquidationCooldownConfig | null,
  ): number | null {
    if (!Number.isFinite(executedTimeMs) || !cooldownConfig) {
      return null;
    }

    if (cooldownConfig.mode === 'minutes') {
      const cooldownMs = convertMinutesToMs(cooldownConfig.minutes);
      if (cooldownMs <= 0) {
        return null;
      }
      return executedTimeMs + cooldownMs;
    }

    if (cooldownConfig.mode === 'one-day') {
      return resolveHongKongTimeMs({
        baseTimestampMs: executedTimeMs,
        hour: 0,
        minute: 0,
        dayOffset: 1,
      });
    }

    const hkTime = getHKTime(new Date(executedTimeMs));
    if (!hkTime) {
      return null;
    }

    if (hkTime.hkHour < 12) {
      return resolveHongKongTimeMs({
        baseTimestampMs: executedTimeMs,
        hour: 13,
        minute: 0,
        dayOffset: 0,
      });
    }

    return resolveHongKongTimeMs({
      baseTimestampMs: executedTimeMs,
      hour: 0,
      minute: 0,
      dayOffset: 1,
    });
  }

  function recordCooldown({ symbol, direction, executedTimeMs }: RecordCooldownParams): void {
    if (!Number.isFinite(executedTimeMs) || executedTimeMs <= 0) {
      return;
    }
    cooldownMap.set(buildCooldownKey(symbol, direction), executedTimeMs);
  }

  function getRemainingMs({
    symbol,
    direction,
    cooldownConfig,
  }: GetRemainingMsParams): number {
    const key = buildCooldownKey(symbol, direction);
    const executedTimeMs = cooldownMap.get(key);
    if (executedTimeMs == null || !Number.isFinite(executedTimeMs)) {
      return 0;
    }

    const cooldownEndMs = resolveCooldownEndMs(executedTimeMs, cooldownConfig);
    if (cooldownEndMs == null || !Number.isFinite(cooldownEndMs)) {
      cooldownMap.delete(key);
      return 0;
    }

    const remainingMs = cooldownEndMs - nowMs();
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
