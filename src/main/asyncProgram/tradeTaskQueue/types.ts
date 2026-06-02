import type { BuySignal, SellSignal, Signal } from '../../../types/signal.js';

/**
 * 任务添加回调函数类型。
 * 类型用途：任务入队时触发通知，用于唤醒等待中的任务处理器。
 * 数据来源：由 TaskQueue.onTaskAdded() 注册，在 push() 时调用。
 * 使用范围：仅在 tradeTaskQueue 模块内部使用。
 */
export type TaskAddedCallback = () => void;

/**
 * 买入任务类型（任务 type 字段字面量）。
 * 类型用途：区分立即买入与验证后买入，供 TaskQueue<BuyTaskType> 与 BuyProcessor 使用。
 * 数据来源：由信号流水线/延迟验证回调在入队时指定。
 * 使用范围：tradeTaskQueue、buyProcessor、业务 runtime 等，仅内部使用。
 */
export type BuyTaskType = 'IMMEDIATE_BUY' | 'VERIFIED_BUY';

/**
 * 卖出任务类型（任务 type 字段字面量）。
 * 类型用途：区分立即卖出与验证后卖出，供 TaskQueue<SellTaskType> 与 SellProcessor 使用。
 * 数据来源：由信号流水线/延迟验证回调在入队时指定。
 * 使用范围：tradeTaskQueue、sellProcessor、业务 runtime 等，仅内部使用。
 */
export type SellTaskType = 'IMMEDIATE_SELL' | 'VERIFIED_SELL';

/**
 * 任务信号类型映射。
 * 类型用途：把任务 type 与允许的 Signal.action 子集绑定，防止买入信号进入卖出队列或反向进入。
 * 数据来源：BuyTaskType/SellTaskType 与 Signal action 业务不变量。
 * 使用范围：Task 与 TaskQueue 类型边界。
 */
export type TaskSignal<TType extends string> = TType extends BuyTaskType
  ? BuySignal
  : TType extends SellTaskType
    ? SellSignal
    : Signal;

/**
 * 通用任务类型（队列元素）。
 * 类型用途：买卖任务队列中的单项，携带 id、type、data（按任务类型约束的 Signal）、monitorSymbol、createdAt；泛型 TType 为 BuyTaskType 或 SellTaskType。
 * 数据来源：由调用方通过 TaskQueue.push() 入队（id、createdAt 由队列生成），由处理器 pop() 消费。
 * 使用范围：tradeTaskQueue、buyProcessor、sellProcessor、业务 runtime 等，仅内部使用。
 */
export type Task<TType extends string> = {
  /** 任务唯一标识（UUID） */
  readonly id: string;

  /** 任务类型 */
  readonly type: TType;

  /** 任务数据（信号对象） */
  readonly data: TaskSignal<TType>;

  /** 监控标的代码 */
  readonly monitorSymbol: string;

  /** 任务创建时间戳（毫秒） */
  readonly createdAt: number;
};

/**
 * 通用任务队列接口（行为契约）。
 * 类型用途：买卖任务队列的入队/出队/清空/按条件移除及任务添加回调；泛型 TType 为 BuyTaskType 或 SellTaskType。
 * 数据来源：由主程序创建（createBuyTaskQueue/createSellTaskQueue），买卖处理器及 signal pipeline 调用。
 * 使用范围：业务 runtime、buyProcessor、sellProcessor、signal pipeline、lifecycle 等，仅内部使用。
 */
export interface TaskQueue<TType extends string> {
  /** 入队任务（自动生成 id 和 createdAt） */
  push: (task: Omit<Task<TType>, 'id' | 'createdAt'>) => void;

  /** 出队任务（返回并移除队首） */
  pop: () => Task<TType> | null;

  /** 检查队列是否为空 */
  isEmpty: () => boolean;

  /** 按条件移除任务，返回移除数量 */
  removeTasks: (
    predicate: (task: Task<TType>) => boolean,
    onRemove?: (task: Task<TType>) => void,
  ) => number;

  /** 清空全部任务，返回移除数量 */
  clearAll: (onRemove?: (task: Task<TType>) => void) => number;

  /** 注册任务添加回调，返回注销函数 */
  onTaskAdded: (callback: TaskAddedCallback) => () => void;
}
