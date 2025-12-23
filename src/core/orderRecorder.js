import { OrderSide, OrderStatus } from "longport";
import { logger } from "../utils/logger.js";
import { normalizeHKSymbol, decimalToNumber } from "../utils/helpers.js";

/**
 * 订单记录管理器
 * 用于记录做多和做空标的的当日买入且已成交订单
 */
export class OrderRecorder {
  constructor(trader) {
    this._trader = trader;
    // 记录做多标的的当日买入且已成交订单
    this._longBuyOrders = [];
    // 记录做空标的的当日买入且已成交订单
    this._shortBuyOrders = [];
    // 缓存订单数据，避免重复调用 todayOrders
    // 格式：{ symbol: { buyOrders: [], sellOrders: [], fetchTime: number } }
    this._ordersCache = new Map();
  }

  /**
   * 获取当前标的的买入订单记录列表（内部使用）
   * @param {string} symbol 标的代码
   * @param {boolean} isLongSymbol 是否为做多标的
   * @returns {Array} 买入订单记录数组
   *   - 仅包含 { symbol, executedPrice, executedQuantity, executedTime, orderId? }
   */
  _getBuyOrdersList(symbol, isLongSymbol) {
    const targetList = isLongSymbol
      ? this._longBuyOrders
      : this._shortBuyOrders;
    // 只返回当前标的的订单列表（避免不同标的混在一起）
    return targetList.filter((order) => order.symbol === symbol);
  }

  /**
   * 输出订单列表的debug信息（仅在DEBUG模式下）
   * @private
   * @param {string} symbol 标的代码
   * @param {boolean} isLongSymbol 是否为做多标的
   */
  _debugOutputOrders(symbol, isLongSymbol) {
    if (process.env.DEBUG === "true") {
      const positionType = isLongSymbol ? "做多标的" : "做空标的";
      const normalizedSymbol = normalizeHKSymbol(symbol);
      const currentOrders = isLongSymbol
        ? this._longBuyOrders.filter((o) => o.symbol === normalizedSymbol)
        : this._shortBuyOrders.filter((o) => o.symbol === normalizedSymbol);

      // 批量构建日志消息，减少多次logger.debug调用
      const logLines = [
        `[订单记录变化] ${positionType} ${normalizedSymbol}: 当前订单列表 (共${currentOrders.length}笔)`,
      ];

      if (currentOrders.length > 0) {
        // 批量计算统计信息
        let totalQuantity = 0;
        let totalValue = 0;

        currentOrders.forEach((order, index) => {
          // 安全地获取数值，防止 NaN 或无效值
          const quantity = Number.isFinite(order.executedQuantity)
            ? order.executedQuantity
            : 0;
          const price = Number.isFinite(order.executedPrice)
            ? order.executedPrice
            : 0;
          totalQuantity += quantity;
          totalValue += price * quantity;

          // 安全地格式化时间
          let timeStr = "未知时间";
          if (order.executedTime) {
            try {
              const date = new Date(order.executedTime);
              if (!Number.isNaN(date.getTime())) {
                timeStr = date.toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                });
              }
            } catch (err) {
              // 日期格式化失败，使用默认值
              // 在debug输出中静默处理是合理的，避免影响主程序执行
              timeStr = "无效时间";
              // eslint-disable-next-line no-unused-vars
              const _ = err; // 明确处理异常变量
            }
          }

          // 安全地格式化价格
          const priceStr = Number.isFinite(price) ? price.toFixed(3) : "N/A";
          logLines.push(
            `  [${index + 1}] 订单ID: ${order.orderId || "N/A"}, ` +
              `价格: ${priceStr}, ` +
              `数量: ${quantity}, ` +
              `成交时间: ${timeStr}`
          );
        });

        // 安全地计算和格式化平均价格
        const avgPrice = totalQuantity > 0 ? totalValue / totalQuantity : 0;
        const avgPriceStr = Number.isFinite(avgPrice)
          ? avgPrice.toFixed(3)
          : "N/A";
        logLines.push(
          `  统计: 总数量=${totalQuantity}, 平均价格=${avgPriceStr}`
        );
      } else {
        logLines.push(`  当前无订单记录`);
      }

      // 一次性输出所有日志（减少多次调用）
      logger.debug(logLines.join("\n"));
    }
  }

  /**
   * 替换当前标的的买入订单记录列表（内部使用）
   * @param {string} symbol 标的代码
   * @param {boolean} isLongSymbol 是否为做多标的
   * @param {Array} newList 新的订单列表
   */
  _setBuyOrdersList(symbol, isLongSymbol, newList) {
    if (isLongSymbol) {
      // 只保留其他标的的订单，再追加当前标的的新列表
      this._longBuyOrders = [
        ...this._longBuyOrders.filter((o) => o.symbol !== symbol),
        ...newList,
      ];
    } else {
      this._shortBuyOrders = [
        ...this._shortBuyOrders.filter((o) => o.symbol !== symbol),
        ...newList,
      ];
    }

    // 输出debug信息
    this._debugOutputOrders(symbol, isLongSymbol);
  }

  /**
   * 记录一笔新的买入订单（仅在程序运行期间本地更新，不调用 API）
   * @param {string} symbol 标的代码
   * @param {number} executedPrice 成交价
   * @param {number} executedQuantity 成交数量
   * @param {boolean} isLongSymbol 是否为做多标的
   */
  recordLocalBuy(symbol, executedPrice, executedQuantity, isLongSymbol) {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const price = Number(executedPrice);
    const quantity = Number(executedQuantity);

    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      logger.warn(
        `[现存订单记录] 本地买入记录参数无效，跳过记录：symbol=${symbol}, price=${executedPrice}, quantity=${executedQuantity}`
      );
      return;
    }

    const now = Date.now();
    const list = this._getBuyOrdersList(normalizedSymbol, isLongSymbol);

    list.push({
      orderId: `LOCAL_${now}`, // 仅用于调试，无业务含义
      symbol: normalizedSymbol,
      executedPrice: price,
      executedQuantity: quantity,
      executedTime: now,
    });

    this._setBuyOrdersList(normalizedSymbol, isLongSymbol, list);

    const positionType = isLongSymbol ? "做多标的" : "做空标的";
    logger.info(
      `[现存订单记录] 本地新增买入记录：${positionType} ${normalizedSymbol} 价格=${price.toFixed(
        3
      )} 数量=${quantity}`
    );
  }

  /**
   * 根据一笔新的卖出订单，本地更新买入订单记录（不再调用 API）
   *
   * 规则：
   * 1. 如果本地买入记录的总数量 <= 本次卖出数量，认为全部卖出，清空记录
   * 2. 否则，仅保留成交价 >= 本次卖出价的买入订单
   *
   * @param {string} symbol 标的代码
   * @param {number} executedPrice 卖出成交价
   * @param {number} executedQuantity 卖出成交数量
   * @param {boolean} isLongSymbol 是否为做多标的
   */
  recordLocalSell(symbol, executedPrice, executedQuantity, isLongSymbol) {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const price = Number(executedPrice);
    const quantity = Number(executedQuantity);

    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      logger.warn(
        `[现存订单记录] 本地卖出记录参数无效，跳过更新：symbol=${symbol}, price=${executedPrice}, quantity=${executedQuantity}`
      );
      return;
    }

    const list = this._getBuyOrdersList(normalizedSymbol, isLongSymbol);
    if (!list.length) {
      return;
    }

    const totalQuantity = list.reduce(
      (sum, order) => sum + (Number(order.executedQuantity) || 0),
      0
    );

    const positionType = isLongSymbol ? "做多标的" : "做空标的";

    // 如果卖出数量大于等于当前记录的总数量，视为全部卖出，清空记录
    if (quantity >= totalQuantity) {
      this._setBuyOrdersList(normalizedSymbol, isLongSymbol, []);
      logger.info(
        `[现存订单记录] 本地卖出更新：${positionType} ${normalizedSymbol} 卖出数量=${quantity} >= 当前记录总数量=${totalQuantity}，清空所有买入记录`
      );
      return;
    }

    // 否则，仅保留成交价 >= 本次卖出价的买入订单
    const filtered = list.filter(
      (order) =>
        Number.isFinite(order.executedPrice) && order.executedPrice >= price
    );

    this._setBuyOrdersList(normalizedSymbol, isLongSymbol, filtered);

    logger.info(
      `[现存订单记录] 本地卖出更新：${positionType} ${normalizedSymbol} 卖出数量=${quantity}，按价格过滤后剩余买入记录 ${filtered.length} 笔`
    );
  }

  /**
   * 获取最新买入订单的成交价（用于买入价格限制检查）
   * @param {string} symbol 标的代码
   * @param {boolean} isLongSymbol 是否为做多标的
   * @returns {number|null} 最新买入订单的成交价，如果没有订单则返回null
   */
  getLatestBuyOrderPrice(symbol, isLongSymbol) {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const list = this._getBuyOrdersList(normalizedSymbol, isLongSymbol);

    if (!list.length) {
      return null;
    }

    // 找出成交时间最新的订单
    const latestOrder = list.reduce((latest, current) => {
      if (!latest || current.executedTime > latest.executedTime) {
        return current;
      }
      return latest;
    }, null);

    return latestOrder ? latestOrder.executedPrice : null;
  }

  /**
   * 检查缓存是否有效
   * @private
   * @param {string} normalizedSymbol 规范化后的标的代码
   * @param {number} maxAgeMs 缓存最大有效期（毫秒），默认5分钟
   * @returns {boolean} 缓存是否有效
   */
  _isCacheValid(normalizedSymbol, maxAgeMs = 5 * 60 * 1000) {
    const cached = this._ordersCache.get(normalizedSymbol);
    if (!cached) {
      return false;
    }
    const now = Date.now();
    const cacheAge = now - cached.fetchTime;
    return cacheAge < maxAgeMs;
  }

  /**
   * 从缓存获取订单数据
   * @private
   * @param {string} normalizedSymbol 规范化后的标的代码
   * @returns {{buyOrders: Array, sellOrders: Array}|null} 缓存的订单数据，如果不存在则返回null
   */
  _getCachedOrders(normalizedSymbol) {
    const cached = this._ordersCache.get(normalizedSymbol);
    if (!cached) {
      return null;
    }
    return {
      buyOrders: cached.buyOrders,
      sellOrders: cached.sellOrders,
    };
  }

  /**
   * 更新缓存
   * @private
   * @param {string} normalizedSymbol 规范化后的标的代码
   * @param {Array} buyOrders 买入订单列表
   * @param {Array} sellOrders 卖出订单列表
   */
  _updateCache(normalizedSymbol, buyOrders, sellOrders) {
    this._ordersCache.set(normalizedSymbol, {
      buyOrders,
      sellOrders,
      fetchTime: Date.now(),
    });
  }

  /**
   * 从API获取并转换订单数据（公开方法，用于启动时或需要强制刷新时调用）
   * 调用此方法会从API获取最新订单数据并更新缓存
   * @param {string} symbol 标的代码
   * @returns {Promise<{buyOrders: Array, sellOrders: Array}>} 返回已转换的买入和卖出订单
   */
  async fetchOrdersFromAPI(symbol) {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const ctx = await this._trader._ctxPromise;

    // 获取当日订单
    const allOrders = await ctx.todayOrders({
      symbol: normalizedSymbol,
    });

    // 过滤出买入且已成交的订单
    const filledBuyOrders = allOrders.filter((order) => {
      return (
        order.side === OrderSide.Buy && // 买入订单
        order.status === OrderStatus.Filled // 已成交状态
      );
    });

    // 过滤出卖出且已成交的订单
    const filledSellOrders = allOrders.filter((order) => {
      return (
        order.side === OrderSide.Sell && // 卖出订单
        order.status === OrderStatus.Filled // 已成交状态
      );
    });

    // 转换订单为标准格式的通用函数
    const convertOrder = (order, isBuyOrder) => {
      const executedPrice = decimalToNumber(order.executedPrice);
      const executedQuantity = decimalToNumber(order.executedQuantity);
      const executedTime = order.updatedAt ? order.updatedAt.getTime() : 0;

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

      const converted = {
        orderId: order.orderId,
        symbol: normalizedSymbol,
        executedPrice: executedPrice,
        executedQuantity: executedQuantity,
        executedTime: executedTime,
      };

      // 买入订单额外包含时间戳字段（用于refreshOrders）
      if (isBuyOrder) {
        converted.submittedAt = order.submittedAt;
        converted.updatedAt = order.updatedAt;
      }

      return converted;
    };

    // 转换买入订单
    const buyOrders = filledBuyOrders
      .map((order) => convertOrder(order, true))
      .filter((order) => order !== null);

    // 转换卖出订单
    const sellOrders = filledSellOrders
      .map((order) => convertOrder(order, false))
      .filter((order) => order !== null);

    // 更新缓存
    this._updateCache(normalizedSymbol, buyOrders, sellOrders);

    return { buyOrders, sellOrders };
  }

  /**
   * 获取并转换订单数据（统一入口，默认使用缓存）
   * @private
   * @param {string} symbol 标的代码
   * @param {boolean} forceRefresh 是否强制刷新（忽略缓存），默认false（使用缓存）
   * @returns {Promise<{buyOrders: Array, sellOrders: Array}>} 返回已转换的买入和卖出订单
   */
  async _fetchAndConvertOrders(symbol, forceRefresh = false) {
    const normalizedSymbol = normalizeHKSymbol(symbol);

    // 如果不强制刷新，先检查缓存
    if (!forceRefresh && this._isCacheValid(normalizedSymbol)) {
      const cached = this._getCachedOrders(normalizedSymbol);
      if (cached) {
        return cached;
      }
    }

    // 缓存无效或强制刷新，从API获取
    return await this.fetchOrdersFromAPI(symbol);
  }

  /**
   * 刷新订单记录（用于智能清仓决策）
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
   *      e) 将这些过滤出的买入订单 + 成交时间 > D1 且 < D2成交时间 的买入订单 = M1
   *      f) 继续对 M1 使用 D2 的成交时间和成交价过滤，得到 M2
   *      g) 以此类推，得到 MN
   *    - 最终订单列表 = M0 + MN
   * @param {string} symbol 标的代码
   * @param {boolean} isLongSymbol 是否为做多标的（true=做多，false=做空）
   * @param {boolean} forceRefresh 是否强制刷新（忽略缓存），默认false（使用缓存）
   * @returns {Promise<Array>} 记录的订单列表
   */
  async refreshOrders(symbol, isLongSymbol, forceRefresh = false) {
    try {
      const normalizedSymbol = normalizeHKSymbol(symbol);

      // 使用统一方法获取和转换订单（默认使用缓存，forceRefresh=true时强制刷新）
      const { buyOrders: allBuyOrders, sellOrders: filledSellOrders } =
        await this._fetchAndConvertOrders(symbol, forceRefresh);

      // 如果没有买入订单，直接返回空列表
      if (allBuyOrders.length === 0) {
        if (isLongSymbol) {
          this._longBuyOrders = [];
          logger.info(
            `[现存订单记录] 做多标的 ${normalizedSymbol}: 当日买入0笔, 无需记录`
          );
        } else {
          this._shortBuyOrders = [];
          logger.info(
            `[现存订单记录] 做空标的 ${normalizedSymbol}: 当日买入0笔, 无需记录`
          );
        }
        // 输出debug信息
        this._debugOutputOrders(symbol, isLongSymbol);
        return [];
      }

      // 如果没有卖出订单，记录所有买入订单
      if (filledSellOrders.length === 0) {
        if (isLongSymbol) {
          this._longBuyOrders = allBuyOrders;
          logger.info(
            `[现存订单记录] 做多标的 ${normalizedSymbol}: 当日买入${allBuyOrders.length}笔, 无卖出记录, 记录全部买入订单`
          );
        } else {
          this._shortBuyOrders = allBuyOrders;
          logger.info(
            `[现存订单记录] 做空标的 ${normalizedSymbol}: 当日买入${allBuyOrders.length}笔, 无卖出记录, 记录全部买入订单`
          );
        }
        // 输出debug信息
        this._debugOutputOrders(symbol, isLongSymbol);
        return allBuyOrders;
      }

      // 将卖出订单按成交时间从旧到新排序（最旧的在前）
      const sortedSellOrders = [...filledSellOrders].sort(
        (a, b) => a.executedTime - b.executedTime
      );

      // 1. 先获取M0：成交时间 > 最新卖出订单时间的买入订单
      const latestSellTime = sortedSellOrders.at(-1).executedTime; // 最新的卖出订单时间
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
        // 注意：对于D1，currentBuyOrders是所有成交时间 <= 最新卖出订单时间的买入订单
        // 对于D2，currentBuyOrders是M1，所以这里获取的是M1中成交时间 < D2成交时间的买入订单
        const buyOrdersBeforeSell = currentBuyOrders.filter(
          (buyOrder) => buyOrder.executedTime < sellTime
        );

        // 判断是否全部卖出：
        // 统一逻辑：判断当前卖出订单成交数量 >= 成交时间小于该卖出订单的买入订单总数量
        // - 对于D1：判断D1成交数量 >= 所有成交时间 < D1的买入订单总数量
        // - 对于D2：判断D2成交数量 >= M1中成交时间 < D2的买入订单总数量
        // - 对于D3：判断D3成交数量 >= M2中成交时间 < D3的买入订单总数量
        const quantityToCompare = buyOrdersBeforeSell.reduce(
          (sum, order) => sum + order.executedQuantity,
          0
        );

        // 如果卖出数量 >= 比较数量，说明成交时间小于该卖出订单的买入订单全部被卖出
        if (sellQuantity >= quantityToCompare) {
          // 从候选列表中移除这些买入订单（视为全部被卖出）
          // 保留成交时间 >= 当前卖出订单时间的买入订单
          currentBuyOrders = currentBuyOrders.filter(
            (buyOrder) => buyOrder.executedTime >= sellTime
          );
          // 无需继续过滤价格，直接跳到下一个卖出订单
          continue;
        }

        // 如果没有在此卖出订单之前的买入订单，跳过价格过滤
        if (buyOrdersBeforeSell.length === 0) {
          // 更新currentBuyOrders：保留成交时间 >= 当前卖出订单时间的买入订单
          currentBuyOrders = currentBuyOrders.filter(
            (buyOrder) => buyOrder.executedTime >= sellTime
          );
          continue;
        }

        // 否则，按价格过滤：从这些买入订单中过滤出 成交价 >= 卖出价 的买入订单
        // 例如：从M1中过滤出成交时间 < D2成交时间且成交价 >= D2成交价的买入订单
        const filteredBuyOrders = buyOrdersBeforeSell.filter(
          (buyOrder) => buyOrder.executedPrice >= sellPrice
        );

        // 获取成交时间 > 当前卖出订单时间 且 < 下一个卖出订单时间（如果存在）的买入订单
        // 注意：这些订单应该从currentBuyOrders中获取，因为currentBuyOrders是经过之前卖出订单过滤后的结果（M1, M2等）
        const buyOrdersBetweenSells = currentBuyOrders.filter((buyOrder) => {
          if (buyOrder.executedTime <= sellTime) {
            return false; // 排除 <= 当前卖出订单时间的订单
          }
          if (buyOrder.executedTime >= nextSellTime) {
            return false; // 排除 >= 下一个卖出订单时间的订单
          }
          return true;
        });

        // 合并：过滤出的买入订单 + 时间范围内的买入订单 = 新的currentBuyOrders（即M1, M2等）
        currentBuyOrders = [...filteredBuyOrders, ...buyOrdersBetweenSells];
      }

      // 最终订单列表 = M0 + currentBuyOrders（即M0 + MN）
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
        `[现存订单记录] ${positionType} ${normalizedSymbol}: ` +
          `当日买入${originalBuyCount}笔, ` +
          `当日卖出${filledSellOrders.length}笔(有效${sortedSellOrders.length}笔), ` +
          `最终过滤${filteredCount}笔, ` +
          `最终记录${recordedCount}笔`
      );

      // 输出debug信息
      this._debugOutputOrders(symbol, isLongSymbol);

      return finalBuyOrders;
    } catch (error) {
      logger.error(`[订单记录失败] 标的 ${symbol}`, error.message || error);
      return [];
    }
  }

  /**
   * 获取指定标的的全部买入和卖出订单（用于市值计算）
   * 返回全部已成交的买入订单和卖出订单，不经过过滤
   * @param {string} symbol 标的代码
   * @param {boolean} forceRefresh 是否强制刷新（忽略缓存），默认false
   * @returns {Promise<{buyOrders: Array, sellOrders: Array}>} 返回全部买入和卖出订单
   */
  async getAllOrdersForValueCalculation(symbol, forceRefresh = false) {
    try {
      // 使用统一方法获取和转换订单（默认使用缓存）
      return await this._fetchAndConvertOrders(symbol, forceRefresh);
    } catch (error) {
      logger.error(
        `[订单获取失败] 标的 ${symbol} 获取全部订单失败`,
        error.message || error
      );
      return {
        buyOrders: [],
        sellOrders: [],
      };
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

    const filteredOrders = this._longBuyOrders.filter(
      (order) =>
        Number.isFinite(order.executedPrice) &&
        order.executedPrice < currentPrice
    );

    logger.debug(
      `[根据订单记录过滤] 当前价格${currentPrice} 当前订单${this._longBuyOrders}，过滤后的订单${filteredOrders}`
    );

    return filteredOrders;
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
