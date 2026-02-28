/**
 * 队列清理结果。
 * 类型用途：clearMonitorDirectionQueues 等队列清理函数的返回结果，供主程序或调用方统计移除数量。
 * 数据来源：由 clearMonitorDirectionQueues(params) 计算并返回。
 * 使用范围：processMonitor、bootstrap 与工具函数使用。
 */
export type QueueClearResult = Readonly<{
  removedDelayed: number;
  removedBuy: number;
  removedSell: number;
  removedMonitorTasks: number;
}>;
