import type { TaskAddedCallback } from '../tradeTaskQueue/types.js';

/**
 * 监控任务
 *
 * 队列中的单个监控任务，携带类型、去重键、标的代码和任务数据。
 * 由 MonitorTaskQueue.scheduleLatest 写入，MonitorTaskProcessor 消费。
 */
export type MonitorTask<TType extends string, TData> = Readonly<{
  id: string;
  type: TType;
  dedupeKey: string;
  monitorSymbol: string;
  data: TData;
  createdAt: number;
}>;

/**
 * 监控任务入队参数
 *
 * 调用方提交任务时传入的数据，不含 id 和 createdAt（由队列自动生成）。
 * 仅供 MonitorTaskQueue.scheduleLatest 使用。
 */
export type MonitorTaskInput<TType extends string, TData> = Readonly<{
  type: TType;
  dedupeKey: string;
  monitorSymbol: string;
  data: TData;
}>;

/**
 * 监控任务队列行为契约
 *
 * 基于去重键的最新任务调度队列：同一 dedupeKey 的新任务会替换旧任务，
 * 确保处理器始终消费最新状态。仅供 MonitorTaskProcessor 消费。
 */
export interface MonitorTaskQueue<TType extends string, TData> {
  readonly scheduleLatest: (task: MonitorTaskInput<TType, TData>) => void;
  readonly pop: () => MonitorTask<TType, TData> | null;
  readonly isEmpty: () => boolean;
  readonly removeTasks: (
    predicate: (task: MonitorTask<TType, TData>) => boolean,
    onRemove?: (task: MonitorTask<TType, TData>) => void,
  ) => number;
  readonly clearAll: (onRemove?: (task: MonitorTask<TType, TData>) => void) => number;
  readonly onTaskAdded: (callback: TaskAddedCallback) => () => void;
}
