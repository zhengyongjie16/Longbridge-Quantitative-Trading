/**
 * TradeTaskQueue 模块
 *
 * 提供买入/卖出任务队列的创建和管理。
 * 任务队列采用 FIFO（先进先出）策略，支持：
 * - 任务入队（自动生成 ID 和时间戳）
 * - 任务出队、查看队首
 * - 按条件移除任务
 * - 任务添加回调（用于触发处理器）
 */
import { randomUUID } from 'node:crypto';
import { notifyTaskAddedCallbacks, registerTaskAddedCallback } from '../utils.js';
import type { Task, TaskQueue, TaskAddedCallback, BuyTaskType, SellTaskType } from './types.js';

/**
 * 创建通用任务队列
 *
 * 内部使用数组实现 FIFO 队列，支持回调通知机制。
 *
 * @template TType 具体任务类型
 * @returns TaskQueue<TType> 任务队列实例
 */
function createTaskQueue<TType extends string>(): TaskQueue<TType> {
  let items: Task<TType>[] = [];
  let headIndex = 0;
  const callbacks: TaskAddedCallback[] = [];

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

  return {
    push(task: Omit<Task<TType>, 'id' | 'createdAt'>): void {
      const fullTask: Task<TType> = {
        id: randomUUID(),
        type: task.type,
        data: task.data,
        monitorSymbol: task.monitorSymbol,
        createdAt: Date.now(),
      };
      items.push(fullTask);
      notifyTaskAddedCallbacks(callbacks);
    },

    pop(): Task<TType> | null {
      if (headIndex >= items.length) {
        items = [];
        headIndex = 0;
        return null;
      }

      const task = items[headIndex] ?? null;
      headIndex += 1;
      compactQueue();
      return task;
    },

    isEmpty(): boolean {
      return headIndex >= items.length;
    },

    removeTasks(
      predicate: (task: Task<TType>) => boolean,
      onRemove?: (task: Task<TType>) => void,
    ): number {
      const nextItems: Task<TType>[] = [];
      const removedTasks: Task<TType>[] = [];

      for (let index = headIndex; index < items.length; index += 1) {
        const task = items[index];
        if (task === undefined) {
          continue;
        }

        if (predicate(task)) {
          removedTasks.push(task);
          continue;
        }

        nextItems.push(task);
      }

      for (let index = removedTasks.length - 1; index >= 0; index -= 1) {
        const task = removedTasks[index];
        if (task !== undefined) {
          onRemove?.(task);
        }
      }

      items = nextItems;
      headIndex = 0;
      return removedTasks.length;
    },

    clearAll(onRemove?: (task: Task<TType>) => void): number {
      const activeItems = items.slice(headIndex);
      for (const task of activeItems) {
        onRemove?.(task);
      }

      items = [];
      headIndex = 0;
      return activeItems.length;
    },

    onTaskAdded(callback: TaskAddedCallback): () => void {
      return registerTaskAddedCallback(callbacks, callback);
    },
  };
}

/**
 * 创建买入任务队列
 *
 * @returns 买入任务队列实例（FIFO，支持 onTaskAdded 回调）
 */
export function createBuyTaskQueue(): TaskQueue<BuyTaskType> {
  return createTaskQueue<BuyTaskType>();
}

/**
 * 创建卖出任务队列
 *
 * @returns 卖出任务队列实例（FIFO，支持 onTaskAdded 回调）
 */
export function createSellTaskQueue(): TaskQueue<SellTaskType> {
  return createTaskQueue<SellTaskType>();
}
