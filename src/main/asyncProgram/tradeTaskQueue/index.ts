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
  const queue: Array<Task<TType>> = [];
  const callbacks: TaskAddedCallback[] = [];

  function notifyCallbacks(): void {
    for (const callback of callbacks) {
      callback();
    }
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
      queue.push(fullTask);
      notifyCallbacks();
    },

    pop(): Task<TType> | null {
      return queue.shift() ?? null;
    },

    isEmpty(): boolean {
      return queue.length === 0;
    },

    removeTasks(
      predicate: (task: Task<TType>) => boolean,
      onRemove?: (task: Task<TType>) => void,
    ): number {
      const originalLength = queue.length;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const task = queue[i];
        if (!task) {
          continue;
        }
        if (predicate(task)) {
          onRemove?.(task);
          queue.splice(i, 1);
        }
      }
      return originalLength - queue.length;
    },

    clearAll(onRemove?: (task: Task<TType>) => void): number {
      const count = queue.length;
      for (const task of queue) {
        onRemove?.(task);
      }
      queue.length = 0;
      return count;
    },

    onTaskAdded(callback: TaskAddedCallback): () => void {
      callbacks.push(callback);
      return () => {
        const idx = callbacks.indexOf(callback);
        if (idx >= 0) {
          callbacks.splice(idx, 1);
        }
      };
    },

    offTaskAdded(callback: TaskAddedCallback): void {
      const idx = callbacks.indexOf(callback);
      if (idx >= 0) {
        callbacks.splice(idx, 1);
      }
    },
  };
}

/** 创建买入任务队列 */
export function createBuyTaskQueue(): TaskQueue<BuyTaskType> {
  return createTaskQueue<BuyTaskType>();
}

/** 创建卖出任务队列 */
export function createSellTaskQueue(): TaskQueue<SellTaskType> {
  return createTaskQueue<SellTaskType>();
}
