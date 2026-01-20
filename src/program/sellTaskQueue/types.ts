/**
 * SellTaskQueue 类型定义
 */

import type { Signal } from '../../types/index.js';

/**
 * 卖出任务类型
 */
export type SellTaskType = 'IMMEDIATE_SELL' | 'VERIFIED_SELL';

/**
 * 卖出任务
 */
export type SellTask = {
  readonly id: string;
  readonly type: SellTaskType;
  readonly data: Signal;
  readonly monitorSymbol: string;
  readonly createdAt: number;
};

/**
 * 任务添加回调函数
 */
export type SellTaskAddedCallback = () => void;

/**
 * 卖出任务队列接口
 */
export interface SellTaskQueue {
  push(task: Omit<SellTask, 'id' | 'createdAt'>): void;
  pop(): SellTask | null;
  peek(): SellTask | null;
  size(): number;
  isEmpty(): boolean;
  clear(): void;
  onTaskAdded(callback: SellTaskAddedCallback): void;
}
