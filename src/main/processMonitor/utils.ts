import { positionObjectPool } from '../../utils/objectPool/index.js';
import type { Position } from '../../types/account.js';
import type { Signal } from '../../types/signal.js';
import type { PositionCache } from '../../types/services.js';
import type { DelayedSignalVerifier } from '../asyncProgram/delayedSignalVerifier/types.js';
import type { TaskQueue, BuyTaskType, SellTaskType } from '../asyncProgram/tradeTaskQueue/types.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type {
  MonitorTaskData,
  MonitorTaskType,
} from '../asyncProgram/monitorTaskProcessor/types.js';
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
  if (!task.data || typeof task.data !== 'object') {
    return false;
  }
  // 这里只做通用方向过滤，调用点已保证 task.data 为对象结构
  const data = task.data as Record<string, unknown>;
  const isDirectionMatch = data['direction'] === direction;
  const isSharedTask = 'seatSnapshots' in data || ('long' in data && 'short' in data);
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
    (task) => { releaseSignal(task.data); },
  );
}

/**
 * 清理指定监控标的和方向的所有队列任务（延迟验证、买入、卖出、监控任务队列）。
 *
 * @param params 清理参数，包含 monitorSymbol、direction、各队列实例及 releaseSignal 回调
 * @returns 各队列移除的任务数量汇总（removedDelayed、removedBuy、removedSell、removedMonitorTasks）
 */
export function clearQueuesForDirection(params: {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly delayedSignalVerifier: DelayedSignalVerifier;
  readonly buyTaskQueue: TaskQueue<BuyTaskType>;
  readonly sellTaskQueue: TaskQueue<SellTaskType>;
  readonly monitorTaskQueue: MonitorTaskQueue<MonitorTaskType, MonitorTaskData>;
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
 * 从持仓缓存中获取指定标的的持仓
 *
 * 使用 PositionCache 提供 O(1) 查找，并从对象池获取 Position 对象
 * 注意：调用方需负责释放返回的 Position 对象到对象池
 *
 * @param positionCache 持仓缓存（O(1) 查找）
 * @param longSymbol 做多标的代码
 * @param shortSymbol 做空标的代码
 * @returns longPosition 和 shortPosition，无持仓时为 null
 */
export function getPositions(
  positionCache: PositionCache,
  longSymbol: string,
  shortSymbol: string,
): Readonly<{ longPosition: Position | null; shortPosition: Position | null }> {
  const longPos = positionCache.get(longSymbol);
  const shortPos = positionCache.get(shortSymbol);

  const longPosition = longPos ? createPositionFromCache(longSymbol, longPos) : null;
  const shortPosition = shortPos ? createPositionFromCache(shortSymbol, shortPos) : null;

  return { longPosition, shortPosition };
}

/**
 * 从持仓缓存数据构造对象池 Position 实例，用于信号流水线等处的持仓查找。调用方需负责将返回对象释放回对象池。
 *
 * @param symbol 标的代码
 * @param source 持仓缓存中的原始持仓数据
 * @returns 从对象池获取并填充字段后的 Position 对象（调用方负责释放）
 */
function createPositionFromCache(symbol: string, source: Position): Position {
  // 对象池返回 PoolablePosition，这里通过字段覆盖构造出完整的 Position
  const position = positionObjectPool.acquire();
  position.symbol = symbol;
  position.costPrice = source.costPrice || 0;
  position.quantity = source.quantity || 0;
  position.availableQuantity = source.availableQuantity || 0;
  position.accountChannel = source.accountChannel;
  position.symbolName = source.symbolName;
  position.currency = source.currency;
  position.market = source.market;
  return position as Position;
}
