/**
 * @module processMonitor/seatSync
 * @description 席位同步/队列清理/SEAT_REFRESH 调度
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
    riskChecker.clearWarrantInfo(direction === 'LONG');
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
