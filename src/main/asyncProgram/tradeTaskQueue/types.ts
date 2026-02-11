/**
 * TradeTaskQueue 模块类型定义
 *
 * 定义统一的买入/卖出任务队列类型，包括：
 * - Task: 通用任务类型
 * - TaskQueue: 通用任务队列接口
 * - BuyTaskType / SellTaskType: 任务类型字符串字面量
 */
import type { Signal } from '../../../types/index.js';

/** 任务添加回调函数类型 */
export type TaskAddedCallback = () => void;

/**
 * 通用任务类型
 * @template TType 任务类型字符串字面量
 */
export type Task<TType extends string> = {
  /** 任务唯一标识（UUID） */
  readonly id: string;
  /** 任务类型 */
  readonly type: TType;
  /** 任务数据（信号对象） */
  readonly data: Signal;
  /** 监控标的代码 */
  readonly monitorSymbol: string;
  /** 任务创建时间戳（毫秒） */
  readonly createdAt: number;
};

/**
 * 通用任务队列接口
 * @template TTask 具体任务类型
 */
export interface TaskQueue<TType extends string> {
  /** 入队任务（自动生成 id 和 createdAt） */
  push(task: Omit<Task<TType>, 'id' | 'createdAt'>): void;
  /** 出队任务（返回并移除队首） */
  pop(): Task<TType> | null;
  /** 检查队列是否为空 */
  isEmpty(): boolean;
  /** 按条件移除任务，返回移除数量 */
  removeTasks(
    predicate: (task: Task<TType>) => boolean,
    onRemove?: (task: Task<TType>) => void,
  ): number;
  /** 清空全部任务，返回移除数量 */
  clearAll(onRemove?: (task: Task<TType>) => void): number;
  /** 注册任务添加回调，返回注销函数 */
  onTaskAdded(callback: TaskAddedCallback): () => void;
  /** 注销任务添加回调（传入与 onTaskAdded 相同的引用） */
  offTaskAdded(callback: TaskAddedCallback): void;
}

// ============================================================================
// 买入任务类型
// ============================================================================

/**
 * 买入任务类型
 * - IMMEDIATE_BUY: 立即买入（不经过延迟验证）
 * - VERIFIED_BUY: 验证后买入（经过延迟验证）
 */
export type BuyTaskType = 'IMMEDIATE_BUY' | 'VERIFIED_BUY';

// ============================================================================
// 卖出任务类型
// ============================================================================

/**
 * 卖出任务类型
 * - IMMEDIATE_SELL: 立即卖出（不经过延迟验证）
 * - VERIFIED_SELL: 验证后卖出（经过延迟验证）
 */
export type SellTaskType = 'IMMEDIATE_SELL' | 'VERIFIED_SELL';

