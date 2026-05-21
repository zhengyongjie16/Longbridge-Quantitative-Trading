/**
 * 席位运行态清理 dispatcher 类型定义
 *
 * 职责：
 * - 定义 seat state event 驱动的方向运行态清理 owner 契约
 * - 约束清理所需的 SymbolRegistry、监控上下文与任务队列依赖
 */
import type { MonitorContext } from '../../types/state.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { BuyTaskType, SellTaskType, TaskQueue } from '../asyncProgram/tradeTaskQueue/types.js';

/**
 * 席位运行态清理 dispatcher 依赖。
 * 数据来源：app post-gate runtime 装配阶段注入的权威席位注册表、监控上下文和任务队列。
 * 使用范围：仅 SeatRuntimeCleanupDispatcher 工厂使用。
 */
export type SeatRuntimeCleanupDispatcherDeps = Readonly<{
  symbolRegistry: SymbolRegistry;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
}>;

/**
 * 队列清理结果。
 * 类型用途：clearMonitorDirectionQueues 队列清理函数的返回结果，供席位退场事件 owner 统计移除数量。
 * 数据来源：由 seatRuntimeCleanupDispatcher 的方向队列清理计算并返回。
 * 使用范围：seatRuntimeCleanupDispatcher 内部使用。
 */
export type QueueClearResult = Readonly<{
  removedDelayed: number;
  removedBuy: number;
  removedSell: number;
  removedMonitorTasks: number;
}>;

/**
 * 席位运行态清理 dispatcher。
 * 数据来源：由 createSeatRuntimeCleanupDispatcher 创建。
 * 使用范围：app 装配、lifecycle 与 cleanup。
 */
export interface SeatRuntimeCleanupDispatcher {
  readonly start: () => void;
  readonly stop: () => void;
}
