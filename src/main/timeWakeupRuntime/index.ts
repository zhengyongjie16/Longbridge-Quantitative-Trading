/**
 * TimeWakeupRuntime
 *
 * 职责：
 * - 持有系统级 one-shot 时间 timer
 * - start 后立即执行一次单次时间评估
 * - 评估中收到请求只标记 dirty，完成后立即再评估
 * - 停止时清理 timer 并等待在途评估完成
 */
import { TIME } from '../../constants/index.js';
import { formatError } from '../../utils/error/index.js';
import type {
  TimeWakeupRuntime,
  TimeWakeupRuntimeDeps,
  TimeWakeupRuntimeStateSnapshot,
} from './types.js';

/**
 * 创建系统级时间唤醒 runtime。
 *
 * @param deps runtime 依赖
 * @returns TimeWakeupRuntime 实例
 */
export function createTimeWakeupRuntime<TTimerHandle>(
  deps: TimeWakeupRuntimeDeps<TTimerHandle>,
): TimeWakeupRuntime {
  let running = false;
  let inFlight = false;
  let dirty = false;
  let timer: TTimerHandle | null = null;
  let activePromise: Promise<void> | null = null;

  function clearCurrentTimer(): void {
    if (timer === null) {
      return;
    }

    deps.clearTimer(timer);
    timer = null;
  }

  function scheduleRecoveryRetry(): void {
    clearCurrentTimer();
    if (!running) {
      return;
    }

    timer = deps.scheduleTimer(() => {
      timer = null;
      requestEvaluate();
    }, deps.recoveryRetryDelayMs);
  }

  function scheduleAt(atMs: number | null): void {
    clearCurrentTimer();
    if (!running || atMs === null) {
      return;
    }

    const nowMs = deps.now().getTime();
    if (!Number.isFinite(atMs)) {
      deps.logger.error(
        `[TimeWakeupRuntime] 时间唤醒计划非法，停止系统级时间唤醒 atMs=${String(atMs)} nowMs=${String(nowMs)}`,
      );
      running = false;
      dirty = false;
      return;
    }

    if (atMs <= nowMs) {
      if (inFlight) {
        dirty = true;
        return;
      }

      requestEvaluate();
      return;
    }

    const delayMs = atMs - nowMs;
    if (delayMs > TIME.MAX_TIMER_DELAY_MS) {
      timer = deps.scheduleTimer(() => {
        timer = null;
        const currentNowMs = deps.now().getTime();
        if (atMs <= currentNowMs) {
          requestEvaluate();
          return;
        }

        scheduleAt(atMs);
      }, TIME.MAX_TIMER_DELAY_MS);
      return;
    }

    timer = deps.scheduleTimer(() => {
      timer = null;
      requestEvaluate();
    }, delayMs);
  }

  function shouldRunPendingEvaluation(): boolean {
    return running && dirty;
  }

  async function runEvaluationLoop(): Promise<void> {
    inFlight = true;
    try {
      do {
        dirty = false;
        try {
          const result = await deps.evaluate();
          scheduleAt(result.plan.hasWork ? result.plan.nextWakeupAtMs : null);
        } catch (error) {
          deps.logger.error(
            '[TimeWakeupRuntime] 时间评估失败，将按恢复性 retry 重新唤醒',
            formatError(error),
          );
          scheduleRecoveryRetry();
        }
      } while (shouldRunPendingEvaluation());
    } finally {
      inFlight = false;
    }
  }

  function requestEvaluate(): void {
    if (!running) {
      return;
    }

    if (inFlight) {
      dirty = true;
      return;
    }

    const promise = runEvaluationLoop();
    activePromise = promise;
    void promise.finally(() => {
      if (activePromise === promise) {
        activePromise = null;
      }
    });
  }

  async function start(): Promise<void> {
    if (!running) {
      running = true;
      requestEvaluate();
    }

    if (activePromise !== null) {
      await activePromise;
    }
  }

  async function stopAndDrain(): Promise<void> {
    running = false;
    dirty = false;
    clearCurrentTimer();
    if (activePromise !== null) {
      await Promise.allSettled([activePromise]);
    }
  }

  function getStateSnapshot(): TimeWakeupRuntimeStateSnapshot {
    return {
      running,
      inFlight,
      dirty,
      hasTimer: timer !== null,
    };
  }

  return {
    start,
    requestEvaluate,
    stopAndDrain,
    getStateSnapshot,
  };
}
