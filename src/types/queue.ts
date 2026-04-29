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
