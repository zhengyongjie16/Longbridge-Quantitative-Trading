import { randomUUID } from 'node:crypto';

import type {
  MonitorTask,
  MonitorTaskInput,
  MonitorTaskQueue,
  TaskAddedCallback,
} from './types.js';
import { removeTasksFromQueue } from './utils.js';

export function createMonitorTaskQueue<
  TType extends string,
  TData,
>(): MonitorTaskQueue<TType, TData> {
  const queue: Array<MonitorTask<TType, TData>> = [];
  const callbacks: TaskAddedCallback[] = [];

  function notifyCallbacks(): void {
    for (const callback of callbacks) {
      callback();
    }
  }

  function scheduleLatest(task: MonitorTaskInput<TType, TData>): void {
    removeTasksFromQueue(queue, (queued) => queued.dedupeKey === task.dedupeKey);

    const fullTask: MonitorTask<TType, TData> = {
      id: randomUUID(),
      type: task.type,
      dedupeKey: task.dedupeKey,
      monitorSymbol: task.monitorSymbol,
      data: task.data,
      createdAt: Date.now(),
    };

    queue.push(fullTask);
    notifyCallbacks();
  }

  function pop(): MonitorTask<TType, TData> | null {
    return queue.shift() ?? null;
  }

  function peek(): MonitorTask<TType, TData> | null {
    return queue[0] ?? null;
  }

  function size(): number {
    return queue.length;
  }

  function isEmpty(): boolean {
    return queue.length === 0;
  }

  function removeTasks(
    predicate: (task: MonitorTask<TType, TData>) => boolean,
    onRemove?: (task: MonitorTask<TType, TData>) => void,
  ): number {
    return removeTasksFromQueue(queue, predicate, onRemove);
  }

  function onTaskAdded(callback: TaskAddedCallback): void {
    callbacks.push(callback);
  }

  return {
    scheduleLatest,
    pop,
    peek,
    size,
    isEmpty,
    removeTasks,
    onTaskAdded,
  };
}
