import { OrderSide, OrderStatus } from "longport";
import { logger } from "./logger.js";
import { normalizeHKSymbol, decimalToNumber } from "./utils.js";

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
   * 3. 如果没有卖出订单，记录所有买入订单
   * 4. 如果有卖出订单：
   *    - M0: 成交时间 > 最新卖出订单时间的买入订单
   *    - 将卖出订单按成交时间从新到旧排序（D3, D2, D1）
   *    - 从最新的卖出订单开始，依次过滤：
   *      - M1: 从所有买入订单中过滤出 成交时间 < D3成交时间 且 成交价 >= D3成交价 的买入订单
   *      - M2: 从M1中过滤出 成交时间 < D2成交时间 且 成交价 >= D2成交价 的买入订单
   *      - 以此类推，得到MN
   *    - 最终订单列表 = M0 + MN
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

      // 转换买入订单为标准格式
      const allBuyOrders = filledBuyOrders
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
          this._longBuyOrders = allBuyOrders;
          logger.info(
            `[订单记录] 做多标的 ${normalizedSymbol}: 当日买入${allBuyOrders.length}笔, 当日卖出0笔, 记录全部买入订单`
          );
        } else {
          this._shortBuyOrders = allBuyOrders;
          logger.info(
            `[订单记录] 做空标的 ${normalizedSymbol}: 当日买入${allBuyOrders.length}笔, 当日卖出0笔, 记录全部买入订单`
          );
        }
        return allBuyOrders;
      }

      // 将卖出订单按成交时间从新到旧排序（最新的在前）
      const sortedSellOrders = filledSellOrders
        .map((sellOrder) => {
          const sellPrice = decimalToNumber(sellOrder.executedPrice);
          const sellTime = sellOrder.updatedAt
            ? sellOrder.updatedAt.getTime()
            : 0;

          // 验证卖出订单数据有效性
          if (!Number.isFinite(sellPrice) || sellPrice <= 0 || sellTime === 0) {
            return null;
          }

          return {
            executedPrice: sellPrice,
            executedTime: sellTime,
          };
        })
        .filter((order) => order !== null)
        .sort((a, b) => b.executedTime - a.executedTime); // 从新到旧排序

      if (sortedSellOrders.length === 0) {
        // 所有卖出订单数据无效，记录所有买入订单
        if (isLongSymbol) {
          this._longBuyOrders = allBuyOrders;
          logger.info(
            `[订单记录] 做多标的 ${normalizedSymbol}: 当日买入${allBuyOrders.length}笔, 卖出订单数据无效, 记录全部买入订单`
          );
        } else {
          this._shortBuyOrders = allBuyOrders;
          logger.info(
            `[订单记录] 做空标的 ${normalizedSymbol}: 当日买入${allBuyOrders.length}笔, 卖出订单数据无效, 记录全部买入订单`
          );
        }
        return allBuyOrders;
      }

      // 找到最新卖出订单的时间
      const latestSellTime = sortedSellOrders[0].executedTime;

      // M0: 成交时间 > 最新卖出订单时间的买入订单
      const m0 = allBuyOrders.filter(
        (buyOrder) => buyOrder.executedTime > latestSellTime
      );

      // 从最新的卖出订单开始，依次过滤买入订单
      // 初始候选列表：所有买入订单（用于第一次过滤）
      let filteredBuyOrders = [...allBuyOrders];

      // 从最新的卖出订单开始，依次过滤
      for (const sellOrder of sortedSellOrders) {
        const sellTime = sellOrder.executedTime;
        const sellPrice = sellOrder.executedPrice;

        // 过滤出：成交时间 < 卖出订单成交时间 且 成交价 >= 卖出订单成交价 的买入订单
        filteredBuyOrders = filteredBuyOrders.filter((buyOrder) => {
          return (
            buyOrder.executedTime < sellTime &&
            buyOrder.executedPrice >= sellPrice
          );
        });
      }

      // 最终订单列表 = M0 + MN（filteredBuyOrders）
      const finalBuyOrders = [...m0, ...filteredBuyOrders];

      // 更新记录
      const positionType = isLongSymbol ? "做多标的" : "做空标的";
      const originalBuyCount = allBuyOrders.length;
      const recordedCount = finalBuyOrders.length;
      const filteredCount = originalBuyCount - recordedCount;

      if (isLongSymbol) {
        this._longBuyOrders = finalBuyOrders;
      } else {
        this._shortBuyOrders = finalBuyOrders;
      }

      logger.info(
        `[订单记录] ${positionType} ${normalizedSymbol}: ` +
          `当日买入${originalBuyCount}笔, ` +
          `当日卖出${filledSellOrders.length}笔, ` +
          `经过${sortedSellOrders.length}次过滤, ` +
          `最终记录${recordedCount}笔, ` +
          `过滤${filteredCount}笔`
      );

      return finalBuyOrders;
    } catch (error) {
      logger.error(`[订单记录失败] 标的 ${symbol}`, error.message || error);
      return [];
    }
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
