/**
 * 订单监控模块
 *
 * 功能：
 * - 监控未成交的买入订单
 * - 当价格下跌时自动降低委托价
 * - 撤销订单
 * - 修改订单价格
 */

import { OrderStatus, OrderSide, Decimal } from 'longport';
import { logger } from '../../utils/logger/index.js';
import { TRADING } from '../../constants/index.js';
import { normalizeHKSymbol, decimalToNumber, isValidPositiveNumber } from '../../utils/helpers/index.js';
import type { Quote, PendingOrder } from '../../types/index.js';
import type { OrderMonitor, OrderMonitorDeps, OrderForReplace } from './types.js';
import { toOrderForReplace } from './types.js';

const toDecimal = (value: unknown): Decimal => {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return new Decimal(value);
  }
  return Decimal.ZERO();
};

// 首次检查延迟时间（毫秒），与缓存TTL保持一致
const INITIAL_CHECK_DELAY_MS = 30000;

/**
 * 创建订单监控器
 * @param deps 依赖注入
 * @returns OrderMonitor 接口实例
 */
export const createOrderMonitor = (deps: OrderMonitorDeps): OrderMonitor => {
  const { ctxPromise, rateLimiter, cacheManager } = deps;

  // 闭包捕获的私有状态
  // 需要监控的标的集合（标准化后的标的代码）
  const monitoringSymbols = new Set<string>();
  // 记录每个标的的监控启用时间，用于计算首次检查延迟
  const monitoringEnabledTimeMap = new Map<string, number>();

  /**
   * 启用指定标的的买入订单监控
   * @param symbol 需要监控的标的代码
   */
  const enableMonitoring = (symbol: string): void => {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    // 仅在该标的首次启用监控时记录时间
    if (!monitoringSymbols.has(normalizedSymbol)) {
      monitoringEnabledTimeMap.set(normalizedSymbol, Date.now());
    }
    monitoringSymbols.add(normalizedSymbol);
  };

  /**
   * 撤销订单
   * @param orderId 订单ID
   */
  const cancelOrder = async (orderId: string): Promise<boolean> => {
    const ctx = await ctxPromise;
    try {
      await rateLimiter.throttle();
      await ctx.cancelOrder(orderId);

      cacheManager.clearCache();

      logger.info(`[订单撤销成功] 订单ID=${orderId}`);
      return true;
    } catch (err) {
      logger.error(
        `[订单撤销失败] 订单ID=${orderId}`,
        (err as Error)?.message ?? String(err),
      );
      return false;
    }
  };

  /**
   * 修改订单价格
   * @param orderId 订单ID
   * @param newPrice 新价格
   * @param quantity 数量（可选，如果不提供则使用原订单数量）
   * @param cachedOrder 缓存的订单对象（可选，避免重复查询）
   * @returns 修改成功时不返回，失败时抛出错误
   * @throws 当修改失败时抛出错误
   */
  const replaceOrderPrice = async (
    orderId: string,
    newPrice: number,
    quantity: number | null = null,
    cachedOrder: PendingOrder | null = null,
  ): Promise<void> => {
    const ctx = await ctxPromise;

    let originalOrder: OrderForReplace | null = null;

    // 如果提供了缓存的订单对象，使用缓存；否则查询API
    if (cachedOrder) {
      // 使用类型安全的转换函数
      originalOrder = toOrderForReplace(cachedOrder);
      if (originalOrder) {
        logger.debug(`[订单修改] 使用缓存订单对象，订单ID=${orderId}`);
      }
    }

    if (!originalOrder) {
      // 没有缓存或转换失败，查询API
      logger.debug(`[订单修改] 未提供有效缓存订单对象，查询API获取订单 ${orderId}`);
      await rateLimiter.throttle();
      const allOrders = await ctx.todayOrders();
      const foundOrder = allOrders.find((o) => o.orderId === orderId);
      if (foundOrder) {
        originalOrder = toOrderForReplace(foundOrder);
      }
    }

    if (!originalOrder) {
      const error = new Error(`未找到订单ID=${orderId}`);
      logger.error(`[订单修改失败] ${error.message}`);
      throw error;
    }

    // 检查订单状态是否允许修改
    if (
      originalOrder.status === OrderStatus.Filled ||
      originalOrder.status === OrderStatus.Canceled ||
      originalOrder.status === OrderStatus.Rejected
    ) {
      const error = new Error(
        `订单ID=${orderId} 状态为 ${originalOrder.status}，不允许修改`,
      );
      logger.error(`[订单修改失败] ${error.message}`);
      throw error;
    }

    // 计算剩余数量（原订单数量 - 已成交数量）
    const executedQty = decimalToNumber(originalOrder.executedQuantity ?? 0);
    const originalQty = decimalToNumber(originalOrder.quantity ?? 0);
    const remainingQty = originalQty - executedQty;

    // 构建修改订单的payload
    let targetQuantity = remainingQty;

    // 如果提供了数量参数，使用提供的数量（但不能超过剩余数量）
    if (quantity !== null && isValidPositiveNumber(quantity)) {
      targetQuantity = Math.min(quantity, remainingQty);
    }

    // 验证数量有效性
    if (!Number.isFinite(targetQuantity) || targetQuantity <= 0) {
      const error = new Error(
        `订单ID=${orderId} 剩余数量无效（剩余=${remainingQty}，原数量=${originalQty}，已成交=${executedQty}）`,
      );
      logger.error(`[订单修改失败] ${error.message}`);
      throw error;
    }

    const replacePayload = {
      orderId: orderId,
      price: toDecimal(newPrice),
      quantity: toDecimal(targetQuantity),
    };

    try {
      await rateLimiter.throttle();
      await ctx.replaceOrder(replacePayload);

      cacheManager.clearCache();

      logger.info(
        `[订单修改成功] 订单ID=${orderId} 新价格=${newPrice.toFixed(3)}`,
      );
    } catch (err) {
      const errorMessage = (err as Error)?.message ?? String(err);
      const error = new Error(`订单修改失败: ${errorMessage}`);
      logger.error(
        `[订单修改失败] 订单ID=${orderId} 新价格=${newPrice.toFixed(3)}`,
        errorMessage,
      );
      throw error;
    }
  };

  /**
   * 实时监控价格并管理未成交的买入订单
   * 规则：
   * - 仅在发起买入交易后才开始监控
   * - 买入后等待30秒再进行首次检查
   * - 只监控买入订单，卖出订单不监控
   * - 买入订单：如果当前价格低于委托价格，修改委托价格为当前价格
   * - 当所有买入订单成交后停止监控
   * @param quotesMap 行情数据 Map（symbol -> Quote）
   */
  const monitorAndManageOrders = async (
    quotesMap: ReadonlyMap<string, Quote | null>,
  ): Promise<void> => {
    // 如果没有需要监控的标的，直接返回
    if (monitoringSymbols.size === 0) {
      return;
    }

    if (quotesMap.size === 0) {
      return;
    }

    // 筛选出需要监控且已过首次检查延迟时间的标的
    const now = Date.now();
    const activeSymbols: string[] = [];
    for (const symbol of monitoringSymbols) {
      const enabledTime = monitoringEnabledTimeMap.get(symbol);
      if (enabledTime !== undefined) {
        const elapsed = now - enabledTime;
        if (elapsed >= INITIAL_CHECK_DELAY_MS) {
          activeSymbols.push(symbol);
        }
      }
    }

    // 如果没有已激活的监控标的（都还在等待延迟），直接返回
    if (activeSymbols.length === 0) {
      return;
    }

    // 从行情数据中获取需要监控的标的的行情
    const normalizedQuotesMap = new Map<string, Quote | null>();
    for (const [symbol, quote] of quotesMap.entries()) {
      const normalizedSymbol = normalizeHKSymbol(symbol);
      // 只保留需要监控的标的的行情
      if (quote && activeSymbols.includes(normalizedSymbol)) {
        normalizedQuotesMap.set(normalizedSymbol, quote);
      }
    }

    // 如果没有需要监控的标的的行情数据，直接返回
    if (normalizedQuotesMap.size === 0) {
      return;
    }

    const targetSymbols = Array.from(normalizedQuotesMap.keys());

    // 仅获取需要监控的标的的未成交订单（而非所有标的）
    const pendingOrders = await cacheManager.getPendingOrders(targetSymbols);

    // 过滤出买入订单
    const pendingBuyOrders = pendingOrders.filter(
      (order) => order.side === OrderSide.Buy,
    );

    // 找出哪些标的有未成交买入订单
    const symbolsWithPendingBuyOrders = new Set<string>();
    for (const order of pendingBuyOrders) {
      symbolsWithPendingBuyOrders.add(normalizeHKSymbol(order.symbol));
    }

    // 清除已经没有未成交买入订单的标的（精确清除，而非全部清除）
    const symbolsToRemove: string[] = [];
    for (const symbol of targetSymbols) {
      if (!symbolsWithPendingBuyOrders.has(symbol)) {
        symbolsToRemove.push(symbol);
        monitoringSymbols.delete(symbol);
        monitoringEnabledTimeMap.delete(symbol);
      }
    }
    if (symbolsToRemove.length > 0) {
      logger.info(`[订单监控] 标的 ${symbolsToRemove.join(', ')} 的买入订单已全部成交，停止监控`);
    }

    // 如果没有买入订单需要监控，直接返回
    if (pendingBuyOrders.length === 0) {
      return;
    }

    logger.debug(
      `[订单监控] 发现标的 ${Array.from(symbolsWithPendingBuyOrders).join(', ')} 的 ${pendingBuyOrders.length} 个未成交买入订单，开始检查价格...`,
    );

    for (const order of pendingBuyOrders) {
      // 检查订单状态，如果已撤销、已成交或已完成，跳过监控
      if (
        order.status === OrderStatus.Filled ||
        order.status === OrderStatus.Rejected
      ) {
        logger.debug(
          `[订单监控] 买入订单 ${order.orderId} 状态为 ${order.status}，跳过监控`,
        );
        continue;
      }

      // 如果订单正在被修改（Replaced状态），跳过本次监控，等待下次
      if (
        order.status === OrderStatus.Replaced ||
        order.status === OrderStatus.PendingReplace ||
        order.status === OrderStatus.WaitToReplace
      ) {
        logger.debug(
          `[订单监控] 买入订单 ${order.orderId} 正在修改中（状态：${order.status}），跳过本次监控`,
        );
        continue;
      }

      const normalizedOrderSymbol = normalizeHKSymbol(order.symbol);

      // 从行情数据 Map 中获取标的的当前价格
      const quote = normalizedQuotesMap.get(normalizedOrderSymbol);
      const currentPrice = quote?.price ?? null;

      if (!currentPrice || !Number.isFinite(currentPrice)) {
        logger.debug(
          `[订单监控] 无法获取标的 ${order.symbol} 的当前价格，跳过处理订单 ${order.orderId}`,
        );
        continue;
      }

      const orderPrice = order.submittedPrice;

      // 买入订单：如果当前价格低于委托价格，修改委托价格为当前价格
      if (currentPrice < orderPrice) {
        const priceDiffAbs = Math.abs(currentPrice - orderPrice);
        // 价格差异达到阈值或以上时进行修改
        if (priceDiffAbs >= TRADING.PRICE_DIFF_THRESHOLD) {
          logger.info(
            `[订单监控] 买入订单 ${
              order.orderId
            } 当前价格(${currentPrice.toFixed(
              3,
            )}) 低于委托价格(${orderPrice.toFixed(
              3,
            )}) 差异=${priceDiffAbs.toFixed(3)}，修改委托价格为当前价格`,
          );
          try {
            await replaceOrderPrice(
              order.orderId,
              currentPrice,
              null,
              order,
            );
            logger.info(
              `[订单监控] 买入订单 ${
                order.orderId
              } 价格修改成功：${orderPrice.toFixed(
                3,
              )} -> ${currentPrice.toFixed(3)} (降低${priceDiffAbs.toFixed(3)})`,
            );
          } catch (err) {
            logger.error(
              `[订单监控] 买入订单 ${order.orderId} 价格修改失败: ${
                (err as Error)?.message ?? String(err)
              }`,
            );
          }
        } else {
          logger.debug(
            `[订单监控] 买入订单 ${
              order.orderId
            } 价格差异(${priceDiffAbs.toFixed(4)})小于${TRADING.PRICE_DIFF_THRESHOLD}，暂不修改`,
          );
        }
      }
    }
  };

  return {
    enableMonitoring,
    cancelOrder,
    replaceOrderPrice,
    monitorAndManageOrders,
  };
};
