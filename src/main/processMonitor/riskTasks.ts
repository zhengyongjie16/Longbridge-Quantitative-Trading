/**
 * @module processMonitor/riskTasks
 * @description 距回收价/浮亏检查调度
 */
import type { RiskTasksParams } from './types.js';

export function scheduleRiskTasks(params: RiskTasksParams): void {
  const {
    monitorSymbol,
    monitorContext,
    mainContext,
    seatInfo,
    autoSearchEnabled,
    monitorPriceChanged,
    resolvedMonitorPrice,
    monitorCurrentPrice,
  } = params;
  const { riskChecker, state } = monitorContext;
  const { marketMonitor, monitorTaskQueue } = mainContext;
  const {
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
  } = seatInfo;

  if (monitorPriceChanged && !autoSearchEnabled && resolvedMonitorPrice != null) {
    monitorTaskQueue.scheduleLatest({
      type: 'LIQUIDATION_DISTANCE_CHECK',
      dedupeKey: `${monitorSymbol}:LIQUIDATION_DISTANCE_CHECK`,
      monitorSymbol,
      data: {
        monitorSymbol,
        monitorPrice: resolvedMonitorPrice,
        long: {
          seatVersion: longSeatVersion,
          symbol: longSeatState.symbol ?? null,
          quote: longQuote,
          symbolName: longQuote?.name ?? monitorContext.longSymbolName ?? null,
        },
        short: {
          seatVersion: shortSeatVersion,
          symbol: shortSeatState.symbol ?? null,
          quote: shortQuote,
          symbolName: shortQuote?.name ?? monitorContext.shortSymbolName ?? null,
        },
      },
    });
  }

  const longWarrantDistanceInfo = longSeatReady
    ? riskChecker.getWarrantDistanceInfo(true, longSymbol, monitorCurrentPrice)
    : null;
  const shortWarrantDistanceInfo = shortSeatReady
    ? riskChecker.getWarrantDistanceInfo(false, shortSymbol, monitorCurrentPrice)
    : null;

  const priceChanged = marketMonitor.monitorPriceChanges(
    longQuote,
    shortQuote,
    longSymbol,
    shortSymbol,
    state,
    longWarrantDistanceInfo,
    shortWarrantDistanceInfo,
  );

  if (priceChanged) {
    monitorTaskQueue.scheduleLatest({
      type: 'UNREALIZED_LOSS_CHECK',
      dedupeKey: `${monitorSymbol}:UNREALIZED_LOSS_CHECK`,
      monitorSymbol,
      data: {
        monitorSymbol,
        long: {
          seatVersion: longSeatVersion,
          symbol: longSeatState.symbol ?? null,
          quote: longQuote,
        },
        short: {
          seatVersion: shortSeatVersion,
          symbol: shortSeatState.symbol ?? null,
          quote: shortQuote,
        },
      },
    });
  }
}
