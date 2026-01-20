/**
 * TradeTaskQueue 类型定义
 */

import type { Signal } from '../../types/index.js';

/**
 * 任务类型
 */
export type TaskType = 'IMMEDIATE_SIGNAL' | 'VERIFIED_SIGNAL';

/**
 * 交易任务
 */
export type TradeTask = {
  readonly id: string;
  readonly type: TaskType;
  readonly data: Signal;
  readonly monitorSymbol: string;
  readonly createdAt: number;
};

/**
 * 任务添加回调函数
 */
export type TaskAddedCallback = () => void;

/**
 * 交易任务队列接口
 */
export interface TradeTaskQueue {
  push(task: Omit<TradeTask, 'id' | 'createdAt'>): void;
  pop(): TradeTask | null;
  peek(): TradeTask | null;
  size(): number;
  isEmpty(): boolean;
  clear(): void;
  onTaskAdded(callback: TaskAddedCallback): void;
}
