/**
 * BuyTaskQueue 实现
 * 缓冲待处理的买入任务，支持 FIFO 顺序处理
 */

import { randomUUID } from 'node:crypto';
import type { BuyTask, BuyTaskQueue, BuyTaskAddedCallback } from './types.js';

// 导出类型
export type { BuyTask, BuyTaskType, BuyTaskQueue, BuyTaskAddedCallback } from './types.js';

/**
 * 创建买入任务队列
 */
export const createBuyTaskQueue = (): BuyTaskQueue => {
  const queue: BuyTask[] = [];
  const callbacks: BuyTaskAddedCallback[] = [];

  const notifyCallbacks = (): void => {
    for (const callback of callbacks) {
      callback();
    }
  };

  return {
    push(task: Omit<BuyTask, 'id' | 'createdAt'>): void {
      const fullTask: BuyTask = {
        id: randomUUID(),
        type: task.type,
        data: task.data,
        monitorSymbol: task.monitorSymbol,
        createdAt: Date.now(),
      };
      queue.push(fullTask);
      notifyCallbacks();
    },

    pop(): BuyTask | null {
      return queue.shift() ?? null;
    },

    peek(): BuyTask | null {
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

    onTaskAdded(callback: BuyTaskAddedCallback): void {
      callbacks.push(callback);
    },
  };
};
