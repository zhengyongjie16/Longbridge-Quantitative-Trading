/**
 * 监控任务队列调度器
 *
 * 功能：
 * - 负责队列调度与 setImmediate 驱动
 * - 提供 start/stop/scheduleNextProcess 控制
 * - 队列为空时停止调度，等待新任务触发
 */
import type { MonitorTaskQueue } from '../monitorTaskQueue/types.js';
import { scheduleWhenTaskAdded } from '../utils.js';
import type { MonitorTaskData, MonitorTaskType } from './types.js';

/**
 * 创建监控任务队列调度器。
 * 负责队列调度与 setImmediate 驱动，在任务入队或处理完成后触发下一轮消费；保证同一时刻仅有一个 processQueue 在运行。
 *
 * @param monitorTaskQueue 监控任务队列
 * @param processQueue 单次消费队列的异步函数
 * @param onQueueError 队列处理出错时的回调
 * @param onAlreadyRunning 重复 start 时的回调
 * @returns 提供 start、stop、stopAndDrain、restart 的调度器实例
 */
export function createQueueRunner({
  monitorTaskQueue,
  processQueue,
  onQueueError,
  onAlreadyRunning,
}: {
  readonly monitorTaskQueue: MonitorTaskQueue<MonitorTaskType, MonitorTaskData>;
  readonly processQueue: () => Promise<void>;
  readonly onQueueError: (err: unknown) => void;
  readonly onAlreadyRunning: () => void;
}): Readonly<{
  start: () => void;
  stop: () => void;
  stopAndDrain: () => Promise<void>;
  restart: () => void;
}> {
  let running = false;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;
  let inFlightPromise: Promise<void> | null = null;
  let taskAddedUnregister: (() => void) | null = null;

  /**
   * 处理队列错误，将错误转发给外部错误回调。
   * 队列内部消费抛错时统一交给 onQueueError，由调用方决定重试或降级，避免吞错。
   */
  function handleProcessError(err: unknown): void {
    onQueueError(err);
  }

  /**
   * 处理队列任务完成，触发下一轮调度。
   * 单轮消费结束后需再次调度，否则队列中后续任务不会被处理；通过 scheduleNextProcess 解耦避免递归堆叠。
   */
  function handleProcessFinished(): void {
    scheduleNextProcess();
  }

  /**
   * 调度下一次队列处理。队列为空时停止调度；否则通过 setImmediate 异步触发，避免阻塞当前调用栈。
   * 为什么：使用 setImmediate 将调度与消费解耦，保证同一时刻仅有一个消费在飞行，避免递归调用堆叠。
   */
  function scheduleNextProcess(): void {
    if (!running) {
      return;
    }

    if (monitorTaskQueue.isEmpty()) {
      immediateHandle = null;
      return;
    }

    /**
     * setImmediate 回调入口：在运行态下触发一轮队列消费，并在完成后继续调度下一轮。
     * 将调度与消费解耦可避免递归调用堆叠，同时确保同一时刻仅有一个消费流程在飞行中。
     *
     * @returns 无返回值
     */
    function handleImmediate(): void {
      if (!running) {
        return;
      }

      if (monitorTaskQueue.isEmpty()) {
        immediateHandle = null;
        return;
      }
      inFlightPromise = processQueue()
        .catch(handleProcessError)
        .finally(() => {
          inFlightPromise = null;
          handleProcessFinished();
        });
    }

    immediateHandle = setImmediate(handleImmediate);
  }

  /**
   * 启动调度器，注册任务新增监听并触发首次调度
   */
  function start(): void {
    if (running) {
      onAlreadyRunning();
      return;
    }
    running = true;
    taskAddedUnregister = monitorTaskQueue.onTaskAdded(() => {
      scheduleWhenTaskAdded(running, immediateHandle, scheduleNextProcess);
    });

    scheduleNextProcess();
  }

  /**
   * 停止调度器，取消注册监听并清除待执行的 setImmediate
   */
  function stop(): void {
    running = false;
    taskAddedUnregister?.();
    taskAddedUnregister = null;
    if (immediateHandle) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }
  }

  /**
   * 停止调度器并等待当前在途任务完成，确保停止后无残留执行
   */
  async function stopAndDrain(): Promise<void> {
    running = false;
    taskAddedUnregister?.();
    taskAddedUnregister = null;
    if (immediateHandle) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }

    if (inFlightPromise !== null) {
      await inFlightPromise;
    }
  }

  /**
   * 重启调度器，先停止再启动
   */
  function restart(): void {
    stop();
    start();
  }

  return {
    start,
    stop,
    stopAndDrain,
    restart,
  };
}
