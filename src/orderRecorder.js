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
   *    - 从最新的卖出订单开始，依次判断和过滤：
   *      a) 获取所有 成交时间 < D3成交时间 的买入订单
   *      b) 计算这些买入订单的总数量
   *      c) 如果 D3的成交数量 >= 这些买入订单的总数量，则这些买入订单全部被卖出，无需记录
   *      d) 否则，按 成交价 >= D3成交价 过滤出部分买入订单，记为M1
   *      e) 继续对M1使用D2的成交时间和成交价过滤，得到M2
   *      f) 以此类推，得到MN
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

      // 如果没有买入订单，直接返回空列表
      if (allBuyOrders.length === 0) {
        if (isLongSymbol) {
          this._longBuyOrders = [];
          logger.info(
            `[订单记录] 做多标的 ${normalizedSymbol}: 当日买入0笔, 无需记录`
          );
        } else {
          this._shortBuyOrders = [];
          logger.info(
            `[订单记录] 做空标的 ${normalizedSymbol}: 当日买入0笔, 无需记录`
          );
        }
        return [];
      }

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

      // 将卖出订单按成交时间从新到旧排序（最新的在前），并转换为标准格式
      const sortedSellOrders = filledSellOrders
        .map((sellOrder) => {
          const sellPrice = decimalToNumber(sellOrder.executedPrice);
          const sellQuantity = decimalToNumber(sellOrder.executedQuantity);
          const sellTime = sellOrder.updatedAt
            ? sellOrder.updatedAt.getTime()
            : 0;

          // 验证卖出订单数据有效性
          if (
            !Number.isFinite(sellPrice) ||
            sellPrice <= 0 ||
            !Number.isFinite(sellQuantity) ||
            sellQuantity <= 0 ||
            sellTime === 0
          ) {
            return null;
          }

          return {
            orderId: sellOrder.orderId,
            executedPrice: sellPrice,
            executedQuantity: sellQuantity,
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

      // 从最新的卖出订单开始，依次过滤买入订单
      // 初始候选列表：所有买入订单
      // 注意：M0（成交时间 > 最新卖出订单时间的买入订单）会在过滤过程中自动保留
      let candidateBuyOrders = [...allBuyOrders];

      // 从最新的卖出订单开始，依次过滤（D3 -> D2 -> D1）
      for (const sellOrder of sortedSellOrders) {
        const sellTime = sellOrder.executedTime;
        const sellPrice = sellOrder.executedPrice;
        const sellQuantity = sellOrder.executedQuantity;

        // 获取所有 成交时间 < 当前卖出订单成交时间 的买入订单
        const buyOrdersBeforeSell = candidateBuyOrders.filter(
          (buyOrder) => buyOrder.executedTime < sellTime
        );

        // 如果没有在此卖出订单之前的买入订单，跳过
        if (buyOrdersBeforeSell.length === 0) {
          continue;
        }

        // 计算这些买入订单的总数量
        const totalBuyQuantity = buyOrdersBeforeSell.reduce(
          (sum, order) => sum + order.executedQuantity,
          0
        );

        // 判断：如果卖出数量 >= 买入总数量，说明这些买入订单全部被卖出
        if (sellQuantity >= totalBuyQuantity) {
          // 从候选列表中移除这些买入订单（视为全部被卖出）
          candidateBuyOrders = candidateBuyOrders.filter(
            (buyOrder) => buyOrder.executedTime >= sellTime
          );
          // 无需继续过滤价格，直接跳到下一个卖出订单
          continue;
        }

        // 否则，按价格过滤：保留 成交价 >= 卖出价 的买入订单
        // （因为卖出数量不足以覆盖全部买入，只能卖出部分，保留价格更高的）
        candidateBuyOrders = candidateBuyOrders.filter((buyOrder) => {
          // 保留成交时间 >= 卖出时间的订单（在卖出之后的）
          if (buyOrder.executedTime >= sellTime) {
            return true;
          }
          // 对于成交时间 < 卖出时间的订单，保留成交价 >= 卖出价的订单
          return buyOrder.executedPrice >= sellPrice;
        });
      }

      // 最终订单列表 = M0 + candidateBuyOrders（去重）
      // 由于 M0 已经包含在 candidateBuyOrders 中（成交时间 > latestSellTime），
      // 所以最终结果就是 candidateBuyOrders
      const finalBuyOrders = candidateBuyOrders;

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
          `当日卖出${filledSellOrders.length}笔(有效${sortedSellOrders.length}笔), ` +
          `最终记录${recordedCount}笔, ` +
          `已卖出${filteredCount}笔`
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
