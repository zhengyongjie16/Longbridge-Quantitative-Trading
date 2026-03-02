/**
 * 亏损偏移生命周期协调器
 *
 * 功能/职责：在主循环每轮 tick 前扫描冷却过期事件，并触发 dailyLossTracker 分段切换，
 * 确保冷却结束后旧段偏移失效、新成交进入新分段。
 * 执行流程：调用 sync(currentTimeMs) → sweepExpired 拉取过期事件 → 对每个事件调用 resetDirectionSegment → 输出审计日志。
 */
import type {
  LossOffsetLifecycleCoordinator,
  LossOffsetLifecycleCoordinatorDeps,
} from './types.js';

/**
 * 创建亏损偏移生命周期协调器。
 * 绑定 liquidationCooldownTracker 与 dailyLossTracker，在每轮 sync 时消费过期事件并切段。
 *
 * @param deps 依赖注入（liquidationCooldownTracker、dailyLossTracker、logger、resolveCooldownConfig）
 * @returns LossOffsetLifecycleCoordinator 实例
 */
export function createLossOffsetLifecycleCoordinator(
  deps: LossOffsetLifecycleCoordinatorDeps,
): LossOffsetLifecycleCoordinator {
  const { liquidationCooldownTracker, dailyLossTracker, logger, resolveCooldownConfig } = deps;

  /**
   * 同步冷却过期事件与分段切换。
   * 即使 canTradeNow=false 也必须调用，防止分段边界漂移。
   */
  function sync(currentTimeMs: number): void {
    const events = liquidationCooldownTracker.sweepExpired({
      nowMs: currentTimeMs,
      resolveCooldownConfig,
    });

    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      dailyLossTracker.resetDirectionSegment({
        monitorSymbol: event.monitorSymbol,
        direction: event.direction,
        segmentStartMs: event.cooldownEndMs,
        cooldownEndMs: event.cooldownEndMs,
      });

      logger.info(
        `[偏移分段] ${event.monitorSymbol}:${event.direction} 冷却结束，` +
          `切段时间=${event.cooldownEndMs}，触发计数=${event.triggerCountAtExpire}，` +
          `旧段偏移已失效`,
      );
    }
  }

  return { sync };
}
