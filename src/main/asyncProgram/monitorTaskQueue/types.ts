/**
 * 监控任务队列类型定义
 *
 * 定义监控任务队列相关的类型：
 * - MonitorTask：完整的任务结构（含 ID 和时间戳）
 * - MonitorTaskInput：任务入队时的输入结构
 * - MonitorTaskQueue：队列接口
 */

export type TaskAddedCallback = () => void;

export type MonitorTask<TType extends string, TData> = Readonly<{
  id: string;
  type: TType;
  dedupeKey: string;
  monitorSymbol: string;
  data: TData;
  createdAt: number;
}>;

export type MonitorTaskInput<TType extends string, TData> = Readonly<{
  type: TType;
  dedupeKey: string;
  monitorSymbol: string;
  data: TData;
}>;

export type MonitorTaskQueue<TType extends string, TData> = Readonly<{
  scheduleLatest: (task: MonitorTaskInput<TType, TData>) => void;
  pop: () => MonitorTask<TType, TData> | null;
  isEmpty: () => boolean;
  removeTasks: (
    predicate: (task: MonitorTask<TType, TData>) => boolean,
    onRemove?: (task: MonitorTask<TType, TData>) => void,
  ) => number;
  onTaskAdded: (callback: TaskAddedCallback) => void;
}>;
