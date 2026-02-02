/**
 * 监控任务队列模块
 *
 * 功能：
 * - 提供监控任务的队列管理
 * - 支持任务去重（相同 dedupeKey 的任务会被替换为最新的）
 * - 支持任务添加回调（用于触发处理器）
 *
 * 去重策略：
 * - 使用 scheduleLatest 入队时，会移除队列中 dedupeKey 相同的旧任务
 * - 确保同类型任务只保留最新的一个，避免重复处理
 *
 * 使用场景：
 * - 自动换标任务（按 monitorSymbol + direction 去重）
 * - 浮亏检查任务（按 monitorSymbol 去重）
 * - 牛熊证距离检查任务（按 monitorSymbol 去重）
 */
import { randomUUID } from 'node:crypto';

import type {
  MonitorTask,
  MonitorTaskInput,
  MonitorTaskQueue,
  TaskAddedCallback,
} from './types.js';
import { removeTasksFromQueue } from './utils.js';

/**
 * 创建监控任务队列
 * 支持任务去重（scheduleLatest）和任务添加回调通知
 */
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
