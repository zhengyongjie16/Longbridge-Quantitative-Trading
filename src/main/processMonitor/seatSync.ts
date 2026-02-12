/**
 * 席位同步与队列清理模块
 *
 * 功能：
 * - 同步席位状态到监控上下文（席位状态、版本、标的代码、行情数据）
 * - 当席位状态从 READY 变为非 READY 时，清理相关队列和延迟验证信号
 * - 当席位标的发生变化时，调度 SEAT_REFRESH 任务刷新订单记录、浮亏数据及牛熊证缓存
 *
 * 清理触发条件：
 * - 席位状态从 READY 变为其他状态（EMPTY、SEARCHING、SWITCHING）
 * - 清理内容包括：延迟验证信号、待执行买入/卖出任务、监控任务、牛熊证信息
 *
 * 调度触发条件：
 * - 席位就绪且标的发生变化
 * - 席位从不就绪变为就绪
 *
 * @param params 同步参数，包含监控标的、上下文、行情映射等
 * @returns 同步结果，包含席位状态、版本、就绪状态等
 */
import { logger } from '../../utils/logger/index.js';
import { isSeatReady } from '../../services/autoSymbolManager/utils.js';
import { clearQueuesForDirection as clearQueuesForDirectionUtil } from './utils.js';
import type { SeatSyncParams, SeatSyncResult } from './types.js';

export function syncSeatState(params: SeatSyncParams): SeatSyncResult {
  const {
    monitorSymbol,
    monitorQuote,
    monitorContext,
    mainContext,
    quotesMap,
    releaseSignal,
  } = params;
  const { riskChecker, delayedSignalVerifier, symbolRegistry } = monitorContext;
  const { buyTaskQueue, sellTaskQueue, monitorTaskQueue } = mainContext;

  const previousSeatState = monitorContext.seatState;
  const previousLongSeatState = previousSeatState.long;
  const previousShortSeatState = previousSeatState.short;

  const longSeatState = symbolRegistry.getSeatState(monitorSymbol, 'LONG');
  const shortSeatState = symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
  const longSeatVersion = symbolRegistry.getSeatVersion(monitorSymbol, 'LONG');
  const shortSeatVersion = symbolRegistry.getSeatVersion(monitorSymbol, 'SHORT');

  monitorContext.seatState = {
    long: longSeatState,
    short: shortSeatState,
  };
  monitorContext.seatVersion = {
    long: longSeatVersion,
    short: shortSeatVersion,
  };

  const longSeatReady = isSeatReady(longSeatState);
  const shortSeatReady = isSeatReady(shortSeatState);
  const longSymbol = longSeatReady ? longSeatState.symbol : '';
  const shortSymbol = shortSeatReady ? shortSeatState.symbol : '';

  const longQuote = longSeatReady ? (quotesMap.get(longSymbol) ?? null) : null;
  const shortQuote = shortSeatReady ? (quotesMap.get(shortSymbol) ?? null) : null;

  monitorContext.longQuote = longQuote;
  monitorContext.shortQuote = shortQuote;
  monitorContext.monitorQuote = monitorQuote;

  if (longSeatReady) {
    monitorContext.longSymbolName = longQuote?.name ?? longSymbol;
  }
  if (shortSeatReady) {
    monitorContext.shortSymbolName = shortQuote?.name ?? shortSymbol;
  }

  function clearQueuesForDirection(direction: 'LONG' | 'SHORT'): void {
    const result = clearQueuesForDirectionUtil({
      monitorSymbol,
      direction,
      delayedSignalVerifier,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
      releaseSignal,
    });
    const totalRemoved =
      result.removedDelayed +
      result.removedBuy +
      result.removedSell +
      result.removedMonitorTasks;
    if (totalRemoved > 0) {
      logger.info(
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

  if (previousLongSeatState.status === 'READY' && longSeatState.status !== 'READY') {
    clearWarrantInfoForDirection('LONG');
    clearQueuesForDirection('LONG');
  }
  if (previousShortSeatState.status === 'READY' && shortSeatState.status !== 'READY') {
    clearWarrantInfoForDirection('SHORT');
    clearQueuesForDirection('SHORT');
  }

  if (
    longSeatReady
    && (longSeatState.symbol !== previousLongSeatState.symbol
      || previousLongSeatState.status !== 'READY')
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
        nextSymbol: longSeatState.symbol,
        callPrice: longSeatState.callPrice ?? null,
        quote: longQuote,
        symbolName: monitorContext.longSymbolName ?? null,
        quotesMap,
      },
    });
  }
  if (
    shortSeatReady
    && (shortSeatState.symbol !== previousShortSeatState.symbol
      || previousShortSeatState.status !== 'READY')
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
        nextSymbol: shortSeatState.symbol,
        callPrice: shortSeatState.callPrice ?? null,
        quote: shortQuote,
        symbolName: monitorContext.shortSymbolName ?? null,
        quotesMap,
      },
    });
  }

  return {
    longSeatState,
    shortSeatState,
    longSeatVersion,
    shortSeatVersion,
    longSeatReady,
    shortSeatReady,
    longSymbol,
    shortSymbol,
    longQuote,
    shortQuote,
  };
}
