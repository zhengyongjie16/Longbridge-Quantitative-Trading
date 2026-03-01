/**
 * 交易日生命周期管理器
 *
 * 核心职责：
 * - 检测跨日（dayKey 变化），触发午夜清理流程
 * - 在交易日开盘时，触发开盘重建流程
 * - 管理交易门禁（isTradingEnabled），在生命周期切换期间禁止交易
 *
 * 生命周期状态流转：
 * ACTIVE → MIDNIGHT_CLEANING → MIDNIGHT_CLEANED → OPEN_REBUILDING → ACTIVE
 *                ↓ 失败重试                              ↓ 失败重试
 *          MIDNIGHT_CLEANING                     OPEN_REBUILD_FAILED
 *
 * 执行机制：
 * - 由外部每秒调用 tick()，传入当前时间和运行时标志
 * - 午夜清理：按注册顺序依次执行各 CacheDomain 的 midnightClear
 * - 开盘重建：按注册逆序依次执行各 CacheDomain 的 openRebuild
 * - 失败自动重试：指数退避策略，不吞错
 */
import { LIFECYCLE } from '../../constants/index.js';
import { formatError } from '../../utils/error/index.js';
import type {
  CacheDomain,
  DayLifecycleManager,
  DayLifecycleManagerDeps,
  LifecycleContext,
  LifecycleMutableState,
  LifecycleRuntimeFlags,
} from './types.js';

/** 判断是否需要触发午夜清理：dayKey 存在且与当前记录的日期不同 */
function shouldRunMidnightClear(
  runtime: LifecycleRuntimeFlags,
  mutableState: LifecycleMutableState,
): boolean {
  if (!runtime.dayKey) {
    return false;
  }
  return runtime.dayKey !== mutableState.currentDayKey;
}

/** 构造传递给各 CacheDomain 的生命周期上下文 */
function buildLifecycleContext(now: Date, runtime: LifecycleRuntimeFlags): LifecycleContext {
  return {
    now,
    runtime,
  };
}

/** 不吞错：任一路径失败即抛出，由 tick 负责失败重试。 */
async function runMidnightClearForDomains(
  domains: ReadonlyArray<CacheDomain>,
  ctx: LifecycleContext,
): Promise<void> {
  for (const domain of domains) {
    await domain.midnightClear(ctx);
  }
}

/** 按逆序依次执行各 CacheDomain 的开盘重建，任一失败即抛出 */
async function runOpenRebuildForDomains(
  domains: ReadonlyArray<CacheDomain>,
  ctx: LifecycleContext,
): Promise<void> {
  for (let idx = domains.length - 1; idx >= 0; idx -= 1) {
    const domain = domains[idx];
    if (!domain) {
      continue;
    }
    await domain.openRebuild(ctx);
  }
}

/** 计算指数退避重试延迟，失败次数越多延迟越长，上限由 MAX_RETRY_BACKOFF_FACTOR 控制 */
function resolveRetryDelayMs(baseDelayMs: number, rebuildFailureCount: number): number {
  const factor = Math.min(
    2 ** Math.max(rebuildFailureCount - 1, 0),
    LIFECYCLE.MAX_RETRY_BACKOFF_FACTOR,
  );
  return baseDelayMs * factor;
}

/**
 * 创建交易日生命周期管理器。对外暴露 tick(now, runtime)，由主循环每秒调用；
 * 内部根据 dayKey 变化执行午夜清理（各 CacheDomain.midnightClear），再在开盘后执行开盘重建（各 CacheDomain.openRebuild），
 * 失败时指数退避重试，不吞错。用于跨日状态重置与开盘状态恢复。
 *
 * @param deps 依赖注入，包含 mutableState、cacheDomains、logger、rebuildRetryDelayMs
 * @returns DayLifecycleManager，仅含 tick 方法
 */
export function createDayLifecycleManager(deps: DayLifecycleManagerDeps): DayLifecycleManager {
  const {
    mutableState,
    cacheDomains,
    logger,
    rebuildRetryDelayMs = LIFECYCLE.DEFAULT_REBUILD_RETRY_DELAY_MS,
  } = deps;
  let rebuildFailureCount = 0;
  let nextRetryAtMs: number | null = null;
  let midnightClearFailureCount = 0;
  let nextMidnightRetryAtMs: number | null = null;

  /**
   * 每秒由外部驱动的生命周期主循环。
   * 按优先级依次处理：跨日午夜清理 → 等待开盘重建 → 恢复交易门禁。
   * 任一阶段失败均记录错误并进入指数退避重试，不吞错。
   */
  async function tick(now: Date, runtime: LifecycleRuntimeFlags): Promise<void> {
    if (shouldRunMidnightClear(runtime, mutableState)) {
      mutableState.isTradingEnabled = false;
      mutableState.lifecycleState = 'MIDNIGHT_CLEANING';
      const nowMs = now.getTime();
      if (nextMidnightRetryAtMs !== null && nowMs < nextMidnightRetryAtMs) {
        return;
      }
      logger.info(
        `[Lifecycle] 检测到跨日: ${runtime.dayKey ?? 'unknown'}` +
          (midnightClearFailureCount > 0 ? `，第 ${midnightClearFailureCount + 1} 次重试` : ''),
      );
      const midnightContext = buildLifecycleContext(now, runtime);
      try {
        await runMidnightClearForDomains(cacheDomains, midnightContext);
        mutableState.currentDayKey = runtime.dayKey ?? mutableState.currentDayKey;
        mutableState.lifecycleState = 'MIDNIGHT_CLEANED';
        mutableState.pendingOpenRebuild = true;
        mutableState.targetTradingDayKey = runtime.dayKey;
        midnightClearFailureCount = 0;
        nextMidnightRetryAtMs = null;
        logger.info('[Lifecycle] 已完成午夜清理，等待开盘重建');
      } catch (err) {
        midnightClearFailureCount += 1;
        const retryDelayMs = resolveRetryDelayMs(rebuildRetryDelayMs, midnightClearFailureCount);
        nextMidnightRetryAtMs = nowMs + retryDelayMs;
        logger.error(
          `[Lifecycle] 午夜清理失败，第 ${midnightClearFailureCount} 次重试将在 ${Math.round(retryDelayMs / 1000)} 秒后触发`,
          formatError(err),
        );
      }
      return;
    }
    if (!mutableState.pendingOpenRebuild) {
      mutableState.lifecycleState = 'ACTIVE';
      mutableState.isTradingEnabled = true;
      return;
    }
    mutableState.isTradingEnabled = false;
    if (!runtime.isTradingDay || !runtime.canTradeNow) {
      return;
    }
    const nowMs = now.getTime();
    if (nextRetryAtMs !== null && nowMs < nextRetryAtMs) {
      return;
    }
    mutableState.lifecycleState = 'OPEN_REBUILDING';
    logger.info('[Lifecycle] 开始执行开盘重建');
    const rebuildContext = buildLifecycleContext(now, runtime);
    try {
      await runOpenRebuildForDomains(cacheDomains, rebuildContext);
      mutableState.pendingOpenRebuild = false;
      mutableState.targetTradingDayKey = null;
      mutableState.lifecycleState = 'ACTIVE';
      mutableState.isTradingEnabled = true;
      rebuildFailureCount = 0;
      nextRetryAtMs = null;
      logger.info('[Lifecycle] 开盘重建完成，交易门禁已恢复');
    } catch (err) {
      rebuildFailureCount += 1;
      mutableState.lifecycleState = 'OPEN_REBUILD_FAILED';
      mutableState.isTradingEnabled = false;
      const retryDelayMs = resolveRetryDelayMs(rebuildRetryDelayMs, rebuildFailureCount);
      nextRetryAtMs = nowMs + retryDelayMs;
      logger.error(
        `[Lifecycle] 开盘重建失败，第 ${rebuildFailureCount} 次重试将在 ${Math.round(retryDelayMs / 1000)} 秒后触发`,
        formatError(err),
      );
    }
  }
  return {
    tick,
  };
}
