/**
 * @module processMonitor/autoSymbolTasks
 * @description AUTO_SYMBOL 任务调度
 */
import type { AutoSymbolTasksParams } from './types.js';

export function scheduleAutoSymbolTasks(params: AutoSymbolTasksParams): void {
  const {
    monitorSymbol,
    monitorContext,
    mainContext,
    autoSearchEnabled,
    currentTimeMs,
    canTradeNow,
    monitorPriceChanged,
    resolvedMonitorPrice,
    quotesMap,
  } = params;

  if (!autoSearchEnabled) {
    return;
  }

  const { autoSymbolManager, symbolRegistry } = monitorContext;
  const { monitorTaskQueue } = mainContext;

  const longSeatSnapshot = symbolRegistry.getSeatState(monitorSymbol, 'LONG');
  const shortSeatSnapshot = symbolRegistry.getSeatState(monitorSymbol, 'SHORT');

  monitorTaskQueue.scheduleLatest({
    type: 'AUTO_SYMBOL_TICK',
    dedupeKey: `${monitorSymbol}:AUTO_SYMBOL_TICK:LONG`,
    monitorSymbol,
    data: {
      monitorSymbol,
      direction: 'LONG',
      seatVersion: symbolRegistry.getSeatVersion(monitorSymbol, 'LONG'),
      symbol: longSeatSnapshot.symbol ?? null,
      currentTimeMs,
      canTradeNow,
    },
  });
  monitorTaskQueue.scheduleLatest({
    type: 'AUTO_SYMBOL_TICK',
    dedupeKey: `${monitorSymbol}:AUTO_SYMBOL_TICK:SHORT`,
    monitorSymbol,
    data: {
      monitorSymbol,
      direction: 'SHORT',
      seatVersion: symbolRegistry.getSeatVersion(monitorSymbol, 'SHORT'),
      symbol: shortSeatSnapshot.symbol ?? null,
      currentTimeMs,
      canTradeNow,
    },
  });

  const hasPendingSwitch =
    autoSymbolManager.hasPendingSwitch('LONG') || autoSymbolManager.hasPendingSwitch('SHORT');

  if (monitorPriceChanged || hasPendingSwitch) {
    monitorTaskQueue.scheduleLatest({
      type: 'AUTO_SYMBOL_SWITCH_DISTANCE',
      dedupeKey: `${monitorSymbol}:AUTO_SYMBOL_SWITCH_DISTANCE`,
      monitorSymbol,
      data: {
        monitorSymbol,
        monitorPrice: resolvedMonitorPrice,
        quotesMap,
        seatSnapshots: {
          long: {
            seatVersion: symbolRegistry.getSeatVersion(monitorSymbol, 'LONG'),
            symbol: longSeatSnapshot.symbol ?? null,
          },
          short: {
            seatVersion: symbolRegistry.getSeatVersion(monitorSymbol, 'SHORT'),
            symbol: shortSeatSnapshot.symbol ?? null,
          },
        },
      },
    });
  }
}
