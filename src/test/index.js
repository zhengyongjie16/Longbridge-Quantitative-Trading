import { TradeContext, OrderStatus, OrderSide, Market } from "longport";
import { normalizeHKSymbol, decimalToNumber } from "../utils.js";
import { createConfig } from "../config/config.js";

/**
 * 获取并记录指定标的的历史买入且已成交订单
 * 过滤逻辑：
 * 1. 获取全部已成交买入订单（只需指定结束日期为当前时间）
 * 2. 获取全部已成交卖出订单（只需指定结束日期为当前时间）
 * 3. 先过滤出大于最新卖出订单时间的买入订单记为M0
 * 4. 从最旧的卖出订单开始依次判断（D1, D2, D3...）：
 *    - 对于D1：获取所有小于D1成交时间的买入订单
 *      * 如果D1的成交数量 >= 这些买入订单的总数量，则全部被卖出，无需记录
 *      * 否则，过滤出成交价 >= D1成交价的买入订单
 *      * 将过滤出的订单 + 成交时间在D1和D2之间的买入订单 = M1
 *    - 对于D2：判断D2数量是否 >= M1总数量
 *      * 如果是，则M1全部被卖出，无需记录
 *      * 否则，从M1中过滤出成交时间 < D2成交时间且成交价 >= D2成交价的订单
 *      * 将过滤出的订单 + 成交时间在D2和D3之间的买入订单 = M2
 *    - 以此类推，得到MN
 * 5. 最终订单列表 = M0 + MN
 * @param {TradeContext} ctx TradeContext 实例
 * @param {string} symbol 标的代码
 * @param {boolean} isLongSymbol 是否为做多标的（true=做多，false=做空）
 * @returns {Promise<Array>} 记录的订单列表
 */
async function getHistoryBuyOrders(ctx, symbol, isLongSymbol) {
  try {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const endAt = new Date();

    // 获取全部已成交买入和卖出订单
    const [buyOrdersResponse, sellOrdersResponse] = await Promise.all([
      ctx.historyOrders({
        symbol: normalizedSymbol,
        status: [OrderStatus.Filled],
        side: OrderSide.Buy,
        market: Market.HK,
        endAt,
      }),
      ctx.historyOrders({
        symbol: normalizedSymbol,
        status: [OrderStatus.Filled],
        side: OrderSide.Sell,
        market: Market.HK,
        endAt,
      }),
    ]);

    // 转换买入订单为标准格式
    const allBuyOrders = buyOrdersResponse
      .map((buyOrder) => {
        const executedPrice = decimalToNumber(buyOrder.executedPrice);
        const executedQuantity = decimalToNumber(buyOrder.executedQuantity);
        const executedTime = buyOrder.updatedAt?.getTime() || 0;

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
          executedPrice,
          executedQuantity,
          executedTime,
        };
      })
      .filter((order) => order !== null);

    // 如果没有买入订单，直接返回空列表
    if (allBuyOrders.length === 0) {
      const positionType = isLongSymbol ? "做多标的" : "做空标的";
      console.log(
        `[历史订单记录] ${positionType} ${normalizedSymbol}: 历史买入0笔, 无需记录`
      );
      return [];
    }

    const positionType = isLongSymbol ? "做多标的" : "做空标的";

    // 转换卖出订单为标准格式并按成交时间从旧到新排序
    const sortedSellOrders = sellOrdersResponse
      .map((sellOrder) => {
        const sellPrice = decimalToNumber(sellOrder.executedPrice);
        const sellQuantity = decimalToNumber(sellOrder.executedQuantity);
        const sellTime = sellOrder.updatedAt?.getTime() || 0;

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
      .sort((a, b) => a.executedTime - b.executedTime);

    // 如果没有卖出订单，记录所有买入订单
    if (sortedSellOrders.length === 0) {
      console.log(
        `[历史订单记录] ${positionType} ${normalizedSymbol}: 历史买入${allBuyOrders.length}笔, 历史卖出0笔, 记录全部买入订单`
      );
      return allBuyOrders;
    }

    // 3. 先获取M0：成交时间 > 最新卖出订单时间的买入订单
    const latestSellTime = sortedSellOrders.at(-1).executedTime;
    const m0 = allBuyOrders.filter(
      (buyOrder) => buyOrder.executedTime > latestSellTime
    );

    // 4. 从最旧的卖出订单开始，依次过滤买入订单
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

      // 获取下一个卖出订单的时间（如果存在）
      const nextSellTime =
        i < sortedSellOrders.length - 1
          ? sortedSellOrders[i + 1].executedTime
          : latestSellTime + 1;

      if (i === 0) {
        // 对于D1：获取所有小于D1成交时间的买入订单
        const buyOrdersBeforeD1 = currentBuyOrders.filter(
          (buyOrder) => buyOrder.executedTime < sellTime
        );

        if (buyOrdersBeforeD1.length === 0) {
          // 没有在D1之前的买入订单，更新currentBuyOrders
          currentBuyOrders = currentBuyOrders.filter(
            (buyOrder) => buyOrder.executedTime >= sellTime
          );
          continue;
        }

        // 计算这些买入订单的总数量
        const totalBuyQuantityBeforeD1 = buyOrdersBeforeD1.reduce(
          (sum, order) => sum + order.executedQuantity,
          0
        );

        // 判断：如果D1的成交数量 >= 这些买入订单的总数量，则全部被卖出
        if (sellQuantity >= totalBuyQuantityBeforeD1) {
          // 从候选列表中移除这些买入订单（视为全部被卖出）
          currentBuyOrders = currentBuyOrders.filter(
            (buyOrder) => buyOrder.executedTime >= sellTime
          );
          continue;
        }

        // 否则，过滤出成交价 >= D1成交价的买入订单
        const filteredBuyOrdersByD1 = buyOrdersBeforeD1.filter(
          (buyOrder) => buyOrder.executedPrice >= sellPrice
        );

        // 获取成交时间在 D1 和 D2 之间的买入订单
        const buyOrdersBetweenD1D2 = allBuyOrders.filter(
          (buyOrder) =>
            buyOrder.executedTime > sellTime &&
            buyOrder.executedTime < nextSellTime
        );

        // M1 = 过滤出的买入订单 + 时间范围内的买入订单
        currentBuyOrders = [...filteredBuyOrdersByD1, ...buyOrdersBetweenD1D2];
      } else {
        // 对于D2及之后的卖出订单：判断数量是否 >= 当前候选列表总数量
        const totalCurrentQuantity = currentBuyOrders.reduce(
          (sum, order) => sum + order.executedQuantity,
          0
        );

        if (sellQuantity >= totalCurrentQuantity) {
          // 当前候选列表全部被卖出，无需记录
          currentBuyOrders = [];
          break;
        }

        // 否则，从当前候选列表中过滤出成交时间 < D1成交时间且成交价 >= 当前卖出订单成交价的订单
        const d1Time = sortedSellOrders[0].executedTime;
        const filteredBuyOrders = currentBuyOrders.filter(
          (buyOrder) =>
            buyOrder.executedTime < d1Time &&
            buyOrder.executedPrice >= sellPrice
        );

        // 获取成交时间在当前卖出订单和下一个卖出订单之间的买入订单
        const buyOrdersBetweenSells = allBuyOrders.filter(
          (buyOrder) =>
            buyOrder.executedTime > sellTime &&
            buyOrder.executedTime < nextSellTime
        );

        // 更新候选列表 = 过滤出的买入订单 + 时间范围内的买入订单
        currentBuyOrders = [...filteredBuyOrders, ...buyOrdersBetweenSells];
      }
    }

    // 5. 最终订单列表 = M0 + MN（currentBuyOrders）
    const finalBuyOrders = [...m0, ...currentBuyOrders];

    // 记录结果
    console.log(
      `[历史订单记录] ${positionType} ${normalizedSymbol}: ` +
        `历史买入${allBuyOrders.length}笔, ` +
        `历史卖出${sortedSellOrders.length}笔, ` +
        `最终记录${finalBuyOrders.length}笔`
    );

    // 打印记录的订单详情
    if (finalBuyOrders.length > 0) {
      console.log(`\n记录的买入订单详情：`);
      finalBuyOrders.forEach((order, index) => {
        const timeStr = new Date(order.executedTime).toLocaleString("zh-CN");
        console.log(
          `  ${index + 1}. 订单ID: ${order.orderId}, ` +
            `成交价: ${order.executedPrice.toFixed(3)}, ` +
            `数量: ${order.executedQuantity}, ` +
            `成交时间: ${timeStr}`
        );
      });
    }

    return finalBuyOrders;
  } catch (error) {
    console.error(
      `[历史订单记录失败] ${isLongSymbol ? "做多标的" : "做空标的"} ${symbol}`,
      error.message || error
    );
    return [];
  }
}

// 主函数
try {
  const config = createConfig();
  const ctx = await TradeContext.new(config);

  // 获取做多和做空标的的代码
  const longSymbol = process.env.LONG_SYMBOL;
  const shortSymbol = process.env.SHORT_SYMBOL;

  if (!longSymbol || !shortSymbol) {
    console.error("错误：未配置做多或做空标的");
    console.error("请设置环境变量 LONG_SYMBOL 和 SHORT_SYMBOL");
    console.error("\n提示：");
    console.error("1. 确保项目根目录存在 .env 文件");
    console.error("2. 在 .env 文件中设置：");
    console.error("   LONG_SYMBOL=54806");
    console.error("   SHORT_SYMBOL=63372");
    console.error("3. 或者通过命令行设置环境变量：");
    console.error("   export LONG_SYMBOL=54806");
    console.error("   export SHORT_SYMBOL=63372");
    process.exit(1);
  }

  console.log("开始获取历史买入订单记录...\n");

  // 分别获取做多和做空标的的历史买入订单
  const [longBuyOrders, shortBuyOrders] = await Promise.all([
    getHistoryBuyOrders(ctx, longSymbol, true),
    getHistoryBuyOrders(ctx, shortSymbol, false),
  ]);

  console.log("\n=== 汇总 ===");
  console.log(
    `做多标的 ${normalizeHKSymbol(longSymbol)}: 记录 ${
      longBuyOrders.length
    } 笔买入订单`
  );
  console.log(
    `做空标的 ${normalizeHKSymbol(shortSymbol)}: 记录 ${
      shortBuyOrders.length
    } 笔买入订单`
  );
} catch (error) {
  console.error("程序执行失败：", error);
  process.exit(1);
}
