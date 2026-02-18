/**
 * 监控任务队列调度器
 *
 * 功能：
 * - 负责队列调度与 setImmediate 驱动
 * - 提供 start/stop/scheduleNextProcess 控制
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
   * 处理队列错误，将错误转发给外部错误回调
   */
  function handleProcessError(err: unknown): void {
    onQueueError(err);
  }

  /**
   * 处理队列任务完成，触发下一轮调度
   */
  function handleProcessFinished(): void {
    scheduleNextProcess();
  }

  /**
   * 调度下一次队列处理
   * 队列为空时停止调度；否则通过 setImmediate 异步触发，避免阻塞当前调用栈
   */
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

  /**
   * 监听队列新增任务事件
   * 若调度器已启动且当前无待执行的 setImmediate，则触发调度
   */
  function handleTaskAdded(): void {
    if (running && immediateHandle === null) {
      scheduleNextProcess();
    }
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
    taskAddedUnregister = monitorTaskQueue.onTaskAdded(handleTaskAdded);

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
