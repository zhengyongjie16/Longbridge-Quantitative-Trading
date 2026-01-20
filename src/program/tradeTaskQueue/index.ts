/**
 * TradeTaskQueue 实现
 * 缓冲待处理的常规交易任务，支持 FIFO 顺序处理
 */

import { randomUUID } from 'node:crypto';
import type { TradeTask, TradeTaskQueue, TaskAddedCallback } from './types.js';

// 导出类型
export type { TradeTask, TaskType, TradeTaskQueue, TaskAddedCallback } from './types.js';

/**
 * 创建交易任务队列
 */
export const createTradeTaskQueue = (): TradeTaskQueue => {
  const queue: TradeTask[] = [];
  const callbacks: TaskAddedCallback[] = [];

  const notifyCallbacks = (): void => {
    for (const callback of callbacks) {
      callback();
    }
  };

  return {
    push(task: Omit<TradeTask, 'id' | 'createdAt'>): void {
      const fullTask: TradeTask = {
        id: randomUUID(),
        type: task.type,
        data: task.data,
        monitorSymbol: task.monitorSymbol,
        createdAt: Date.now(),
      };
      queue.push(fullTask);
      notifyCallbacks();
    },

    pop(): TradeTask | null {
      return queue.shift() ?? null;
    },

    peek(): TradeTask | null {
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
};
