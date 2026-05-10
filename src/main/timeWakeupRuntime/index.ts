/**
 * TimeWakeupRuntime
 *
 * 职责：
 * - 持有系统级 one-shot 时间 timer
 * - start 后立即执行一次单次时间评估
 * - 评估中收到请求只标记 dirty，完成后立即再评估
 * - 停止时清理 timer 并等待在途评估完成
 */
import { formatError } from '../../utils/error/index.js';
import { scheduleBoundedOneShotAt } from '../../utils/timer/index.js';
import type { BoundedOneShotTimerController } from '../../utils/timer/types.js';
import type { TimeWakeupRuntime, TimeWakeupRuntimeDeps } from './types.js';

function normalizeFatalError(error: unknown): Error {
  return error instanceof Error ? error : new Error(formatError(error));
}

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
  let timer: BoundedOneShotTimerController | null = null;
  let activePromise: Promise<void> | null = null;
  let fatalError: Error | null = null;
  const fatalRejectors = new Set<(error: Error) => void>();

  function clearCurrentTimer(): void {
    if (timer === null) {
      return;
    }

    timer.cancel();
    timer = null;
  }

  /**
   * 将系统级时间评估切入 fatal 状态。
   * fatal 表示权威时间事实不可确认或计划非法，必须停止 timer 与 dirty 重入，交给 app 顶层清理并暴露根因。
   */
  function failFatal(error: unknown): void {
    if (fatalError !== null) {
      return;
    }

    fatalError = normalizeFatalError(error);
    running = false;
    dirty = false;
    clearCurrentTimer();
    deps.logger.error('[TimeWakeupRuntime] 系统级时间唤醒进入 fatal 状态', fatalError.message);
    for (const reject of fatalRejectors) {
      reject(fatalError);
    }

    fatalRejectors.clear();
  }

  /**
   * 根据单次权威评估结果安排下一次系统级 one-shot timer。
   * 只接受未来的有限时间点；已到期计划立即重评估，非法计划进入 fatal，避免形成隐式轮询或静默停摆。
   */
  function scheduleAt(atMs: number | null): void {
    clearCurrentTimer();
    if (!running || atMs === null) {
      return;
    }

    const nowMs = deps.now().getTime();
    if (!Number.isFinite(atMs)) {
      failFatal(
        new Error(
          `[TimeWakeupRuntime] 时间唤醒计划非法 atMs=${String(atMs)} nowMs=${String(nowMs)}`,
        ),
      );
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

    let scheduledController: BoundedOneShotTimerController | null = null;
    const controller = scheduleBoundedOneShotAt({
      atMs,
      now: deps.now,
      scheduleTimer: deps.scheduleTimer,
      clearTimer: deps.clearTimer,
      onDue: () => {
        if (timer !== scheduledController) {
          return;
        }

        timer = null;
        requestEvaluate();
      },
    });
    scheduledController = controller;
    timer = controller;
  }

  function shouldRunPendingEvaluation(): boolean {
    return running && dirty;
  }

  /**
   * 串行执行时间评估 dirty-drain。
   * 评估期间的新请求只标记 dirty，当前评估提交计划后再补跑一轮，保证同一时刻只有一个权威时间评估 owner。
   */
  async function runEvaluationLoop(): Promise<void> {
    inFlight = true;
    try {
      do {
        dirty = false;
        try {
          const result = await deps.evaluate();
          scheduleAt(result.plan.hasWork ? result.plan.nextWakeupAtMs : null);
        } catch (error) {
          failFatal(error);
        }
      } while (shouldRunPendingEvaluation());
    } finally {
      inFlight = false;
    }
  }

  /**
   * 请求一次系统级时间重评估。
   * 外部事件和 timer 到期都通过该入口收敛；运行中请求不重入，只转换为 dirty 标记。
   */
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

  function drainFatalError(): Promise<never> {
    if (fatalError !== null) {
      return Promise.reject(fatalError);
    }

    return new Promise<never>((_, reject) => {
      fatalRejectors.add(reject);
    });
  }

  return {
    start,
    stopAndDrain,
    drainFatalError,
  };
}
