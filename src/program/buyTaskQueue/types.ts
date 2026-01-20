/**
 * BuyTaskQueue 类型定义
 * 专用于买入信号的任务队列
 */

import type { Signal } from '../../types/index.js';

/**
 * 买入任务类型
 */
export type BuyTaskType = 'IMMEDIATE_BUY' | 'VERIFIED_BUY';

/**
 * 买入任务
 */
export type BuyTask = {
  readonly id: string;
  readonly type: BuyTaskType;
  readonly data: Signal;
  readonly monitorSymbol: string;
  readonly createdAt: number;
};

/**
 * 任务添加回调函数
 */
export type BuyTaskAddedCallback = () => void;

/**
 * 买入任务队列接口
 */
export interface BuyTaskQueue {
  push(task: Omit<BuyTask, 'id' | 'createdAt'>): void;
  pop(): BuyTask | null;
  peek(): BuyTask | null;
  size(): number;
  isEmpty(): boolean;
  clear(): void;
  onTaskAdded(callback: BuyTaskAddedCallback): void;
}
