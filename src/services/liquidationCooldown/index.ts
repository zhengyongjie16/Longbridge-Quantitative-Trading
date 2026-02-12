/**
 * 清仓冷却追踪器
 *
 * 记录保护性清仓成交时间，并计算剩余冷却时间。
 */
import type {
  ClearMidnightEligibleParams,
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
import type { LiquidationCooldownConfig } from '../../types/config.js';
import { getHKTime } from '../../utils/helpers/tradingTime.js';

/** 计算冷却结束时间 */
function resolveCooldownEndMs(
  executedTimeMs: number,
  cooldownConfig: LiquidationCooldownConfig | null,
): number | null {
  if (!Number.isFinite(executedTimeMs) || !cooldownConfig) {
    return null;
  }

  // mode 说明：
  // - minutes：按分钟数直接叠加
  // - one-day：冷却到下一自然日 00:00（香港时间）
  // - half-day：上午清仓冷却到当日 13:00，下午清仓冷却到次日 00:00（香港时间）
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

/**
 * 创建清仓冷却追踪器
 */
export function createLiquidationCooldownTracker(
  deps: LiquidationCooldownTrackerDeps,
): LiquidationCooldownTracker {
  const cooldownMap = new Map<string, number>();
  const { nowMs } = deps;

  function recordCooldown({ symbol, direction, executedTimeMs }: RecordCooldownParams): void {
    // 无效时间戳不记录
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

  function clear(): void {
    cooldownMap.clear();
  }

  function clearMidnightEligible({ keysToClear }: ClearMidnightEligibleParams): void {
    for (const key of keysToClear) {
      cooldownMap.delete(key);
    }
  }

  return {
    recordCooldown,
    getRemainingMs,
    clear,
    clearMidnightEligible,
  };
}
