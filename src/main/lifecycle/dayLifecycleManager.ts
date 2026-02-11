import { formatError } from '../../utils/helpers/index.js';
import { LIFECYCLE } from '../../constants/index.js';
import type { LifecycleState } from '../../types/index.js';
import type {
  CacheDomain,
  DayLifecycleManager,
  DayLifecycleManagerDeps,
  LifecycleContext,
  LifecycleMutableState,
  LifecycleRuntimeFlags,
} from './types.js';

function shouldRunMidnightClear(
  runtime: LifecycleRuntimeFlags,
  mutableState: LifecycleMutableState,
): boolean {
  if (!runtime.dayKey) {
    return false;
  }
  return runtime.dayKey !== mutableState.currentDayKey;
}

function buildLifecycleContext(
  now: Date,
  runtime: LifecycleRuntimeFlags,
): LifecycleContext {
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

function resolveRetryDelayMs(
  baseDelayMs: number,
  rebuildFailureCount: number,
): number {
  const factor = Math.min(
    2 ** Math.max(rebuildFailureCount - 1, 0),
    LIFECYCLE.MAX_RETRY_BACKOFF_FACTOR,
  );
  return baseDelayMs * factor;
}

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

  async function tick(now: Date, runtime: LifecycleRuntimeFlags): Promise<void> {
    if (shouldRunMidnightClear(runtime, mutableState)) {
      mutableState.isTradingEnabled = false;
      mutableState.lifecycleState = 'MIDNIGHT_CLEANING';

      const nowMs = now.getTime();
      if (nextMidnightRetryAtMs != null && nowMs < nextMidnightRetryAtMs) {
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
    if (nextRetryAtMs != null && nowMs < nextRetryAtMs) {
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

  function getState(): LifecycleState {
    return mutableState.lifecycleState;
  }

  function isTradingEnabled(): boolean {
    return mutableState.isTradingEnabled;
  }

  return {
    tick,
    getState,
    isTradingEnabled,
  };
}
