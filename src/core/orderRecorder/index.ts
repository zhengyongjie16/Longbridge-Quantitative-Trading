/**
 * 订单（持仓）记录模块（门面模式）
 *
 * 功能：
 * - 跟踪已成交的买入/卖出订单
 * - 提供智能清仓决策的历史订单数据
 * - 为浮亏监控提供原始订单数据（R1/N1）
 *
 * 过滤算法（从旧到新累积过滤）：
 * 1. M0：最新卖出时间之后成交的买入订单
 * 2. 过滤历史高价买入且未被完全卖出的订单
 * 3. 最终记录 = M0 + 过滤后的买入订单
 *
 * 智能清仓逻辑：
 * - 当 currentPrice > costPrice：清空所有持仓
 * - 当 currentPrice ≤ costPrice：仅卖出 buyPrice < currentPrice 的订单
 *
 * 缓存机制：
 * - 订单数据永久缓存（程序运行期间）
 * - 首次调用时从 API 获取并缓存，之后使用缓存
 * - 避免频繁调用 historyOrders API
 */

import { logger } from '../../utils/logger/index.js';
import {
  normalizeHKSymbol,
  getDirectionName,
  formatSymbolDisplayFromQuote,
} from '../../utils/helpers/index.js';
import type {
  OrderRecord,
  FetchOrdersResult,
  OrderRecorder,
  PendingOrder,
  Quote,
} from '../../types/index.js';
import type {
  OrderStatistics,
  OrderRecorderDeps,
} from './types.js';
import { createOrderStorage } from './orderStorage.js';
import { createOrderAPIManager } from './orderAPIManager.js';
import { createOrderFilteringEngine } from './orderFilteringEngine.js';

/**
 * 创建订单记录器（门面模式）
 * @param deps 依赖注入
 * @returns OrderRecorder 接口实例
 */
export const createOrderRecorder = (deps: OrderRecorderDeps): OrderRecorder => {
  const { ctxPromise, rateLimiter } = deps;

  // 按依赖顺序初始化子模块
  const storage = createOrderStorage();
  const apiManager = createOrderAPIManager({ ctxPromise, rateLimiter });
  const filteringEngine = createOrderFilteringEngine();

  // ============================================
  // 私有方法 - 验证和工具
  // ============================================

  /**
   * 验证订单参数
   */
  const validateOrderParams = (
    price: number,
    quantity: number,
    symbol: string,
  ): boolean => {
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      logger.warn(
        `[现存订单记录] 订单参数无效，跳过记录：symbol=${symbol}, price=${price}, quantity=${quantity}`,
      );
      return false;
    }
    return true;
  };

  // ============================================
  // 私有方法 - 日志和调试
  // ============================================

  /**
   * 输出刷新结果日志
   */
  const logRefreshResult = (
    symbol: string,
    isLongSymbol: boolean,
    originalBuyCount: number,
    sellCount: number,
    recordedCount: number,
    extraInfo?: string,
    quote?: Quote | null,
  ): void => {
    const positionType = getDirectionName(isLongSymbol);

    // 使用 formatSymbolDisplayFromQuote 格式化标的显示
    const symbolDisplay = formatSymbolDisplayFromQuote(quote, symbol);

    if (extraInfo) {
      logger.info(`[现存订单记录] ${positionType} ${symbolDisplay}: ${extraInfo}`);
    } else {
      logger.info(
        `[现存订单记录] ${positionType} ${symbolDisplay}: ` +
          `历史买入${originalBuyCount}笔, ` +
          `历史卖出${sellCount}笔, ` +
          `最终记录${recordedCount}笔`,
      );
    }
  };

  /**
   * 计算订单统计信息
   */
  const calculateOrderStatistics = (
    orders: OrderRecord[],
  ): OrderStatistics => {
    let totalQuantity = 0;
    let totalValue = 0;

    for (const order of orders) {
      const quantity = Number.isFinite(order.executedQuantity)
        ? order.executedQuantity
        : 0;
      const price = Number.isFinite(order.executedPrice)
        ? order.executedPrice
        : 0;

      totalQuantity += quantity;
      totalValue += price * quantity;
    }

    const averagePrice = totalQuantity > 0 ? totalValue / totalQuantity : 0;

    return { totalQuantity, totalValue, averagePrice };
  };

  /**
   * 格式化订单时间
   */
  const formatOrderTime = (executedTime: number): string => {
    if (!executedTime) {
      return '未知时间';
    }

    try {
      const date = new Date(executedTime);
      if (Number.isNaN(date.getTime())) {
        return '无效时间';
      }
      return date.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
      });
    } catch {
      return '无效时间';
    }
  };

  /**
   * 格式化价格
   */
  const formatPrice = (price: number): string => {
    return Number.isFinite(price) ? price.toFixed(3) : 'N/A';
  };

  /**
   * 输出订单列表的debug信息（仅在DEBUG模式下）
   */
  const debugOutputOrders = (symbol: string, isLongSymbol: boolean): void => {
    if (process.env['DEBUG'] !== 'true') {
      return;
    }

    const positionType = getDirectionName(isLongSymbol);
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const currentOrders = storage.getBuyOrdersList(
      normalizedSymbol,
      isLongSymbol,
    );

    const logLines = [
      `[订单记录变化] ${positionType} ${normalizedSymbol}: 当前订单列表 (共${currentOrders.length}笔)`,
    ];

    if (currentOrders.length > 0) {
      const stats = calculateOrderStatistics(currentOrders);

      currentOrders.forEach((order, index) => {
        const timeStr = formatOrderTime(order.executedTime);
        const priceStr = formatPrice(order.executedPrice);

        logLines.push(
          `  [${index + 1}] 订单ID: ${order.orderId || 'N/A'}, ` +
            `价格: ${priceStr}, ` +
            `数量: ${order.executedQuantity}, ` +
            `成交时间: ${timeStr}`,
        );
      });

      logLines.push(
        `  统计: 总数量=${stats.totalQuantity}, 平均价格=${formatPrice(stats.averagePrice)}`,
      );
    } else {
      logLines.push('  当前无订单记录');
    }

    logger.debug(logLines.join('\n'));
  };

  // ============================================
  // 公有方法 - 订单记录操作
  // ============================================

  /**
   * 记录一笔新的买入订单（仅在程序运行期间本地更新，不调用 API）
   */
  const recordLocalBuy = (
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
  ): void => {
    const price = Number(executedPrice);
    const quantity = Number(executedQuantity);

    if (!validateOrderParams(price, quantity, symbol)) {
      return;
    }

    storage.addBuyOrder(symbol, price, quantity, isLongSymbol);
    debugOutputOrders(symbol, isLongSymbol);
  };

  /**
   * 根据一笔新的卖出订单，本地更新买入订单记录（不再调用 API）
   *
   * 规则：
   * 1. 如果本地买入记录的总数量 <= 本次卖出数量，认为全部卖出，清空记录
   * 2. 否则，仅保留成交价 >= 本次卖出价的买入订单
   */
  const recordLocalSell = (
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
  ): void => {
    const price = Number(executedPrice);
    const quantity = Number(executedQuantity);

    if (!validateOrderParams(price, quantity, symbol)) {
      return;
    }

    storage.updateAfterSell(symbol, price, quantity, isLongSymbol);
    debugOutputOrders(symbol, isLongSymbol);
  };

  /**
   * 清空指定标的的买入订单记录（用于保护性清仓等无条件清仓场景）
   */
  const clearBuyOrders = (symbol: string, isLongSymbol: boolean, quote?: Quote | null): void => {
    storage.clearBuyOrders(symbol, isLongSymbol, quote);
  };

  /**
   * 获取最新买入订单的成交价（用于买入价格限制检查）
   */
  const getLatestBuyOrderPrice = (symbol: string, isLongSymbol: boolean): number | null => {
    return storage.getLatestBuyOrderPrice(symbol, isLongSymbol);
  };

  /**
   * 根据当前价格获取指定标的中买入价低于当前价的订单
   *
   * @param currentPrice 当前价格
   * @param direction 方向（LONG 或 SHORT）
   * @param symbol 标的代码（必须指定，用于多标的场景下精确查询）
   */
  const getBuyOrdersBelowPrice = (
    currentPrice: number,
    direction: 'LONG' | 'SHORT',
    symbol: string,
  ): OrderRecord[] => {
    return storage.getBuyOrdersBelowPrice(currentPrice, direction, symbol);
  };

  /**
   * 计算订单列表的总成交数量
   */
  const calculateTotalQuantity = (orders: OrderRecord[]): number => {
    return storage.calculateTotalQuantity(orders);
  };

  // ============================================
  // 公有方法 - 订单获取和刷新
  // ============================================

  /**
   * 从API获取并转换订单数据（公开方法，用于启动时或需要强制刷新时调用）
   * 调用此方法会同时从历史订单和今日订单API获取数据，合并并去重后更新缓存
   */
  const fetchOrdersFromAPI = async (symbol: string): Promise<FetchOrdersResult> => {
    return await apiManager.fetchOrdersFromAPI(symbol);
  };

  /**
   * 刷新订单记录（用于智能清仓决策）
   * 过滤逻辑：
   * 1. 获取历史所有买入订单（已成交）
   * 2. 获取历史所有卖出订单（已成交）
   * 3. 如果没有卖出订单，记录所有买入订单
   * 4. 如果有卖出订单，应用复杂的过滤算法
   */
  const refreshOrders = async (
    symbol: string,
    isLongSymbol: boolean,
    quote?: Quote | null,
  ): Promise<OrderRecord[]> => {
    try {
      const normalizedSymbol = normalizeHKSymbol(symbol);
      const { buyOrders: allBuyOrders, sellOrders: filledSellOrders } =
        await apiManager.fetchOrdersFromAPI(symbol);

      // 如果没有买入订单，直接返回空列表
      if (allBuyOrders.length === 0) {
        if (isLongSymbol) {
          storage.setBuyOrdersListForLong(normalizedSymbol, []);
        } else {
          storage.setBuyOrdersListForShort(normalizedSymbol, []);
        }
        logRefreshResult(
          normalizedSymbol,
          isLongSymbol,
          0,
          0,
          0,
          '历史买入0笔, 无需记录',
          quote,
        );
        return [];
      }

      // 如果没有卖出订单，记录所有买入订单
      if (filledSellOrders.length === 0) {
        const buyOrdersArray = [...allBuyOrders];
        if (isLongSymbol) {
          storage.setBuyOrdersListForLong(normalizedSymbol, buyOrdersArray);
        } else {
          storage.setBuyOrdersListForShort(normalizedSymbol, buyOrdersArray);
        }
        logRefreshResult(
          normalizedSymbol,
          isLongSymbol,
          allBuyOrders.length,
          0,
          allBuyOrders.length,
          '无卖出记录, 记录全部买入订单',
          quote,
        );
        return buyOrdersArray;
      }

      // 应用过滤算法
      const finalBuyOrders = filteringEngine.applyFilteringAlgorithm(
        [...allBuyOrders],
        [...filledSellOrders],
      );

      // 更新记录
      if (isLongSymbol) {
        storage.setBuyOrdersListForLong(normalizedSymbol, finalBuyOrders);
      } else {
        storage.setBuyOrdersListForShort(normalizedSymbol, finalBuyOrders);
      }
      logRefreshResult(
        normalizedSymbol,
        isLongSymbol,
        allBuyOrders.length,
        filledSellOrders.length,
        finalBuyOrders.length,
        undefined,
        quote,
      );

      return finalBuyOrders;
    } catch (error) {
      logger.error(
        `[订单记录失败] 标的 ${symbol}`,
        (error as Error)?.message ?? String(error),
      );
      return [];
    }
  };

  // ============================================
  // 公有方法 - 缓存管理
  // ============================================

  /**
   * 检查指定标的的缓存是否存在
   */
  const hasCacheForSymbols = (symbols: string[]): boolean => {
    return apiManager.hasCacheForSymbols(symbols);
  };

  /**
   * 从缓存的原始订单中提取未成交订单（用于启动时避免重复调用 todayOrders）
   */
  const getPendingOrdersFromCache = (symbols: string[]): PendingOrder[] => {
    return apiManager.getPendingOrdersFromCache(symbols);
  };

  // ============================================
  // 暴露内部状态（用于 RiskChecker）
  // ============================================

  /**
   * 获取做多标的的买入订单列表（公共方法）
   */
  const getLongBuyOrders = (): OrderRecord[] => {
    return storage.getLongBuyOrders();
  };

  /**
   * 获取做空标的的买入订单列表（公共方法）
   */
  const getShortBuyOrders = (): OrderRecord[] => {
    return storage.getShortBuyOrders();
  };

  /**
   * 获取指定标的的买入订单列表（公共方法）
   * 使用 O(1) 查找性能，直接从 Map 获取
   */
  const getBuyOrdersForSymbol = (symbol: string, isLongSymbol: boolean): OrderRecord[] => {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    return storage.getBuyOrdersList(normalizedSymbol, isLongSymbol);
  };

  return {
    recordLocalBuy,
    recordLocalSell,
    clearBuyOrders,
    getLatestBuyOrderPrice,
    getBuyOrdersBelowPrice,
    calculateTotalQuantity,
    fetchOrdersFromAPI,
    refreshOrders,
    hasCacheForSymbols,
    getPendingOrdersFromCache,
    getLongBuyOrders,
    getShortBuyOrders,
    getBuyOrdersForSymbol,
  };
};
