/**
 * 自动换标任务调度模块
 *
 * 功能：
 * - 调度周期换标心跳任务（AUTO_SYMBOL_TICK）：定时检查席位周期换标条件
 *
 * 调度规则：
 * - AUTO_SYMBOL_TICK：仅在周期换标开启时为 LONG 和 SHORT 方向调度
 */
import type { AutoSymbolTasksParams } from './types.js';

/**
 * 调度单监控标的的自动换标相关任务。
 * 为 LONG/SHORT 方向调度心跳任务（AUTO_SYMBOL_TICK），供异步队列执行周期换标检查。
 *
 * @param params 调度参数，包含监控标的、上下文、当前时间、交易状态等
 */
export function scheduleAutoSymbolTasks(params: AutoSymbolTasksParams): void {
  const {
    monitorSymbol,
    monitorContext,
    mainContext,
    autoSearchEnabled,
    currentTimeMs,
    canTradeNow,
    openProtectionActive,
  } = params;

  if (!autoSearchEnabled || monitorContext.config.autoSearchConfig.switchIntervalMinutes <= 0) {
    return;
  }

  const { symbolRegistry } = monitorContext;
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
      openProtectionActive,
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
      openProtectionActive,
    },
  });
}
