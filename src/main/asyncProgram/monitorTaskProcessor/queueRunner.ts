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
}> {
  let running = false;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;

  function scheduleNextProcess(): void {
    if (!running) {
      return;
    }
    if (monitorTaskQueue.isEmpty()) {
      immediateHandle = null;
      return;
    }

    function handleProcessError(err: unknown): void {
      onQueueError(err);
    }

    function handleProcessFinished(): void {
      scheduleNextProcess();
    }

    function handleImmediate(): void {
      if (!running) {
        return;
      }
      if (monitorTaskQueue.isEmpty()) {
        immediateHandle = null;
        return;
      }
      processQueue().catch(handleProcessError).finally(handleProcessFinished);
    }

    immediateHandle = setImmediate(handleImmediate);
  }

  function start(): void {
    if (running) {
      onAlreadyRunning();
      return;
    }
    running = true;

    function handleTaskAdded(): void {
      if (running && immediateHandle === null) {
        scheduleNextProcess();
      }
    }

    monitorTaskQueue.onTaskAdded(handleTaskAdded);

    scheduleNextProcess();
  }

  function stop(): void {
    running = false;
    if (immediateHandle) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }
  }

  return {
    start,
    stop,
  };
}
