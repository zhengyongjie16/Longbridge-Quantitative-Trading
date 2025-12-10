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
   *    - 将卖出订单按成交时间从旧到新排序（D1是最旧的，D2次之，D3是最新的）
   *    - 从最旧的卖出订单开始（D1），依次判断和过滤：
   *      a) 获取所有 成交时间 < D1成交时间 的买入订单
   *      b) 计算这些买入订单的总数量
   *      c) 如果 D1的成交数量 >= 这些买入订单的总数量，则这些买入订单全部被卖出，无需记录
   *      d) 否则，从这些买入订单中过滤出 成交价 >= D1成交价 的买入订单
   *      e) 将这些过滤出的买入订单 + 成交时间 > D1 且 < D2成交时间的买入订单 = M1
   *      f) 继续对M1使用D2的成交时间和成交价过滤，得到M2
   *      g) 以此类推，得到MN
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

      // 将卖出订单按成交时间从旧到新排序（最旧的在前），并转换为标准格式
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
        .sort((a, b) => a.executedTime - b.executedTime); // 从旧到新排序

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

      // 1. 先获取M0：成交时间 > 最新卖出订单时间的买入订单
      const latestSellTime =
        sortedSellOrders[sortedSellOrders.length - 1].executedTime; // 最新的卖出订单时间
      const m0 = allBuyOrders.filter(
        (buyOrder) => buyOrder.executedTime > latestSellTime
      );

      // 2. 从最旧的卖出订单开始，依次过滤买入订单
      // 初始候选列表：所有成交时间 <= 最新卖出订单时间的买入订单
      let currentBuyOrders = allBuyOrders.filter(
        (buyOrder) => buyOrder.executedTime <= latestSellTime
      );

      // 从最旧的卖出订单开始，依次过滤（D1 -> D2 -> D3，D1是最旧的）
      for (let i = 0; i < sortedSellOrders.length; i++) {
        const sellOrder = sortedSellOrders[i];
        const sellTime = sellOrder.executedTime;
        const sellPrice = sellOrder.executedPrice;
        const sellQuantity = sellOrder.executedQuantity;

        // 获取下一个卖出订单的时间（如果存在），用于确定时间范围
        const nextSellTime =
          i < sortedSellOrders.length - 1
            ? sortedSellOrders[i + 1].executedTime
            : latestSellTime + 1; // 如果没有下一个，设为latestSellTime+1表示上限

        // 获取所有 成交时间 < 当前卖出订单成交时间 的买入订单（从currentBuyOrders中）
        const buyOrdersBeforeSell = currentBuyOrders.filter(
          (buyOrder) => buyOrder.executedTime < sellTime
        );

        // 如果没有在此卖出订单之前的买入订单，跳过
        if (buyOrdersBeforeSell.length === 0) {
          // 更新currentBuyOrders：保留成交时间 >= 当前卖出订单时间的买入订单
          currentBuyOrders = currentBuyOrders.filter(
            (buyOrder) => buyOrder.executedTime >= sellTime
          );
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
          // 保留成交时间 >= 当前卖出订单时间的买入订单
          currentBuyOrders = currentBuyOrders.filter(
            (buyOrder) => buyOrder.executedTime >= sellTime
          );
          // 无需继续过滤价格，直接跳到下一个卖出订单
          continue;
        }

        // 否则，按价格过滤：从这些买入订单中过滤出 成交价 >= 卖出价 的买入订单
        const filteredBuyOrders = buyOrdersBeforeSell.filter(
          (buyOrder) => buyOrder.executedPrice >= sellPrice
        );

        // 获取成交时间 > 当前卖出订单时间 且 < 下一个卖出订单时间（如果存在）的买入订单
        // 注意：这些订单应该从原始买入订单列表中获取，因为它们是未被过滤的
        const buyOrdersBetweenSells = allBuyOrders.filter((buyOrder) => {
          if (buyOrder.executedTime <= sellTime) {
            return false; // 排除 <= 当前卖出订单时间的订单
          }
          if (buyOrder.executedTime >= nextSellTime) {
            return false; // 排除 >= 下一个卖出订单时间的订单
          }
          return true;
        });

        // 合并：过滤出的买入订单 + 时间范围内的买入订单 = 新的currentBuyOrders
        currentBuyOrders = [...filteredBuyOrders, ...buyOrdersBetweenSells];
      }

      // 最终订单列表 = M0 + currentBuyOrders
      const finalBuyOrders = [...m0, ...currentBuyOrders];

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
