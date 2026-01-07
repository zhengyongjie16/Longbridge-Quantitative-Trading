/**
 * 浮亏监控模块
 *
 * 功能：
 * - 实时监控单标的的浮亏
 * - 浮亏超过阈值时触发保护性清仓
 * - 使用市价单执行清仓
 *
 * 浮亏计算：
 * - unrealizedLoss = currentPrice * N1 - R1
 * - R1：所有未平仓买入订单的市值总和
 * - N1：所有未平仓买入订单的成交数量总和
 *
 * 清仓流程：
 * 1. 检查浮亏是否超过阈值
 * 2. 创建市价单清仓信号
 * 3. 执行清仓订单
 * 4. 刷新订单记录和浮亏数据
 */

import { logger } from '../../utils/logger/index.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { signalObjectPool } from '../../utils/objectPool/index.js';
import type { Quote, Signal } from '../../types/index.js';
import type { RiskChecker } from '../risk/index.js';
import type { Trader } from '../trader/index.js';
import type { OrderRecorder } from '../orderRecorder/index.js';
import type { UnrealizedLossMonitor, UnrealizedLossMonitorDeps } from './type.js';

/**
 * 创建浮亏监控器
 * @param deps 依赖注入
 * @returns UnrealizedLossMonitor 接口实例
 */
export const createUnrealizedLossMonitor = (deps: UnrealizedLossMonitorDeps): UnrealizedLossMonitor => {
  const maxUnrealizedLossPerSymbol = deps.maxUnrealizedLossPerSymbol;

  /**
   * 检查并执行保护性清仓（如果浮亏超过阈值）
   */
  const checkAndLiquidate = async (
    symbol: string,
    currentPrice: number,
    isLong: boolean,
    riskChecker: RiskChecker,
    trader: Trader,
    orderRecorder: OrderRecorder,
  ): Promise<boolean> => {
    // 如果未启用浮亏监控，直接返回
    if (maxUnrealizedLossPerSymbol <= 0) {
      return false;
    }

    // 验证价格有效性
    if (!isValidPositiveNumber(currentPrice)) {
      return false;
    }

    // 检查浮亏
    const lossCheck = riskChecker.checkUnrealizedLoss(
      symbol,
      currentPrice,
      isLong,
    );

    if (!lossCheck.shouldLiquidate) {
      return false;
    }

    // 执行保护性清仓（使用市价单）
    logger.error(lossCheck.reason || '浮亏超过阈值，执行保护性清仓');

    // 从对象池获取信号对象
    const liquidationSignal = signalObjectPool.acquire() as Signal & { useMarketOrder?: boolean };
    liquidationSignal.symbol = symbol;
    liquidationSignal.action = isLong
      ? 'SELLCALL'
      : 'SELLPUT';
    liquidationSignal.reason = lossCheck.reason || '';
    liquidationSignal.quantity = lossCheck.quantity ?? null;
    liquidationSignal.price = currentPrice;
    liquidationSignal.useMarketOrder = true;

    try {
      await trader.executeSignals([liquidationSignal]);

      // 保护性清仓后，无条件清空订单记录（不管价格如何，都要清空所有持仓）
      // 使用专门的 clearBuyOrders 方法，而不是 recordLocalSell（避免价格过滤逻辑）
      orderRecorder.clearBuyOrders(symbol, isLong);

      // 重新计算浮亏数据（订单记录已清空，浮亏数据也会为空）
      await riskChecker.refreshUnrealizedLossData(
        orderRecorder,
        symbol,
        isLong,
      );

      return true; // 清仓成功
    } catch (err) {
      const direction = isLong ? '做多标的' : '做空标的';
      logger.error(
        `[保护性清仓失败] ${direction} ${symbol}`,
        (err as Error)?.message ?? String(err),
      );
      return false;
    } finally {
      // 无论成功或失败，都释放信号对象回对象池
      signalObjectPool.release(liquidationSignal);
    }
  };

  /**
   * 监控做多和做空标的的浮亏（价格变化时调用）
   */
  const monitorUnrealizedLoss = async (
    longQuote: Quote | null,
    shortQuote: Quote | null,
    longSymbol: string,
    shortSymbol: string,
    riskChecker: RiskChecker,
    trader: Trader,
    orderRecorder: OrderRecorder,
  ): Promise<void> => {
    // 如果未启用浮亏监控，直接返回
    if (maxUnrealizedLossPerSymbol <= 0) {
      return;
    }

    // 统一的浮亏检查逻辑（适用于做多和做空标的）
    const checkSymbolLoss = async (
      quote: Quote | null,
      symbol: string | null,
      isLong: boolean,
    ): Promise<void> => {
      if (!quote || !symbol) {
        return;
      }
      const price = quote.price;
      if (isValidPositiveNumber(price)) {
        await checkAndLiquidate(
          symbol,
          price,
          isLong,
          riskChecker,
          trader,
          orderRecorder,
        );
      }
    };

    // 检查做多标的的浮亏
    await checkSymbolLoss(longQuote, longSymbol, true);

    // 检查做空标的的浮亏
    await checkSymbolLoss(shortQuote, shortSymbol, false);
  };

  return {
    checkAndLiquidate,
    monitorUnrealizedLoss,
  };
};

// 导出类型
export type { UnrealizedLossMonitor } from './type.js';
