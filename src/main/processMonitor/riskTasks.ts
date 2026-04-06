/**
 * 风险检查任务调度模块
 *
 * 功能：
 * - 根据价格变化和监控标的配置调度风险检查任务
 * - 调度距回收价检查（LIQUIDATION_DISTANCE_CHECK）：用于触发距回收价清仓检查
 * - 监控价格变化并更新价格展示信息（距回收价、持仓市值、持仓盈亏、订单数量）
 *
 * 调度条件：
 * - 距回收价检查：自动寻标未启用、且价格发生变化时调度
 */
import type { RiskTasksParams } from './types.js';
import type { PriceDisplayInfo } from '../../services/marketMonitor/types.js';
import type { RiskChecker, OrderRecorder } from '../../types/services.js';

/**
 * 构建单方向价格展示信息（距回收价、持仓市值/持仓盈亏、订单数量）。
 * 统一复用 riskChecker 的浮亏缓存计算结果，避免展示层重复实现 R1/N1/R2 公式。
 *
 * @param params 含 seatActive、symbol、monitorCurrentPrice、quotePrice、isLongSymbol、riskChecker、orderRecorder
 * @returns 价格展示信息，席位未就绪时返回 null
 */
function buildPriceDisplayInfo(params: {
  readonly seatActive: boolean;
  readonly symbol: string;
  readonly monitorCurrentPrice: number | null;
  readonly quotePrice: number | null;
  readonly isLongSymbol: boolean;
  readonly riskChecker: RiskChecker;
  readonly orderRecorder: OrderRecorder;
}): PriceDisplayInfo | null {
  const {
    seatActive,
    symbol,
    monitorCurrentPrice,
    quotePrice,
    isLongSymbol,
    riskChecker,
    orderRecorder,
  } = params;

  if (!seatActive) {
    return null;
  }

  const warrantDistanceInfo = riskChecker.getWarrantDistanceInfo(
    isLongSymbol,
    symbol,
    monitorCurrentPrice,
  );
  const unrealizedLossMetrics = riskChecker.getUnrealizedLossMetrics(symbol, quotePrice);
  const orderCount = orderRecorder.getBuyOrdersForSymbol(symbol, isLongSymbol).length;

  return {
    warrantDistanceInfo,
    unrealizedLossMetrics,
    orderCount,
  };
}

/**
 * 调度单监控标的的风险检查任务。
 * 根据价格是否变化、是否启用自动寻标，调度距回收价检查任务；
 * 并更新牛熊证距离信息、持仓市值/盈亏与订单数量展示。交易标的浮亏强平由 quote 事件运行时独立驱动。
 *
 * @param params 调度参数，包含监控标的、上下文、席位信息、价格变化标志等
 */
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
  const { riskChecker, orderRecorder, state } = monitorContext;
  const { marketMonitor, monitorTaskQueue } = mainContext;
  const {
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
  } = seatInfo;

  if (monitorPriceChanged && !autoSearchEnabled && resolvedMonitorPrice !== null) {
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
          symbolName: longQuote?.name ?? monitorContext.longSymbolName,
        },
        short: {
          seatVersion: shortSeatVersion,
          symbol: shortSeatState.symbol ?? null,
          symbolName: shortQuote?.name ?? monitorContext.shortSymbolName,
        },
      },
    });
  }

  const longDisplayInfo = buildPriceDisplayInfo({
    seatActive: longSeatActive,
    symbol: longSymbol,
    monitorCurrentPrice,
    quotePrice: longQuote?.price ?? null,
    isLongSymbol: true,
    riskChecker,
    orderRecorder,
  });
  const shortDisplayInfo = buildPriceDisplayInfo({
    seatActive: shortSeatActive,
    symbol: shortSymbol,
    monitorCurrentPrice,
    quotePrice: shortQuote?.price ?? null,
    isLongSymbol: false,
    riskChecker,
    orderRecorder,
  });

  marketMonitor.monitorPriceChanges(
    longQuote,
    shortQuote,
    longSymbol,
    shortSymbol,
    state,
    longDisplayInfo,
    shortDisplayInfo,
  );
}
