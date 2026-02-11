/**
 * 自动换标任务调度模块
 *
 * 功能：
 * - 调度自动换标心跳任务（AUTO_SYMBOL_TICK）：定时检查席位状态，执行自动寻标
 * - 调度换标距离检查任务（AUTO_SYMBOL_SWITCH_DISTANCE）：根据距回收价触发换标
 *
 * 调度规则：
 * - AUTO_SYMBOL_TICK：每个心跳周期都为 LONG 和 SHORT 方向调度
 * - AUTO_SYMBOL_SWITCH_DISTANCE：当价格发生变化或有待处理换标时调度
 *
 * @param params 调度参数，包含监控标的、上下文、当前时间、交易状态等
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
