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

import { logger } from '../../../utils/logger/index.js';
import type { TaskAddedCallback } from '../tradeTaskQueue/types.js';
import { notifyTaskAddedCallbacks, registerTaskAddedCallback } from '../utils.js';
import type { MonitorTask, MonitorTaskInput, MonitorTaskQueue } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : 'null';
}

function readNumberField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'null';
}

function logSeatRefreshReplaced<TDataMap extends Readonly<Record<string, unknown>>>(
  task: MonitorTaskInput<TDataMap>,
  removedCount: number,
): void {
  if (task.type !== 'SEAT_REFRESH' || removedCount <= 0 || !isRecord(task.data)) {
    return;
  }

  logger.debug(
    `[SEAT_REFRESH replaced] monitorSymbol=${task.monitorSymbol} direction=${readStringField(task.data, 'direction')} seatVersion=${readNumberField(task.data, 'seatVersion')} nextSymbol=${readStringField(task.data, 'nextSymbol')} dedupeKey=${task.dedupeKey} replacedCount=${removedCount}`,
  );
}

/**
 * 创建监控任务队列
 * 支持任务去重（scheduleLatest）和任务添加回调通知
 *
 * @returns 监控任务队列实例，含 scheduleLatest、pop、isEmpty、removeTasks、clearAll、onTaskAdded
 */
export function createMonitorTaskQueue<
  TDataMap extends Readonly<Record<string, unknown>>,
>(): MonitorTaskQueue<TDataMap> {
  let items: Array<MonitorTask<TDataMap>> = [];
  let headIndex = 0;
  const taskByDedupeKey = new Map<string, MonitorTask<TDataMap>>();
  const cancelledTaskIds = new Set<string>();
  const callbacks: TaskAddedCallback[] = [];

  /**
   * 按已出队游标压缩底层数组，避免长期保留已消费任务。
   */
  function compactQueue(): void {
    if (headIndex === 0) {
      return;
    }

    if (headIndex < 64 && headIndex * 2 < items.length) {
      return;
    }

    items = items.slice(headIndex);
    headIndex = 0;
  }

  /**
   * 判断任务是否仍是对应 dedupeKey 的当前有效任务。
   *
   * @param task 待判断的监控任务
   * @returns 任务仍有效时返回 true
   */
  function isEffectiveTask(task: MonitorTask<TDataMap>): boolean {
    return !cancelledTaskIds.has(task.id) && taskByDedupeKey.get(task.dedupeKey) === task;
  }

  /**
   * 主动移除任务后重建待消费切片，只保留仍有效的任务。
   *
   * removeTasks 已经扫描当前待消费范围；重建后不再保留已取消占位任务，
   * cancelledTaskIds 也可以同步清空。
   */
  function rebuildEffectiveQueue(): void {
    const effectiveTasks: Array<MonitorTask<TDataMap>> = [];

    for (let index = headIndex; index < items.length; index += 1) {
      const task = items[index];
      if (task !== undefined && isEffectiveTask(task)) {
        effectiveTasks.push(task);
      }
    }

    items = effectiveTasks;
    headIndex = 0;
    cancelledTaskIds.clear();
  }

  function scheduleLatest<TType extends keyof TDataMap>(
    task: MonitorTaskInput<TDataMap, TType>,
  ): void {
    const previousTask = taskByDedupeKey.get(task.dedupeKey);
    const removedCount = previousTask === undefined ? 0 : 1;
    if (previousTask !== undefined) {
      cancelledTaskIds.add(previousTask.id);
    }

    logSeatRefreshReplaced(task, removedCount);

    const fullTask = {
      id: randomUUID(),
      type: task.type,
      dedupeKey: task.dedupeKey,
      monitorSymbol: task.monitorSymbol,
      data: task.data,
      createdAt: Date.now(),
    } as MonitorTask<TDataMap, TType>;

    taskByDedupeKey.set(task.dedupeKey, fullTask);
    items.push(fullTask);
    notifyTaskAddedCallbacks(callbacks);
  }

  function pop(): MonitorTask<TDataMap> | null {
    while (headIndex < items.length) {
      const task = items[headIndex];
      headIndex += 1;

      if (task === undefined || !isEffectiveTask(task)) {
        if (task !== undefined) {
          cancelledTaskIds.delete(task.id);
        }

        continue;
      }

      taskByDedupeKey.delete(task.dedupeKey);
      compactQueue();
      return task;
    }

    items = [];
    headIndex = 0;
    cancelledTaskIds.clear();
    return null;
  }

  function isEmpty(): boolean {
    return taskByDedupeKey.size === 0;
  }

  function removeTasks(
    predicate: (task: MonitorTask<TDataMap>) => boolean,
    onRemove?: (task: MonitorTask<TDataMap>) => void,
  ): number {
    const removedTasks: Array<MonitorTask<TDataMap>> = [];

    for (let index = headIndex; index < items.length; index += 1) {
      const task = items[index];
      if (task === undefined || !isEffectiveTask(task) || !predicate(task)) {
        continue;
      }

      removedTasks.push(task);
      cancelledTaskIds.add(task.id);
      taskByDedupeKey.delete(task.dedupeKey);
    }

    for (let index = removedTasks.length - 1; index >= 0; index -= 1) {
      const task = removedTasks[index];
      if (task !== undefined) {
        onRemove?.(task);
      }
    }

    if (removedTasks.length > 0) {
      rebuildEffectiveQueue();
    } else {
      compactQueue();
    }

    return removedTasks.length;
  }

  function clearAll(onRemove?: (task: MonitorTask<TDataMap>) => void): number {
    const activeTasks: Array<MonitorTask<TDataMap>> = [];
    for (let index = headIndex; index < items.length; index += 1) {
      const task = items[index];
      if (task !== undefined && isEffectiveTask(task)) {
        activeTasks.push(task);
      }
    }

    for (const task of activeTasks) {
      onRemove?.(task);
    }

    items = [];
    headIndex = 0;
    taskByDedupeKey.clear();
    cancelledTaskIds.clear();
    return activeTasks.length;
  }

  function onTaskAdded(callback: TaskAddedCallback): () => void {
    return registerTaskAddedCallback(callbacks, callback);
  }

  return {
    scheduleLatest,
    pop,
    isEmpty,
    removeTasks,
    clearAll,
    onTaskAdded,
  };
}
