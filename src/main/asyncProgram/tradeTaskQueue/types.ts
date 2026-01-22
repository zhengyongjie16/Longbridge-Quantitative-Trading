/**
 * TradeTaskQueue 类型定义
 * 统一的买入/卖出任务队列类型
 */

import type { Signal } from '../../../types/index.js';

/**
 * 任务添加回调函数
 */
export type TaskAddedCallback = () => void;

/**
 * 通用任务类型
 * @template TType 任务类型字符串字面量
 */
export type Task<TType extends string> = {
  readonly id: string;
  readonly type: TType;
  readonly data: Signal;
  readonly monitorSymbol: string;
  readonly createdAt: number;
};

/**
 * 通用任务队列接口
 * @template TTask 具体任务类型
 */
export interface TaskQueue<TTask extends Task<string>> {
  push(task: Omit<TTask, 'id' | 'createdAt'>): void;
  pop(): TTask | null;
  peek(): TTask | null;
  size(): number;
  isEmpty(): boolean;
  clear(): void;
  onTaskAdded(callback: TaskAddedCallback): void;
}

// ============================================================================
// 买入任务队列类型
// ============================================================================

/**
 * 买入任务类型
 */
export type BuyTaskType = 'IMMEDIATE_BUY' | 'VERIFIED_BUY';

/**
 * 买入任务
 */
export type BuyTask = Task<BuyTaskType>;

// ============================================================================
// 卖出任务队列类型
// ============================================================================

/**
 * 卖出任务类型
 */
export type SellTaskType = 'IMMEDIATE_SELL' | 'VERIFIED_SELL';

/**
 * 卖出任务
 */
export type SellTask = Task<SellTaskType>;

