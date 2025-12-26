/**
 * 浮亏监控模块
 * 负责实时监控单标的浮亏，并在触发阈值时执行保护性清仓
 */

import { logger } from "../utils/logger.js";
import { SignalType } from "../utils/constants.js";

/**
 * 浮亏监控器类
 * 监控做多/做空标的的浮亏，并在超过阈值时触发保护性清仓
 */
export class UnrealizedLossMonitor {
  constructor(maxUnrealizedLossPerSymbol) {
    this.maxUnrealizedLossPerSymbol = maxUnrealizedLossPerSymbol;
  }

  /**
   * 检查并执行保护性清仓（如果浮亏超过阈值）
   * @param {string} symbol 标的代码
   * @param {number} currentPrice 当前价格
   * @param {boolean} isLong 是否是做多标的
   * @param {Object} riskChecker 风险检查器实例
   * @param {Object} trader 交易执行器实例
   * @param {Object} orderRecorder 订单记录器实例
   * @returns {Promise<boolean>} 是否触发了清仓
   */
  async checkAndLiquidate(
    symbol,
    currentPrice,
    isLong,
    riskChecker,
    trader,
    orderRecorder
  ) {
    // 如果未启用浮亏监控，直接返回
    if (this.maxUnrealizedLossPerSymbol <= 0) {
      return false;
    }

    // 验证价格有效性
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return false;
    }

    // 检查浮亏
    const lossCheck = riskChecker.checkUnrealizedLoss(
      symbol,
      currentPrice,
      isLong
    );

    if (!lossCheck.shouldLiquidate) {
      return false;
    }

    // 执行保护性清仓（使用市价单）
    logger.error(lossCheck.reason);

    try {
      // 创建市价单清仓信号
      const liquidationSignal = {
        symbol: symbol,
        action: isLong ? SignalType.SELLCALL : SignalType.SELLPUT,
        reason: lossCheck.reason,
        quantity: lossCheck.quantity,
        price: currentPrice, // 使用当前价格作为参考
        useMarketOrder: true, // 标记为使用市价单
      };

      await trader.executeSignals([liquidationSignal]);

      // 清仓后刷新订单记录（强制从API获取最新状态）
      await orderRecorder.refreshOrders(symbol, isLong, true);

      // 重新计算浮亏数据
      await riskChecker.refreshUnrealizedLossData(
        orderRecorder,
        symbol,
        isLong
      );

      return true; // 清仓成功
    } catch (err) {
      const direction = isLong ? "做多标的" : "做空标的";
      logger.error(
        `[保护性清仓失败] ${direction} ${symbol}`,
        err?.message ?? err
      );
      return false;
    }
  }

  /**
   * 监控做多和做空标的的浮亏（价格变化时调用）
   * @param {Object} longQuote 做多标的行情
   * @param {Object} shortQuote 做空标的行情
   * @param {string} longSymbol 做多标的代码
   * @param {string} shortSymbol 做空标的代码
   * @param {Object} riskChecker 风险检查器实例
   * @param {Object} trader 交易执行器实例
   * @param {Object} orderRecorder 订单记录器实例
   * @returns {Promise<void>}
   */
  async monitorUnrealizedLoss(
    longQuote,
    shortQuote,
    longSymbol,
    shortSymbol,
    riskChecker,
    trader,
    orderRecorder
  ) {
    // 如果未启用浮亏监控，直接返回
    if (this.maxUnrealizedLossPerSymbol <= 0) {
      return;
    }

    // 检查做多标的的浮亏
    if (longQuote && longSymbol) {
      const longPrice = longQuote.price;
      if (Number.isFinite(longPrice) && longPrice > 0) {
        await this.checkAndLiquidate(
          longSymbol,
          longPrice,
          true,
          riskChecker,
          trader,
          orderRecorder
        );
      }
    }

    // 检查做空标的的浮亏
    if (shortQuote && shortSymbol) {
      const shortPrice = shortQuote.price;
      if (Number.isFinite(shortPrice) && shortPrice > 0) {
        await this.checkAndLiquidate(
          shortSymbol,
          shortPrice,
          false,
          riskChecker,
          trader,
          orderRecorder
        );
      }
    }
  }
}
