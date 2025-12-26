/**
 * 末日保护程序模块
 * 负责收盘前的风险控制：拒绝买入和自动清仓
 */

import { logger } from "../utils/logger.js";
import { normalizeHKSymbol } from "../utils/helpers.js";
import { isBeforeClose15Minutes, isBeforeClose5Minutes } from "../utils/tradingTime.js";
import { SignalType } from "../utils/constants.js";

/**
 * 末日保护程序类
 * 在收盘前执行保护性操作：
 * - 收盘前15分钟拒绝买入
 * - 收盘前5分钟自动清仓
 */
export class DoomsdayProtection {
  /**
   * 检查是否应该拒绝买入（收盘前15分钟）
   * @param {Date} currentTime 当前时间
   * @param {boolean} isHalfDay 是否是半日交易日
   * @returns {boolean} true表示应该拒绝买入
   */
  shouldRejectBuy(currentTime, isHalfDay) {
    return isBeforeClose15Minutes(currentTime, isHalfDay);
  }

  /**
   * 检查是否应该自动清仓（收盘前5分钟）
   * @param {Date} currentTime 当前时间
   * @param {boolean} isHalfDay 是否是半日交易日
   * @returns {boolean} true表示应该自动清仓
   */
  shouldClearPositions(currentTime, isHalfDay) {
    return isBeforeClose5Minutes(currentTime, isHalfDay);
  }

  /**
   * 生成清仓信号（收盘前5分钟自动清仓）
   * @param {Array} positions 持仓列表
   * @param {Object} longQuote 做多标的行情
   * @param {Object} shortQuote 做空标的行情
   * @param {string} longSymbol 做多标的代码
   * @param {string} shortSymbol 做空标的代码
   * @param {boolean} isHalfDay 是否是半日交易日
   * @returns {Array} 清仓信号列表
   */
  generateClearanceSignals(
    positions,
    longQuote,
    shortQuote,
    longSymbol,
    shortSymbol,
    isHalfDay
  ) {
    const clearSignals = [];
    const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
    const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);

    const closeTimeRange = isHalfDay ? "11:55-11:59" : "15:55-15:59";
    logger.info(
      `[末日保护程序] 收盘前5分钟（${closeTimeRange}），准备清空所有持仓`
    );

    // 验证 positions 是数组
    if (!Array.isArray(positions) || positions.length === 0) {
      return clearSignals;
    }

    for (const pos of positions) {
      // 验证持仓对象有效性
      if (!pos || !pos.symbol || typeof pos.symbol !== "string") {
        continue; // 跳过无效持仓
      }

      const availableQty = Number(pos.availableQuantity) || 0;
      if (!Number.isFinite(availableQty) || availableQty <= 0) {
        continue; // 跳过无效或零持仓
      }

      const normalizedPosSymbol = normalizeHKSymbol(pos.symbol);
      const isShortPos = normalizedPosSymbol === normalizedShortSymbol;

      // 获取该标的的当前价格、最小买卖单位和名称
      let currentPrice = null;
      let lotSize = null;
      let symbolName = pos.symbolName || null; // 优先使用持仓中的名称
      if (normalizedPosSymbol === normalizedLongSymbol && longQuote) {
        currentPrice = longQuote.price;
        lotSize = longQuote.lotSize;
        if (!symbolName) {
          symbolName = longQuote.name;
        }
      } else if (
        normalizedPosSymbol === normalizedShortSymbol &&
        shortQuote
      ) {
        currentPrice = shortQuote.price;
        lotSize = shortQuote.lotSize;
        if (!symbolName) {
          symbolName = shortQuote.name;
        }
      }

      // 收盘前清仓逻辑：
      // - 做多标的持仓：使用 SELLCALL 信号 → OrderSide.Sell（卖出做多标的，清仓）
      // - 做空标的持仓：使用 SELLPUT 信号 → OrderSide.Sell（卖出做空标的，平空仓）
      const action = isShortPos ? SignalType.SELLPUT : SignalType.SELLCALL;
      const positionType = isShortPos ? "做空标的" : "做多标的";

      clearSignals.push({
        symbol: normalizedPosSymbol, // 使用规范化符号，避免后续重复规范化
        symbolName: symbolName, // 添加名称信息
        action: action,
        price: currentPrice, // 添加当前价格，用于增强限价单
        lotSize: lotSize, // 添加最小买卖单位
        reason: `末日保护程序：收盘前5分钟自动清仓（${positionType}持仓）`,
        signalTriggerTime: new Date(), // 收盘前清仓信号的触发时间
      });

      logger.info(
        `[末日保护程序] 生成清仓信号：${positionType} ${pos.symbol} 数量=${availableQty} 操作=${action}`
      );
    }

    if (clearSignals.length > 0) {
      logger.info(
        `[末日保护程序] 共生成 ${clearSignals.length} 个清仓信号，准备执行`
      );
    }

    return clearSignals;
  }
}
