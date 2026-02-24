/**
 * 订单（持仓）记录模块（门面模式）
 *
 * 功能：
 * - 跟踪已成交的买入/卖出订单
 * - 提供智能清仓决策的历史订单数据
 * - 为浮亏监控提供原始订单数据（R1/N1）
 * - 追踪待成交卖出订单
 *
 * 过滤算法（从旧到新累积过滤）：
 * 1. M0：最新卖出时间之后成交的买入订单（无条件保留）
 * 2. 过滤历史高价买入且未被完全卖出的订单
 * 3. 最终记录 = M0 + 过滤后的买入订单
 *
 * 智能清仓逻辑：
 * - 智能平仓开启：仅卖出 buyPrice < currentPrice 的盈利订单
 * - 智能平仓关闭：直接清空所有持仓
 *
 * 缓存机制：
 * - 订单数据缓存到显式清空/刷新为止
 * - 首次调用时从 API 获取并缓存，之后使用缓存
 * - 避免频繁调用 historyOrders API
 */
import { logger } from '../../utils/logger/index.js';
import {
  getLongDirectionName,
  getShortDirectionName,
  formatSymbolDisplayFromQuote,
  isValidPositiveNumber,
} from '../../utils/helpers/index.js';
import type { Quote } from '../../types/quote.js';
import type { OrderRecord, OrderRecorder, RawOrderFromAPI } from '../../types/services.js';
import type {
  OrderRecorderDeps,
  OrderStatistics,
  PendingSellInfo,
  ProfitableOrderResult,
} from './types.js';
import { calculateOrderStatistics, classifyAndConvertOrders } from './utils.js';

/**
 * 验证订单参数有效性
 * @param price - 订单价格
 * @param quantity - 订单数量
 * @param symbol - 标的代码
 * @returns 参数有效返回 true，否则返回 false
 */
function validateOrderParams(price: number, quantity: number, symbol: string): boolean {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
    logger.warn(
      `[现存订单记录] 订单参数无效，跳过记录：symbol=${symbol}, price=${price}, quantity=${quantity}`,
    );
    return false;
  }
  return true;
}

/**
 * 记录订单刷新结果日志
 * @param symbol - 标的代码
 * @param isLongSymbol - 是否为做多标的
 * @param originalBuyCount - 历史买入订单数量
 * @param sellCount - 历史卖出订单数量
 * @param recordedCount - 最终记录数量
 * @param extraInfo - 额外信息（可选）
 * @param quote - 行情数据（可选）
 */
function logRefreshResult(
  symbol: string,
  isLongSymbol: boolean,
  originalBuyCount: number,
  sellCount: number,
  recordedCount: number,
  extraInfo?: string,
  quote?: Quote | null,
): void {
  const positionType = isLongSymbol ? getLongDirectionName() : getShortDirectionName();
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
}

/**
 * 格式化订单成交时间为可读字符串
 * @param executedTime - 成交时间戳（毫秒）
 * @returns 格式化的时间字符串
 */
function formatOrderExecutedTime(executedTime: number): string {
  if (!executedTime) return '未知时间';
  const date = new Date(executedTime);
  return Number.isNaN(date.getTime())
    ? '无效时间'
    : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/**
 * 格式化订单信息为日志行
 * @param order - 订单记录
 * @param index - 订单索引
 * @returns 格式化的订单信息字符串
 */
function formatOrderLine(order: OrderRecord, index: number): string {
  const timeStr = formatOrderExecutedTime(order.executedTime);
  const priceStr = Number.isFinite(order.executedPrice) ? order.executedPrice.toFixed(3) : 'N/A';
  return `  [${index + 1}] 订单ID: ${order.orderId || 'N/A'}, 价格: ${priceStr}, 数量: ${order.executedQuantity}, 成交时间: ${timeStr}`;
}

/**
 * 格式化订单统计信息为日志行
 * @param stats - 订单统计数据
 * @returns 格式化的统计信息字符串
 */
function formatOrderStatsLine(stats: OrderStatistics): string {
  const avgPriceStr = Number.isFinite(stats.averagePrice) ? stats.averagePrice.toFixed(3) : 'N/A';
  return `  统计: 总数量=${stats.totalQuantity}, 平均价格=${avgPriceStr}`;
}

/**
 * 创建订单记录器（门面模式），协调存储、API 和过滤引擎，提供本地订单记录与盈利卖单计算。
 * @param deps 依赖注入（storage、apiManager、filteringEngine）
 * @returns OrderRecorder 接口实例
 */
export function createOrderRecorder(deps: OrderRecorderDeps): OrderRecorder {
  const { storage, apiManager, filteringEngine } = deps;

  /** DEBUG 模式下输出指定标的当前订单列表及统计信息 */
  function debugOutputOrders(symbol: string, isLongSymbol: boolean): void {
    if (process.env['DEBUG'] !== 'true') return;

    const positionType = isLongSymbol ? getLongDirectionName() : getShortDirectionName();
    const currentOrders = storage.getBuyOrdersList(symbol, isLongSymbol);
    const header = `[订单记录变化] ${positionType} ${symbol}: 当前订单列表 (共${currentOrders.length}笔)`;

    const logLines: string[] = [header];
    if (currentOrders.length === 0) {
      logLines.push('  当前无订单记录');
    } else {
      currentOrders.forEach((order, index) => {
        logLines.push(formatOrderLine(order, index));
      });
      logLines.push(formatOrderStatsLine(calculateOrderStatistics(currentOrders)));
    }
    logger.debug(logLines.join('\n'));
  }

  /** 使用已获取的订单列表刷新本地记录（做多标的） */
  function applyOrdersRefreshForLong(
    symbol: string,
    allBuyOrders: ReadonlyArray<OrderRecord>,
    filledSellOrders: ReadonlyArray<OrderRecord>,
    quote?: Quote | null,
  ): OrderRecord[] {
    if (allBuyOrders.length === 0) {
      storage.setBuyOrdersListForLong(symbol, []);
      logRefreshResult(symbol, true, 0, 0, 0, '历史买入0笔, 无需记录', quote);
      return [];
    }

    if (filledSellOrders.length === 0) {
      const buyOrdersArray = [...allBuyOrders];
      storage.setBuyOrdersListForLong(symbol, buyOrdersArray);
      logRefreshResult(
        symbol,
        true,
        allBuyOrders.length,
        0,
        allBuyOrders.length,
        '无卖出记录, 记录全部买入订单',
        quote,
      );
      return buyOrdersArray;
    }

    const finalBuyOrders = [
      ...filteringEngine.applyFilteringAlgorithm(allBuyOrders, filledSellOrders),
    ];
    storage.setBuyOrdersListForLong(symbol, finalBuyOrders);
    logRefreshResult(
      symbol,
      true,
      allBuyOrders.length,
      filledSellOrders.length,
      finalBuyOrders.length,
      undefined,
      quote,
    );

    return finalBuyOrders;
  }

  /** 使用已获取的订单列表刷新本地记录（做空标的） */
  function applyOrdersRefreshForShort(
    symbol: string,
    allBuyOrders: ReadonlyArray<OrderRecord>,
    filledSellOrders: ReadonlyArray<OrderRecord>,
    quote?: Quote | null,
  ): OrderRecord[] {
    if (allBuyOrders.length === 0) {
      storage.setBuyOrdersListForShort(symbol, []);
      logRefreshResult(symbol, false, 0, 0, 0, '历史买入0笔, 无需记录', quote);
      return [];
    }

    if (filledSellOrders.length === 0) {
      const buyOrdersArray = [...allBuyOrders];
      storage.setBuyOrdersListForShort(symbol, buyOrdersArray);
      logRefreshResult(
        symbol,
        false,
        allBuyOrders.length,
        0,
        allBuyOrders.length,
        '无卖出记录, 记录全部买入订单',
        quote,
      );
      return buyOrdersArray;
    }

    const finalBuyOrders = [
      ...filteringEngine.applyFilteringAlgorithm(allBuyOrders, filledSellOrders),
    ];
    storage.setBuyOrdersListForShort(symbol, finalBuyOrders);
    logRefreshResult(
      symbol,
      false,
      allBuyOrders.length,
      filledSellOrders.length,
      finalBuyOrders.length,
      undefined,
      quote,
    );

    return finalBuyOrders;
  }

  // ============================================
  // 公有方法 - 订单记录操作
  // ============================================

  /** 记录一笔新的买入订单（本地更新，不调用 API） */
  function recordLocalBuy(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
  ): void {
    const price = executedPrice;
    const quantity = executedQuantity;
    const executedTime = executedTimeMs;

    if (!validateOrderParams(price, quantity, symbol)) {
      return;
    }

    const validExecutedTime = isValidPositiveNumber(executedTime) ? executedTime : Date.now();

    storage.addBuyOrder(symbol, price, quantity, isLongSymbol, validExecutedTime);
    debugOutputOrders(symbol, isLongSymbol);
  }

  /**
   * 根据卖出订单更新本地买入记录
   * - 卖出数量 >= 总数量：清空记录
   * - 否则保留成交价 >= 卖出价的订单
   */
  function recordLocalSell(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
    orderId?: string | null,
  ): void {
    const price = executedPrice;
    const quantity = executedQuantity;

    if (!validateOrderParams(price, quantity, symbol)) {
      return;
    }

    storage.updateAfterSell(symbol, price, quantity, isLongSymbol, executedTimeMs, orderId);
    debugOutputOrders(symbol, isLongSymbol);
  }

  /** 清空指定标的的买入订单记录（用于保护性清仓） */
  function clearBuyOrders(symbol: string, isLongSymbol: boolean, quote?: Quote | null): void {
    storage.clearBuyOrders(symbol, isLongSymbol, quote);
  }

  /** 获取最新买入订单的成交价（用于买入价格限制检查） */
  function getLatestBuyOrderPrice(symbol: string, isLongSymbol: boolean): number | null {
    return storage.getLatestBuyOrderPrice(symbol, isLongSymbol);
  }

  /** 获取指定标的的最新卖出记录 */
  function getLatestSellRecord(symbol: string, isLongSymbol: boolean): OrderRecord | null {
    return storage.getLatestSellRecord(symbol, isLongSymbol);
  }

  // ============================================
  // 公有方法 - 订单获取和刷新
  // ============================================

  /** 从 API 获取全量订单数据（启动时调用一次） */
  async function fetchAllOrdersFromAPI(
    forceRefresh = false,
  ): Promise<ReadonlyArray<RawOrderFromAPI>> {
    return apiManager.fetchAllOrdersFromAPI(forceRefresh);
  }

  /**
   * 使用全量订单刷新指定标的订单记录（做多标的）
   * 仅过滤 symbol 对应订单，不触发 API 调用
   */
  async function refreshOrdersFromAllOrdersForLong(
    symbol: string,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    quote?: Quote | null,
  ): Promise<OrderRecord[]> {
    try {
      const filteredOrders = allOrders.filter((order) => order.symbol === symbol);
      const { buyOrders: allBuyOrders, sellOrders: filledSellOrders } =
        classifyAndConvertOrders(filteredOrders);

      apiManager.cacheOrdersForSymbol(symbol, allBuyOrders, filledSellOrders, filteredOrders);

      return applyOrdersRefreshForLong(symbol, allBuyOrders, filledSellOrders, quote);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[订单记录失败] 标的 ${symbol}`, errorMessage);
      return [];
    }
  }

  /**
   * 使用全量订单刷新指定标的订单记录（做空标的）
   * 仅过滤 symbol 对应订单，不触发 API 调用
   */
  async function refreshOrdersFromAllOrdersForShort(
    symbol: string,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    quote?: Quote | null,
  ): Promise<OrderRecord[]> {
    try {
      const filteredOrders = allOrders.filter((order) => order.symbol === symbol);
      const { buyOrders: allBuyOrders, sellOrders: filledSellOrders } =
        classifyAndConvertOrders(filteredOrders);

      apiManager.cacheOrdersForSymbol(symbol, allBuyOrders, filledSellOrders, filteredOrders);

      return applyOrdersRefreshForShort(symbol, allBuyOrders, filledSellOrders, quote);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[订单记录失败] 标的 ${symbol}`, errorMessage);
      return [];
    }
  }

  // ============================================
  // 公有方法 - 缓存管理
  // ============================================

  /** 清理指定标的的订单缓存 */
  function clearOrdersCacheForSymbol(symbol: string): void {
    apiManager.clearCacheForSymbol(symbol);
  }

  /** 获取指定标的的买入订单列表 */
  function getBuyOrdersForSymbol(
    symbol: string,
    isLongSymbol: boolean,
  ): ReadonlyArray<OrderRecord> {
    return storage.getBuyOrdersList(symbol, isLongSymbol);
  }

  // ============================================
  // 待成交卖出订单追踪
  // ============================================

  /** 提交卖出订单时调用（添加待成交追踪） */
  function submitSellOrder(
    orderId: string,
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
    relatedBuyOrderIds: readonly string[],
  ): void {
    storage.addPendingSell({
      orderId,
      symbol,
      direction,
      submittedQuantity: quantity,
      relatedBuyOrderIds,
      submittedAt: Date.now(),
    });

    logger.info(
      `[订单记录器] 卖出订单提交追踪: ${orderId} ${symbol} ${direction} ${quantity}股 ` +
        `关联订单=${relatedBuyOrderIds.length}个`,
    );
  }

  /** 标记卖出订单完全成交 */
  function markSellFilled(orderId: string): PendingSellInfo | null {
    return storage.markSellFilled(orderId);
  }

  /** 标记卖出订单部分成交 */
  function markSellPartialFilled(orderId: string, filledQuantity: number): PendingSellInfo | null {
    return storage.markSellPartialFilled(orderId, filledQuantity);
  }

  /** 标记卖出订单取消 */
  function markSellCancelled(orderId: string): PendingSellInfo | null {
    return storage.markSellCancelled(orderId);
  }

  /** 恢复期：为待恢复的卖单分配关联买单 ID */
  function allocateRelatedBuyOrderIdsForRecovery(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
  ): readonly string[] {
    return storage.allocateRelatedBuyOrderIdsForRecovery(symbol, direction, quantity);
  }

  /** 获取指定标的的成本均价（实时计算，无缓存） */
  function getCostAveragePrice(symbol: string, isLongSymbol: boolean): number | null {
    return storage.getCostAveragePrice(symbol, isLongSymbol);
  }

  /** 获取可卖出的订单（核心防重逻辑） */
  function getSellableOrders(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    currentPrice: number,
    maxSellQuantity?: number,
    options?: { readonly includeAll?: boolean },
  ): ProfitableOrderResult {
    return storage.getSellableOrders(symbol, direction, currentPrice, maxSellQuantity, options);
  }

  /** 重置所有订单记录（storage.clearAll + apiManager.clearCache） */
  function resetAll(): void {
    storage.clearAll();
    apiManager.clearCache();
  }

  return {
    recordLocalBuy,
    recordLocalSell,
    clearBuyOrders,
    getLatestBuyOrderPrice,
    getLatestSellRecord,
    fetchAllOrdersFromAPI,
    refreshOrdersFromAllOrdersForLong,
    refreshOrdersFromAllOrdersForShort,
    clearOrdersCacheForSymbol,
    getBuyOrdersForSymbol,

    // 待成交卖出订单追踪
    submitSellOrder,
    markSellFilled,
    markSellPartialFilled,
    markSellCancelled,
    allocateRelatedBuyOrderIdsForRecovery,
    getCostAveragePrice,
    getSellableOrders,

    resetAll,
  };
}
