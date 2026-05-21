/**
 * 席位运行态队列清理模块
 *
 * 职责：
 * - 按监控标的和方向清理延迟验证、买卖任务与监控任务
 * - 为席位退场事件 owner 提供统一清理统计
 */
import { isRecord } from '../../utils/helpers/index.js';
import type { DelayedSignalVerifierPort } from '../../types/monitorContextPorts.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { BuyTaskType, SellTaskType, TaskQueue } from '../asyncProgram/tradeTaskQueue/types.js';
import type { QueueClearResult } from './types.js';

/**
 * 判断订单动作是否属于指定方向。
 *
 * @param action 订单动作字符串（如 BUYCALL / SELLPUT）
 * @param direction 方向（LONG 或 SHORT）
 * @returns 匹配返回 true，否则返回 false
 */
function isDirectionAction(
  action: string | null | undefined,
  direction: 'LONG' | 'SHORT',
): boolean {
  if (!action) {
    return false;
  }

  const isLongAction = action === 'BUYCALL' || action === 'SELLCALL';
  const isShortAction = action === 'BUYPUT' || action === 'SELLPUT';
  return direction === 'LONG' ? isLongAction : isShortAction;
}

/**
 * 判断监控任务是否属于指定方向。
 *
 * @param task 监控任务对象
 * @param direction 方向（LONG 或 SHORT）
 * @returns 方向匹配时返回 true
 */
function isMonitorTaskForDirection(
  task: { readonly type?: unknown; readonly data: unknown },
  direction: 'LONG' | 'SHORT',
): boolean {
  if (task.type === 'SEAT_REFRESH') {
    return false;
  }

  if (!isRecord(task.data)) {
    return false;
  }

  const isDirectionMatch = task.data['direction'] === direction;
  const isSharedTask =
    Object.hasOwn(task.data, 'seatSnapshots') ||
    (Object.hasOwn(task.data, 'long') && Object.hasOwn(task.data, 'short'));
  return isDirectionMatch || isSharedTask;
}

/**
 * 从买入或卖出队列中移除指定监控标的和方向的信号任务。
 *
 * @param queue 买入或卖出任务队列
 * @param monitorSymbol 监控标的代码
 * @param direction 方向（LONG 或 SHORT）
 * @returns 移除的任务数量
 */
function removeSignalTasks(
  queue: TaskQueue<BuyTaskType> | TaskQueue<SellTaskType>,
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
): number {
  return queue.removeTasks(
    (task) =>
      task.monitorSymbol === monitorSymbol && isDirectionAction(task.data.action, direction),
  );
}

/**
 * 清理指定监控标的和方向的可取消队列任务，并保留 SEAT_REFRESH。
 *
 * @param params 清理参数，包含 monitorSymbol、direction 与各队列实例
 * @returns 各队列移除的任务数量汇总
 */
export function clearMonitorDirectionQueues(params: {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly delayedSignalVerifier: DelayedSignalVerifierPort;
  readonly buyTaskQueue: TaskQueue<BuyTaskType>;
  readonly sellTaskQueue: TaskQueue<SellTaskType>;
  readonly monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
}): QueueClearResult {
  const {
    monitorSymbol,
    direction,
    delayedSignalVerifier,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
  } = params;

  const removedDelayed = delayedSignalVerifier.cancelAllForDirection(monitorSymbol, direction);
  const removedBuy = removeSignalTasks(buyTaskQueue, monitorSymbol, direction);
  const removedSell = removeSignalTasks(sellTaskQueue, monitorSymbol, direction);
  const removedMonitorTasks = monitorTaskQueue.removeTasks(
    (task) => task.monitorSymbol === monitorSymbol && isMonitorTaskForDirection(task, direction),
  );

  return {
    removedDelayed,
    removedBuy,
    removedSell,
    removedMonitorTasks,
  };
}

/**
 * 按统一口径记录方向性队列清理统计日志。
 *
 * @param params 清理日志参数，包含来源、标的、方向、清理结果与 logger
 * @returns 无返回值
 */
export function logDirectionQueueCleanup(params: {
  readonly source: string;
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly result: QueueClearResult;
  readonly logger: { debug: (message: string) => void };
}): void {
  const { source, monitorSymbol, direction, result, logger } = params;
  const totalRemoved =
    result.removedDelayed + result.removedBuy + result.removedSell + result.removedMonitorTasks;
  if (totalRemoved <= 0) {
    return;
  }

  logger.debug(
    `[${source}] ${monitorSymbol} ${direction} 清理待执行信号：延迟=${result.removedDelayed} 买入=${result.removedBuy} 卖出=${result.removedSell} 监控任务=${result.removedMonitorTasks}`,
  );
}
