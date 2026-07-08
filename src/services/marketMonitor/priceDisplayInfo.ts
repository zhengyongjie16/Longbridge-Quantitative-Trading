/**
 * priceDisplayInfo 模块
 *
 * 职责：
 * - 聚合交易标的行情日志所需的距回收价、持仓指标与订单数量
 * - 为 quote 事件显示提供统一的附加信息组装入口
 */
import type { PriceDisplayInfo } from './types.js';
import type { OrderRecorder, RiskChecker } from '../../types/services.js';

/**
 * 构建单方向价格展示信息。
 * 统一复用 riskChecker 的实时计算结果，避免显示链路重复实现业务公式。
 *
 * @param params 席位就绪状态、标的、监控价格、quote 价格、方向与依赖
 * @returns 价格展示信息；席位未就绪时返回 null
 */
export function buildPriceDisplayInfo(params: {
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
