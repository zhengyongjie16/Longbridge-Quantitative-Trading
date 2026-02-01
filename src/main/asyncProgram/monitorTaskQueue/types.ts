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
  peek: () => MonitorTask<TType, TData> | null;
  size: () => number;
  isEmpty: () => boolean;
  removeTasks: (
    predicate: (task: MonitorTask<TType, TData>) => boolean,
    onRemove?: (task: MonitorTask<TType, TData>) => void,
  ) => number;
  onTaskAdded: (callback: TaskAddedCallback) => void;
}>;
