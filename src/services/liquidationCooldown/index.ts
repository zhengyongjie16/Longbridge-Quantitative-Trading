/**
 * 清仓冷却追踪器
 *
 * 功能/职责：记录保护性清仓成交时间，并计算剩余冷却时间。
 * 执行流程：调用方通过 recordCooldown 记录成交时间，通过 getRemainingMs 查询剩余冷却毫秒数，跨日时通过 clearMidnightEligible 清理指定键的冷却记录。
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

/**
 * 根据清仓成交时间与冷却模式计算冷却结束时间戳。
 * 默认行为：cooldownConfig 为 null 或 executedTimeMs 无效时返回 null。
 * 按 mode 行为：minutes 按配置分钟数在成交时间上叠加；one-day 为下一自然日 00:00（香港时间）；half-day 为上午清仓冷却到当日 13:00、下午清仓冷却到次日 00:00（香港时间）。
 *
 * @param executedTimeMs - 保护性清仓成交时间戳（毫秒）
 * @param cooldownConfig - 冷却配置，null 时返回 null
 * @returns 冷却结束时间戳（毫秒），无效时 null
 */
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

/**
 * 创建清仓冷却追踪器，记录保护性清仓成交时间并计算剩余冷却时长。
 * 内部以 symbol:direction 为键存储成交时间戳，查询时按冷却模式动态计算结束时间。
 * @param deps - 依赖，包含 nowMs（当前时间毫秒）
 * @returns LiquidationCooldownTracker 实例（recordCooldown、getRemainingMs、clearMidnightEligible）
 */
export function createLiquidationCooldownTracker(
  deps: LiquidationCooldownTrackerDeps,
): LiquidationCooldownTracker {
  const cooldownMap = new Map<string, number>();
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
   * 查询指定标的方向的剩余冷却毫秒数。
   * 冷却已过期或无记录时返回 0，并顺带清除过期条目。
   */
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

  /** 跨日午夜清理：删除指定键集合中的冷却记录，minutes 模式条目不在此处清理 */
  function clearMidnightEligible({ keysToClear }: ClearMidnightEligibleParams): void {
    for (const key of keysToClear) {
      cooldownMap.delete(key);
    }
  }

  return {
    recordCooldown,
    getRemainingMs,
    clearMidnightEligible,
  };
}
