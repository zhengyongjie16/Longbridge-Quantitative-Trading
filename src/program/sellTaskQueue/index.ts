/**
 * SellTaskQueue 实现
 * 缓冲待处理的卖出交易任务，支持 FIFO 顺序处理
 */

import { randomUUID } from 'node:crypto';
import type { SellTask, SellTaskQueue, SellTaskAddedCallback } from './types.js';

// 导出类型
export type { SellTask, SellTaskType, SellTaskQueue, SellTaskAddedCallback } from './types.js';

/**
 * 创建卖出任务队列
 */
export const createSellTaskQueue = (): SellTaskQueue => {
  const queue: SellTask[] = [];
  const callbacks: SellTaskAddedCallback[] = [];

  const notifyCallbacks = (): void => {
    for (const callback of callbacks) {
      callback();
    }
  };

  return {
    push(task: Omit<SellTask, 'id' | 'createdAt'>): void {
      const fullTask: SellTask = {
        id: randomUUID(),
        type: task.type,
        data: task.data,
        monitorSymbol: task.monitorSymbol,
        createdAt: Date.now(),
      };
      queue.push(fullTask);
      notifyCallbacks();
    },

    pop(): SellTask | null {
      return queue.shift() ?? null;
    },

    peek(): SellTask | null {
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

    onTaskAdded(callback: SellTaskAddedCallback): void {
      callbacks.push(callback);
    },
  };
};
