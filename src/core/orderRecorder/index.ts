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
 * - 智能平仓开启：仅卖出 buyPrice < currentPrice 的盈利订单
 * - 智能平仓关闭：直接清空所有持仓
 *
 * 缓存机制：
 * - 订单数据永久缓存（程序运行期间）
 * - 首次调用时从 API 获取并缓存，之后使用缓存
 * - 避免频繁调用 historyOrders API
 */

import { logger } from '../../utils/logger/index.js';
import { getDirectionName, formatSymbolDisplayFromQuote } from '../../utils/helpers/index.js';
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

/** 创建订单记录器（门面模式），协调存储、API和过滤引擎 */
export const createOrderRecorder = (deps: OrderRecorderDeps): OrderRecorder => {
  const { ctxPromise, rateLimiter } = deps;

  // 按依赖顺序初始化子模块
  const storage = createOrderStorage();
  const apiManager = createOrderAPIManager({ ctxPromise, rateLimiter });
  const filteringEngine = createOrderFilteringEngine();

  // ============================================
  // 私有方法 - 验证和工具
  // ============================================

  /** 验证订单参数有效性 */
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

  /** 输出订单刷新结果日志 */
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

  /** 计算订单统计信息（用于调试输出） */
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

  /** 输出订单列表的 debug 信息（仅 DEBUG 模式） */
  const debugOutputOrders = (symbol: string, isLongSymbol: boolean): void => {
    if (process.env['DEBUG'] !== 'true') {
      return;
    }

    const positionType = getDirectionName(isLongSymbol);
    const currentOrders = storage.getBuyOrdersList(symbol, isLongSymbol);

    const logLines = [
      `[订单记录变化] ${positionType} ${symbol}: 当前订单列表 (共${currentOrders.length}笔)`,
    ];

    if (currentOrders.length > 0) {
      const stats = calculateOrderStatistics(currentOrders);

      for (let index = 0; index < currentOrders.length; index++) {
        const order = currentOrders[index];
        if (!order) continue;

        // Inline time formatting (DEBUG only)
        let timeStr = '未知时间';
        if (order.executedTime) {
          const date = new Date(order.executedTime);
          timeStr = Number.isNaN(date.getTime())
            ? '无效时间'
            : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        }

        // Inline price formatting
        const priceStr = Number.isFinite(order.executedPrice)
          ? order.executedPrice.toFixed(3)
          : 'N/A';

        logLines.push(
          `  [${index + 1}] 订单ID: ${order.orderId || 'N/A'}, ` +
            `价格: ${priceStr}, ` +
            `数量: ${order.executedQuantity}, ` +
            `成交时间: ${timeStr}`,
        );
      }

      const avgPriceStr = Number.isFinite(stats.averagePrice)
        ? stats.averagePrice.toFixed(3)
        : 'N/A';
      logLines.push(
        `  统计: 总数量=${stats.totalQuantity}, 平均价格=${avgPriceStr}`,
      );
    } else {
      logLines.push('  当前无订单记录');
    }

    logger.debug(logLines.join('\n'));
  };

  // ============================================
  // 公有方法 - 订单记录操作
  // ============================================

  /** 记录一笔新的买入订单（本地更新，不调用 API） */
  const recordLocalBuy = (
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
  ): void => {
    const price = Number(executedPrice);
    const quantity = Number(executedQuantity);
    const executedTime = Number(executedTimeMs);

    if (!validateOrderParams(price, quantity, symbol)) {
      return;
    }

    const validExecutedTime = Number.isFinite(executedTime) && executedTime > 0
      ? executedTime
      : Date.now();

    storage.addBuyOrder(symbol, price, quantity, isLongSymbol, validExecutedTime);
    debugOutputOrders(symbol, isLongSymbol);
  };

  /**
   * 根据卖出订单更新本地买入记录
   * - 卖出数量 >= 总数量：清空记录
   * - 否则保留成交价 >= 卖出价的订单
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

  /** 清空指定标的的买入订单记录（用于保护性清仓） */
  const clearBuyOrders = (symbol: string, isLongSymbol: boolean, quote?: Quote | null): void => {
    storage.clearBuyOrders(symbol, isLongSymbol, quote);
  };

  /** 获取最新买入订单的成交价（用于买入价格限制检查） */
  const getLatestBuyOrderPrice = (symbol: string, isLongSymbol: boolean): number | null => {
    return storage.getLatestBuyOrderPrice(symbol, isLongSymbol);
  };

  /** 获取买入价低于当前价的订单（用于智能清仓决策） */
  const getBuyOrdersBelowPrice = (
    currentPrice: number,
    direction: 'LONG' | 'SHORT',
    symbol: string,
  ): OrderRecord[] => {
    return storage.getBuyOrdersBelowPrice(currentPrice, direction, symbol);
  };

  /** 计算订单列表的总成交数量 */
  const calculateTotalQuantity = (orders: OrderRecord[]): number => {
    return storage.calculateTotalQuantity(orders);
  };

  // ============================================
  // 公有方法 - 订单获取和刷新
  // ============================================

  /** 从 API 获取订单数据（启动时或强制刷新时调用） */
  const fetchOrdersFromAPI = async (symbol: string): Promise<FetchOrdersResult> => {
    return await apiManager.fetchOrdersFromAPI(symbol);
  };

  /**
   * 刷新订单记录（用于智能清仓决策）
   * 从 API 获取订单后应用过滤算法，更新本地存储
   */
  const refreshOrders = async (
    symbol: string,
    isLongSymbol: boolean,
    quote?: Quote | null,
  ): Promise<OrderRecord[]> => {
    try {
      const { buyOrders: allBuyOrders, sellOrders: filledSellOrders } =
        await apiManager.fetchOrdersFromAPI(symbol);

      // 如果没有买入订单，直接返回空列表
      if (allBuyOrders.length === 0) {
        if (isLongSymbol) {
          storage.setBuyOrdersListForLong(symbol, []);
        } else {
          storage.setBuyOrdersListForShort(symbol, []);
        }
        logRefreshResult(
          symbol,
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
          storage.setBuyOrdersListForLong(symbol, buyOrdersArray);
        } else {
          storage.setBuyOrdersListForShort(symbol, buyOrdersArray);
        }
        logRefreshResult(
          symbol,
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
        storage.setBuyOrdersListForLong(symbol, finalBuyOrders);
      } else {
        storage.setBuyOrdersListForShort(symbol, finalBuyOrders);
      }
      logRefreshResult(
        symbol,
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

  /** 检查指定标的列表是否都有缓存 */
  const hasCacheForSymbols = (symbols: string[]): boolean => {
    return apiManager.hasCacheForSymbols(symbols);
  };

  /** 从缓存中提取未成交订单（避免重复调用 todayOrders API） */
  const getPendingOrdersFromCache = (symbols: string[]): PendingOrder[] => {
    return apiManager.getPendingOrdersFromCache(symbols);
  };

  // ============================================
  // 暴露内部状态（用于 RiskChecker）
  // ============================================

  /** 获取所有做多标的的买入订单 */
  const getLongBuyOrders = (): OrderRecord[] => {
    return storage.getLongBuyOrders();
  };

  /** 获取所有做空标的的买入订单 */
  const getShortBuyOrders = (): OrderRecord[] => {
    return storage.getShortBuyOrders();
  };

  /** 获取指定标的的买入订单列表 */
  const getBuyOrdersForSymbol = (symbol: string, isLongSymbol: boolean): OrderRecord[] => {
    return storage.getBuyOrdersList(symbol, isLongSymbol);
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
