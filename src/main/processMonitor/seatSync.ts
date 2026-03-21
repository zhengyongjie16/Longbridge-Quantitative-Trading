/**
 * 席位同步与队列清理模块
 *
 * 功能：
 * - 同步席位状态到监控上下文（席位状态、版本、标的代码、行情数据）
 * - 当席位状态从 ACTIVE 变为非 ACTIVE 时，清理相关队列和延迟验证信号
 * - 当席位进入 ACTIVATING 时，调度 SEAT_REFRESH 任务执行 admission 与缓存初始化，成功后才进入 ACTIVE
 *
 * 清理触发条件：
 * - 席位状态从 ACTIVE 变为其他状态（EMPTY、SEARCHING、SWITCHING、ACTIVATING）
 * - 清理内容包括：延迟验证信号、待执行买入/卖出任务、监控任务、牛熊证信息
 *
 * 调度触发条件：
 * - 席位进入 ACTIVATING 且标的发生变化
 * - 席位从非 ACTIVATING 进入 ACTIVATING
 */
import { logger } from '../../utils/logger/index.js';
import { resolveMonitorContextRuntimeSnapshot } from '../../utils/utils.js';
import { clearMonitorDirectionQueues } from './utils.js';
import type { SeatSyncParams, SeatSyncResult } from './types.js';

/**
 * 同步席位状态到监控上下文。
 * 从 symbolRegistry 读取最新席位状态并写入 monitorContext；
 * 当席位从 ACTIVE 变为非 ACTIVE 时清理对应方向的队列和牛熊证信息，防止过期信号被执行；
 * 当席位进入 ACTIVATING 时调度 SEAT_REFRESH 任务执行激活屏障；任务仅传递席位快照与标的信息，行情在执行时获取。
 */
export function syncSeatState(params: SeatSyncParams): SeatSyncResult {
  const { monitorSymbol, monitorContext, mainContext, quotesMap, releaseSignal } = params;
  const { riskChecker, delayedSignalVerifier, symbolRegistry } = monitorContext;
  const { buyTaskQueue, sellTaskQueue, monitorTaskQueue } = mainContext;

  const previousSeatState = monitorContext.seatState;
  const previousLongSeatState = previousSeatState.long;
  const previousShortSeatState = previousSeatState.short;

  const runtimeSnapshot = resolveMonitorContextRuntimeSnapshot(
    monitorSymbol,
    symbolRegistry,
    quotesMap,
  );
  const longSeatState = runtimeSnapshot.seatState.long;
  const shortSeatState = runtimeSnapshot.seatState.short;
  const longSeatVersion = runtimeSnapshot.seatVersion.long;
  const shortSeatVersion = runtimeSnapshot.seatVersion.short;
  const longSeatActive = runtimeSnapshot.longSymbol !== null;
  const shortSeatActive = runtimeSnapshot.shortSymbol !== null;
  const longSymbol = runtimeSnapshot.longSymbol ?? '';
  const shortSymbol = runtimeSnapshot.shortSymbol ?? '';
  const longQuote = runtimeSnapshot.longQuote;
  const shortQuote = runtimeSnapshot.shortQuote;

  monitorContext.seatState = runtimeSnapshot.seatState;
  monitorContext.seatVersion = runtimeSnapshot.seatVersion;
  monitorContext.longSymbolName = runtimeSnapshot.longSymbolName;
  monitorContext.shortSymbolName = runtimeSnapshot.shortSymbolName;
  monitorContext.monitorSymbolName = runtimeSnapshot.monitorSymbolName;

  /**
   * 清理指定方向的延迟验证与各类任务队列，并同步清空牛熊证距离缓存。
   * 这样可确保席位从 ACTIVE 退化后不会继续执行过期信号，避免状态漂移。
   *
   * @param direction 席位方向（LONG/SHORT）
   * @returns 无返回值
   */
  function clearDirectionQueues(direction: 'LONG' | 'SHORT'): void {
    const result = clearMonitorDirectionQueues({
      monitorSymbol,
      direction,
      delayedSignalVerifier,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
      releaseSignal,
    });
    const totalRemoved =
      result.removedDelayed + result.removedBuy + result.removedSell + result.removedMonitorTasks;
    if (totalRemoved > 0) {
      logger.debug(
        `[自动换标] ${monitorSymbol} ${direction} 清理待执行信号：延迟=${result.removedDelayed} 买入=${result.removedBuy} 卖出=${result.removedSell} 监控任务=${result.removedMonitorTasks}`,
      );
    }
  }

  function clearWarrantInfoForDirection(direction: 'LONG' | 'SHORT'): void {
    if (direction === 'LONG') {
      riskChecker.clearLongWarrantInfo();
    } else {
      riskChecker.clearShortWarrantInfo();
    }
  }

  if (previousLongSeatState.status === 'ACTIVE' && longSeatState.status !== 'ACTIVE') {
    clearWarrantInfoForDirection('LONG');
    clearDirectionQueues('LONG');
  }

  if (previousShortSeatState.status === 'ACTIVE' && shortSeatState.status !== 'ACTIVE') {
    clearWarrantInfoForDirection('SHORT');
    clearDirectionQueues('SHORT');
  }

  if (
    longSeatState.status === 'ACTIVATING' &&
    (previousLongSeatState.status !== 'ACTIVATING' ||
      longSeatState.symbol !== previousLongSeatState.symbol)
  ) {
    monitorTaskQueue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: `${monitorSymbol}:SEAT_REFRESH:LONG`,
      monitorSymbol,
      data: {
        monitorSymbol,
        direction: 'LONG',
        seatVersion: longSeatVersion,
        previousSymbol: previousLongSeatState.symbol ?? null,
        nextSymbol: longSeatState.symbol ?? '',
        callPrice: longSeatState.callPrice ?? null,
        symbolName: quotesMap.get(longSeatState.symbol ?? '')?.name ?? longSeatState.symbol ?? null,
      },
    });
  }

  if (
    shortSeatState.status === 'ACTIVATING' &&
    (previousShortSeatState.status !== 'ACTIVATING' ||
      shortSeatState.symbol !== previousShortSeatState.symbol)
  ) {
    monitorTaskQueue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: `${monitorSymbol}:SEAT_REFRESH:SHORT`,
      monitorSymbol,
      data: {
        monitorSymbol,
        direction: 'SHORT',
        seatVersion: shortSeatVersion,
        previousSymbol: previousShortSeatState.symbol ?? null,
        nextSymbol: shortSeatState.symbol ?? '',
        callPrice: shortSeatState.callPrice ?? null,
        symbolName:
          quotesMap.get(shortSeatState.symbol ?? '')?.name ?? shortSeatState.symbol ?? null,
      },
    });
  }

  return {
    longSeatState,
    shortSeatState,
    longSeatVersion,
    shortSeatVersion,
    longSeatActive,
    shortSeatActive,
    longSymbol,
    shortSymbol,
    longQuote,
    shortQuote,
  };
}
