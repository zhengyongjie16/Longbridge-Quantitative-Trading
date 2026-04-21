/**
 * 浮亏监控模块
 *
 * 功能：
 * - 基于单方向交易标的最新事件价格执行浮亏检查
 * - 浮亏超过阈值时触发保护性清仓信号并提交交易执行链
 * - 保护性清仓的最终订单类型由 trader 层按全局配置解析
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { formatError } from '../../utils/error/index.js';
import { logger } from '../../utils/logger/index.js';
import type { Quote } from '../../types/quote.js';
import type {
  DailyLossTracker,
  DirectionalUnrealizedLossMonitorContext,
  UnrealizedLossMonitor,
} from '../../types/risk.js';
import type { Signal } from '../../types/signal.js';
import type { OrderRecorder, RiskChecker, Trader } from '../../types/services.js';
import type { UnrealizedLossMonitorDeps } from './types.js';

/**
 * 创建浮亏监控器。
 * 封装「检查浮亏 -> 超阈值则生成保护性清仓信号并提交」的流程，供 TradingRiskEventRuntime 按单方向调用。
 *
 * @param deps 依赖，含 maxUnrealizedLossPerSymbol（<= 0 表示禁用）
 * @returns 实现 UnrealizedLossMonitor 接口的实例
 */
export const createUnrealizedLossMonitor = (
  deps: UnrealizedLossMonitorDeps,
): UnrealizedLossMonitor => {
  const maxUnrealizedLossPerSymbol = deps.maxUnrealizedLossPerSymbol;

  /**
   * 检查指定标的的浮亏是否超过阈值，超过时执行保护性清仓。
   *
   * @param params 单方向浮亏检查所需依赖
   * @returns 实际提交保护性清仓时返回 true
   */
  const checkAndLiquidate = async (params: {
    readonly symbol: string;
    readonly currentPrice: number;
    readonly isLong: boolean;
    readonly monitorSymbol: string;
    readonly seatVersion: number;
    readonly riskChecker: RiskChecker;
    readonly trader: Trader;
    readonly orderRecorder: OrderRecorder;
    readonly dailyLossTracker: DailyLossTracker;
    readonly quote: Quote;
  }): Promise<boolean> => {
    const {
      symbol,
      currentPrice,
      isLong,
      monitorSymbol,
      seatVersion,
      riskChecker,
      trader,
      orderRecorder,
      dailyLossTracker,
      quote,
    } = params;
    if (maxUnrealizedLossPerSymbol <= 0) {
      return false;
    }

    if (!isValidPositiveNumber(currentPrice)) {
      return false;
    }

    const lossCheck = riskChecker.checkUnrealizedLoss(symbol, currentPrice, isLong);
    if (!lossCheck.shouldLiquidate) {
      return false;
    }

    const liquidationReason =
      lossCheck.reason === undefined || lossCheck.reason === ''
        ? '浮亏超过阈值，执行保护性清仓'
        : lossCheck.reason;
    logger.error(liquidationReason);

    const liquidationSignal: Signal = {
      symbol,
      symbolName: quote.name ?? null,
      action: isLong ? 'SELLCALL' : 'SELLPUT',
      reason: lossCheck.reason ?? '',
      isProtectiveLiquidation: true,
      quantity: lossCheck.quantity ?? null,
      price: currentPrice,
      seatVersion,
      lotSize: quote.lotSize ?? null,
    };

    try {
      const { submittedCount } = await trader.executeSignals([liquidationSignal]);
      if (submittedCount === 0) {
        return false;
      }

      orderRecorder.clearBuyOrders(symbol, isLong, quote);
      await riskChecker.refreshUnrealizedLossData(
        orderRecorder,
        symbol,
        isLong,
        quote,
        dailyLossTracker.getLossOffset(monitorSymbol, isLong),
      );
      return true;
    } catch (error) {
      const direction = isLong ? '做多标的' : '做空标的';
      const symbolDisplay = formatSymbolDisplay(symbol, quote.name ?? null);
      logger.error(`[保护性清仓失败] ${direction} ${symbolDisplay}`, formatError(error));
      return false;
    }
  };

  /**
   * 监控单方向标的的浮亏。
   * 直接消费 runtime 已路由好的单一 symbol，并沿用 seatVersion 完成保护性清仓。
   *
   * @param context 单方向浮亏监控上下文
   */
  const monitorDirectionalUnrealizedLoss = async (
    context: DirectionalUnrealizedLossMonitorContext,
  ): Promise<void> => {
    if (maxUnrealizedLossPerSymbol <= 0) {
      return;
    }

    if (!isValidPositiveNumber(context.quote.price)) {
      return;
    }

    await checkAndLiquidate({
      symbol: context.symbol,
      currentPrice: context.quote.price,
      isLong: context.isLong,
      monitorSymbol: context.monitorSymbol,
      seatVersion: context.seatVersion,
      riskChecker: context.riskChecker,
      trader: context.trader,
      orderRecorder: context.orderRecorder,
      dailyLossTracker: context.dailyLossTracker,
      quote: context.quote,
    });
  };

  return {
    monitorDirectionalUnrealizedLoss,
  };
};
