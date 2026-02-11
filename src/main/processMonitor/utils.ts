/**
 * @module processMonitor/utils
 * @description processMonitor 模块的工具函数
 *
 * 提供持仓查询等辅助功能，与对象池配合使用
 */
import { positionObjectPool } from '../../utils/objectPool/index.js';
import type { Position, PositionCache, Signal } from '../../types/index.js';
import type { DelayedSignalVerifier } from '../asyncProgram/delayedSignalVerifier/types.js';
import type { TaskQueue, BuyTaskType, SellTaskType } from '../asyncProgram/tradeTaskQueue/types.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskData, MonitorTaskType } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { QueueClearResult } from './types.js';

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

function isMonitorTaskForDirection(
  task: { readonly data: unknown },
  direction: 'LONG' | 'SHORT',
): boolean {
  if (!task.data || typeof task.data !== 'object') {
    return false;
  }
  const data = task.data as Record<string, unknown>;
  const isDirectionMatch = data['direction'] === direction;
  const isSharedTask = 'seatSnapshots' in data || ('long' in data && 'short' in data);
  return isDirectionMatch || isSharedTask;
}

function removeSignalTasks(
  queue: TaskQueue<BuyTaskType> | TaskQueue<SellTaskType>,
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
  releaseSignal: (signal: Signal) => void,
): number {
  return queue.removeTasks(
    (task) => task.monitorSymbol === monitorSymbol && isDirectionAction(task.data?.action, direction),
    (task) => releaseSignal(task.data),
  );
}

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
): { longPosition: Position | null; shortPosition: Position | null } {
  // O(1) 查找
  const longPos = positionCache.get(longSymbol);
  const shortPos = positionCache.get(shortSymbol);

  const longPosition = longPos ? createPositionFromCache(longSymbol, longPos) : null;
  const shortPosition = shortPos ? createPositionFromCache(shortSymbol, shortPos) : null;

  return { longPosition, shortPosition };
}

function createPositionFromCache(symbol: string, source: Position): Position {
  const position = positionObjectPool.acquire() as Position;
  position.symbol = symbol;
  position.costPrice = Number(source.costPrice) || 0;
  position.quantity = Number(source.quantity) || 0;
  position.availableQuantity = Number(source.availableQuantity) || 0;
  position.accountChannel = source.accountChannel;
  position.symbolName = source.symbolName;
  position.currency = source.currency;
  position.market = source.market;
  return position;
}
