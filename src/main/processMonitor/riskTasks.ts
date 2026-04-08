/**
 * 风险检查任务调度模块
 *
 * 功能：
 * - 监控价格变化并更新价格展示信息（距回收价、持仓市值、持仓盈亏、订单数量）
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
 * 调度单监控标的的风险展示更新。
 * 统一更新牛熊证距离信息、持仓市值/盈亏与订单数量展示；交易标的浮亏强平由 quote 事件运行时独立驱动。
 *
 * @param params 调度参数，包含监控标的、上下文、席位信息与价格展示输入等
 */
export function scheduleRiskTasks(params: RiskTasksParams): void {
  const { monitorContext, mainContext, seatInfo, monitorCurrentPrice } = params;
  const { riskChecker, orderRecorder, state } = monitorContext;
  const { marketMonitor } = mainContext;
  const { longSeatActive, shortSeatActive, longSymbol, shortSymbol, longQuote, shortQuote } =
    seatInfo;

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
