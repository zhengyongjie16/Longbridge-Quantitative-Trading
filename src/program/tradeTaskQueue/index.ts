/**
 * TradeTaskQueue 模块
 * 提供买入/卖出任务队列的创建和管理
 */

import { randomUUID } from 'node:crypto';
import type { Task, TaskQueue, TaskAddedCallback, BuyTask, BuyTaskQueue, SellTask, SellTaskQueue } from './types.js';

/**
 * 创建通用任务队列
 * @template TTask 具体任务类型
 * @returns TaskQueue<TTask> 任务队列实例
 */
function createTaskQueue<TTask extends Task<string>>(): TaskQueue<TTask> {
  const queue: TTask[] = [];
  const callbacks: TaskAddedCallback[] = [];

  const notifyCallbacks = (): void => {
    for (const callback of callbacks) {
      callback();
    }
  };

  return {
    push(task: Omit<TTask, 'id' | 'createdAt'>): void {
      const fullTask = {
        id: randomUUID(),
        type: task.type,
        data: task.data,
        monitorSymbol: task.monitorSymbol,
        createdAt: Date.now(),
      } as TTask;
      queue.push(fullTask);
      notifyCallbacks();
    },

    pop(): TTask | null {
      return queue.shift() ?? null;
    },

    peek(): TTask | null {
      return queue[0] ?? null;
    },

    size(): number {
      return queue.length;
    },

    isEmpty(): boolean {
      return queue.length === 0;
    },

    clear(): void {
      queue.length = 0;
    },

    onTaskAdded(callback: TaskAddedCallback): void {
      callbacks.push(callback);
    },
  };
}

/**
 * 创建买入任务队列
 */
export function createBuyTaskQueue(): BuyTaskQueue {
  return createTaskQueue<BuyTask>();
}

/**
 * 创建卖出任务队列
 */
export function createSellTaskQueue(): SellTaskQueue {
  return createTaskQueue<SellTask>();
}
