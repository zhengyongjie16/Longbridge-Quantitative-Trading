import type { TaskAddedCallback } from '../tradeTaskQueue/types.js';

type MonitorTaskDataMapBase = Readonly<Record<string, unknown>>;

type MonitorTaskByDataMap<
  TDataMap extends MonitorTaskDataMapBase,
  TType extends keyof TDataMap = keyof TDataMap,
> = TType extends keyof TDataMap
  ? Readonly<{
      id: string;
      type: TType;
      dedupeKey: string;
      monitorSymbol: string;
      data: TDataMap[TType];
      createdAt: number;
    }>
  : never;

type MonitorTaskInputByDataMap<
  TDataMap extends MonitorTaskDataMapBase,
  TType extends keyof TDataMap = keyof TDataMap,
> = TType extends keyof TDataMap
  ? Readonly<{
      type: TType;
      dedupeKey: string;
      monitorSymbol: string;
      data: TDataMap[TType];
    }>
  : never;

/**
 * 监控任务（队列元素）。
 * 类型用途：监控任务队列中的单项，携带 id、type、dedupeKey、monitorSymbol、data、createdAt；由 Processor 消费。
 * 数据来源：由 scheduleLatest 写入（id、createdAt 由队列生成），MonitorTaskProcessor 出队消费。
 * 使用范围：仅 monitorTaskQueue、monitorTaskProcessor、mainProgram 等内部使用。
 */
export type MonitorTask<
  TDataMap extends MonitorTaskDataMapBase,
  TType extends keyof TDataMap = keyof TDataMap,
> = MonitorTaskByDataMap<TDataMap, TType>;

/**
 * 监控任务入队参数（scheduleLatest 的入参）。
 * 类型用途：调用方提交任务时传入的数据，不含 id 和 createdAt（由队列自动生成）。
 * 数据来源：由 processMonitor 等调用方在调度监控任务时组装传入。
 * 使用范围：仅 MonitorTaskQueue.scheduleLatest 的调用方与实现使用，内部使用。
 */
export type MonitorTaskInput<
  TDataMap extends MonitorTaskDataMapBase,
  TType extends keyof TDataMap = keyof TDataMap,
> = MonitorTaskInputByDataMap<TDataMap, TType>;

/**
 * 监控任务队列行为契约。
 * 类型用途：基于去重键的最新任务调度（scheduleLatest 替换同 key 旧任务），pop/isEmpty/removeTasks/clearAll/onTaskAdded；供 MonitorTaskProcessor 消费。
 * 数据来源：主程序创建，processMonitor 等调用 scheduleLatest，MonitorTaskProcessor 消费 pop。
 * 使用范围：mainProgram、monitorTaskProcessor、processMonitor 等，仅内部使用。
 */
export interface MonitorTaskQueue<TDataMap extends MonitorTaskDataMapBase> {
  readonly scheduleLatest: <TType extends keyof TDataMap>(
    task: MonitorTaskInput<TDataMap, TType>,
  ) => void;
  readonly pop: () => MonitorTask<TDataMap> | null;
  readonly isEmpty: () => boolean;
  readonly removeTasks: (
    predicate: (task: MonitorTask<TDataMap>) => boolean,
    onRemove?: (task: MonitorTask<TDataMap>) => void,
  ) => number;
  readonly clearAll: (onRemove?: (task: MonitorTask<TDataMap>) => void) => number;
  readonly onTaskAdded: (callback: TaskAddedCallback) => () => void;
}
