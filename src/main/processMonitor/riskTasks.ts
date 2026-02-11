/**
 * 风险检查任务调度模块
 *
 * 功能：
 * - 根据价格变化和监控标的配置调度风险检查任务
 * - 调度距回收价检查（LIQUIDATION_DISTANCE_CHECK）：用于触发自动换标
 * - 调度浮亏检查（UNREALIZED_LOSS_CHECK）：用于触发保护性清仓
 * - 监控价格变化并更新牛熊证距离信息显示
 *
 * 调度条件：
 * - 距回收价检查：自动寻标启用、价格发生变化时调度
 * - 浮亏检查：价格发生变化时调度
 *
 * @param params 调度参数，包含监控标的、上下文、席位信息、价格变化标志等
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
