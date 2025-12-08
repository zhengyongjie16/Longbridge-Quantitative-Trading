import { OrderSide, OrderStatus } from "longport";
import { logger } from "./logger.js";

/**
 * 规范化港股代码，自动添加 .HK 后缀（如果还没有）
 */
function normalizeHKSymbol(symbol) {
  if (!symbol || typeof symbol !== "string") {
    return symbol;
  }
  if (symbol.includes(".")) {
    return symbol;
  }
  return `${symbol}.HK`;
}

/**
 * 将 Decimal 类型转换为数字
 */
const decimalToNumber = (decimalLike) =>
  decimalLike && typeof decimalLike.toNumber === "function"
    ? decimalLike.toNumber()
    : Number(decimalLike ?? 0);

/**
 * 订单记录管理器
 * 用于记录做多和做空标的的历史买入且已成交订单
 */
export class OrderRecorder {
  constructor(trader) {
    this._trader = trader;
    // 记录做多标的的历史买入且已成交订单
    this._longBuyOrders = [];
    // 记录做空标的的历史买入且已成交订单
    this._shortBuyOrders = [];
  }

  /**
   * 获取并记录指定标的的当日买入且已成交订单
   * 过滤逻辑：
   * 1. 获取当日所有买入订单（已成交）
   * 2. 获取当日所有卖出订单（已成交）
   * 3. 从最旧的卖出订单开始，逐个过滤买入订单：
   *    - 每个卖出订单过滤出：成交时间>卖出订单成交时间 且 成交价>=卖出订单成交价 的买入订单
   *    - 将上一步的过滤结果作为下一个卖出订单的输入，逐步缩小范围
   * @param {string} symbol 标的代码
   * @param {boolean} isLongSymbol 是否为做多标的（true=做多，false=做空）
   * @returns {Promise<Array>} 记录的订单列表
   */
  async refreshOrders(symbol, isLongSymbol) {
    try {
      const normalizedSymbol = normalizeHKSymbol(symbol);
      const ctx = await this._trader._ctxPromise;

      // 获取当日所有订单
      const allTodayOrders = await ctx.todayOrders({
        symbol: normalizedSymbol,
      });

      // 过滤出买入且已成交的订单
      const filledBuyOrders = allTodayOrders.filter((order) => {
        return (
          order.side === OrderSide.Buy && // 买入订单
          order.status === OrderStatus.Filled // 已成交状态
        );
      });

      // 过滤出卖出且已成交的订单
      const filledSellOrders = allTodayOrders.filter((order) => {
        return (
          order.side === OrderSide.Sell && // 卖出订单
          order.status === OrderStatus.Filled // 已成交状态
        );
      });

      // 将卖出订单按成交时间从旧到新排序
      filledSellOrders.sort((a, b) => {
        const timeA = a.updatedAt ? a.updatedAt.getTime() : 0;
        const timeB = b.updatedAt ? b.updatedAt.getTime() : 0;
        return timeA - timeB;
      });

      // 转换买入订单为标准格式
      let candidateBuyOrders = filledBuyOrders
        .map((buyOrder) => {
          const executedPrice = decimalToNumber(buyOrder.executedPrice);
          const executedQuantity = decimalToNumber(buyOrder.executedQuantity);
          const executedTime = buyOrder.updatedAt
            ? buyOrder.updatedAt.getTime()
            : 0;

          // 验证数据有效性
          if (
            !Number.isFinite(executedPrice) ||
            executedPrice <= 0 ||
            !Number.isFinite(executedQuantity) ||
            executedQuantity <= 0 ||
            executedTime === 0
          ) {
            return null;
          }

          return {
            orderId: buyOrder.orderId,
            symbol: normalizedSymbol,
            executedPrice: executedPrice,
            executedQuantity: executedQuantity,
            executedTime: executedTime,
            submittedAt: buyOrder.submittedAt,
            updatedAt: buyOrder.updatedAt,
          };
        })
        .filter((order) => order !== null);

      // 如果没有卖出订单，记录所有买入订单
      if (filledSellOrders.length === 0) {
        if (isLongSymbol) {
          this._longBuyOrders = candidateBuyOrders;
          logger.info(
            `[订单记录] 做多标的 ${normalizedSymbol}: 当日买入${candidateBuyOrders.length}笔, 当日卖出0笔, 记录全部买入订单`
          );
        } else {
          this._shortBuyOrders = candidateBuyOrders;
          logger.info(
            `[订单记录] 做空标的 ${normalizedSymbol}: 当日买入${candidateBuyOrders.length}笔, 当日卖出0笔, 记录全部买入订单`
          );
        }
        return candidateBuyOrders;
      }

      // 从最旧的卖出订单开始，逐个过滤买入订单
      for (const sellOrder of filledSellOrders) {
        const sellPrice = decimalToNumber(sellOrder.executedPrice);
        const sellTime = sellOrder.updatedAt
          ? sellOrder.updatedAt.getTime()
          : 0;

        // 验证卖出订单数据有效性
        if (
          !Number.isFinite(sellPrice) ||
          sellPrice <= 0 ||
          sellTime === 0
        ) {
          continue;
        }

        // 过滤出符合条件的买入订单：成交时间>卖出订单成交时间 且 成交价>=卖出订单成交价
        candidateBuyOrders = candidateBuyOrders.filter((buyOrder) => {
          return (
            buyOrder.executedTime > sellTime &&
            buyOrder.executedPrice >= sellPrice
          );
        });
      }

      // 更新记录
      const positionType = isLongSymbol ? "做多标的" : "做空标的";
      const originalBuyCount = filledBuyOrders.length;
      const recordedCount = candidateBuyOrders.length;
      const filteredCount = originalBuyCount - recordedCount;

      if (isLongSymbol) {
        this._longBuyOrders = candidateBuyOrders;
      } else {
        this._shortBuyOrders = candidateBuyOrders;
      }

      logger.info(
        `[订单记录] ${positionType} ${normalizedSymbol}: ` +
          `当日买入${originalBuyCount}笔, ` +
          `当日卖出${filledSellOrders.length}笔, ` +
          `经过${filledSellOrders.length}次过滤后记录${recordedCount}笔, ` +
          `过滤${filteredCount}笔`
      );

      return candidateBuyOrders;
    } catch (error) {
      logger.error(`[订单记录失败] 标的 ${symbol}`, error.message || error);
      return [];
    }
  }

  /**
   * 获取做多标的的已记录订单
   * @returns {Array} 订单列表
   */
  getLongBuyOrders() {
    return [...this._longBuyOrders];
  }

  /**
   * 获取做空标的的已记录订单
   * @returns {Array} 订单列表
   */
  getShortBuyOrders() {
    return [...this._shortBuyOrders];
  }

  /**
   * 根据当前价格，获取做多标的中买入价低于当前价的订单
   * @param {number} currentPrice 当前价格
   * @returns {Array} 符合条件的订单列表
   */
  getLongBuyOrdersBelowPrice(currentPrice) {
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return [];
    }

    return this._longBuyOrders.filter(
      (order) =>
        Number.isFinite(order.executedPrice) &&
        order.executedPrice < currentPrice
    );
  }

  /**
   * 根据当前价格，获取做空标的中买入价低于当前价的订单
   * @param {number} currentPrice 当前价格
   * @returns {Array} 符合条件的订单列表
   */
  getShortBuyOrdersBelowPrice(currentPrice) {
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return [];
    }

    return this._shortBuyOrders.filter(
      (order) =>
        Number.isFinite(order.executedPrice) &&
        order.executedPrice < currentPrice
    );
  }

  /**
   * 计算订单列表的总成交数量
   * @param {Array} orders 订单列表
   * @returns {number} 总成交数量
   */
  calculateTotalQuantity(orders) {
    return orders.reduce((sum, order) => {
      return sum + (order.executedQuantity || 0);
    }, 0);
  }
}
