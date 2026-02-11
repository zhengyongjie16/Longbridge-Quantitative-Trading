/**
 * 模块名称：监控任务队列调度器
 *
 * 功能：
 * - 负责队列调度与 setImmediate 驱动
 * - 提供 start/stop/scheduleNextProcess 控制
 *
 * 说明：
 * - 队列为空时停止调度，等待新任务触发
 */
import type { MonitorTaskQueue } from '../monitorTaskQueue/types.js';
import type { MonitorTaskData, MonitorTaskType } from './types.js';

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
   * 处理队列错误
   */
  function handleProcessError(err: unknown): void {
    onQueueError(err);
  }

  /**
   * 处理队列任务完成
   */
  function handleProcessFinished(): void {
    scheduleNextProcess();
  }

  function scheduleNextProcess(): void {
    if (!running) {
      return;
    }
    if (monitorTaskQueue.isEmpty()) {
      immediateHandle = null;
      return;
    }

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

  function handleTaskAdded(): void {
    if (running && immediateHandle === null) {
      scheduleNextProcess();
    }
  }

  function start(): void {
    if (running) {
      onAlreadyRunning();
      return;
    }
    running = true;
    taskAddedUnregister = monitorTaskQueue.onTaskAdded(handleTaskAdded);

    scheduleNextProcess();
  }

  function stop(): void {
    running = false;
    taskAddedUnregister?.();
    taskAddedUnregister = null;
    if (immediateHandle) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }
  }

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
