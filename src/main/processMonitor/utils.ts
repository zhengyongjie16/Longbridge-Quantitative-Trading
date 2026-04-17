import { isRecord } from '../../utils/helpers/index.js';
import { SIGNAL_ACTION_DESCRIPTIONS } from '../../constants/index.js';
import type { Signal, SignalType } from '../../types/signal.js';
import type { DelayedSignalVerifierPort } from '../../types/monitorContextPorts.js';
import type { TaskQueue, BuyTaskType, SellTaskType } from '../asyncProgram/tradeTaskQueue/types.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { QueueClearResult } from '../../types/queue.js';

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
  return direction === 'LONG' ? isLongAction : !isLongAction;
}

/**
 * 判断监控任务是否属于指定方向（含共享任务）。
 *
 * @param task 监控任务对象
 * @param direction 方向（LONG 或 SHORT）
 * @returns 方向匹配或为共享任务时返回 true
 */
function isMonitorTaskForDirection(
  task: { readonly data: unknown },
  direction: 'LONG' | 'SHORT',
): boolean {
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
 * 从买入或卖出队列中移除指定监控标的和方向的信号任务，并释放信号对象到对象池。
 *
 * @param queue 买入或卖出任务队列
 * @param monitorSymbol 监控标的代码
 * @param direction 方向（LONG 或 SHORT）
 * @param releaseSignal 信号对象释放回调（归还对象池）
 * @returns 移除的任务数量
 */
function removeSignalTasks(
  queue: TaskQueue<BuyTaskType> | TaskQueue<SellTaskType>,
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
  releaseSignal: (signal: Signal) => void,
): number {
  return queue.removeTasks(
    (task) =>
      task.monitorSymbol === monitorSymbol && isDirectionAction(task.data.action, direction),
    (task) => {
      releaseSignal(task.data);
    },
  );
}

/**
 * 清理指定监控标的和方向的所有队列任务（延迟验证、买入、卖出、监控任务队列）。
 *
 * @param params 清理参数，包含 monitorSymbol、direction、各队列实例及 releaseSignal 回调
 * @returns 各队列移除的任务数量汇总（removedDelayed、removedBuy、removedSell、removedMonitorTasks）
 */
export function clearMonitorDirectionQueues(params: {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly delayedSignalVerifier: DelayedSignalVerifierPort;
  readonly buyTaskQueue: TaskQueue<BuyTaskType>;
  readonly sellTaskQueue: TaskQueue<SellTaskType>;
  readonly monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
  readonly releaseSignal: (signal: Signal) => void;
}): QueueClearResult {
  const {
    monitorSymbol,
    direction,
    delayedSignalVerifier,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    releaseSignal,
  } = params;

  const removedDelayed = delayedSignalVerifier.cancelAllForDirection(monitorSymbol, direction);
  const removedBuy = removeSignalTasks(buyTaskQueue, monitorSymbol, direction, releaseSignal);
  const removedSell = removeSignalTasks(sellTaskQueue, monitorSymbol, direction, releaseSignal);
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
 * 格式化信号日志（标的显示为「中文名称(代码）」）。默认行为：reason 为空时使用「策略信号」。
 *
 * @param signal 包含 action、symbol、symbolName、reason 的对象
 * @returns 格式化后的信号日志字符串
 */
export function formatSignalLog(signal: {
  readonly action: SignalType;
  readonly symbol: string;
  readonly symbolName?: string | null;
  readonly reason?: string | null;
}): string {
  const actionDesc = SIGNAL_ACTION_DESCRIPTIONS[signal.action];
  const symbolDisplay = signal.symbolName
    ? `${signal.symbolName}(${signal.symbol})`
    : signal.symbol;
  const reason =
    signal.reason === null || signal.reason === undefined || signal.reason === ''
      ? '策略信号'
      : signal.reason;
  return `${actionDesc} ${symbolDisplay} - ${reason}`;
}
