/**
 * 订单缓存管理模块
 *
 * 功能：
 * - 管理未成交订单的缓存
 * - 提供缓存刷新和清除功能
 * - 检查是否有买入的未成交订单
 */

import { OrderStatus, OrderSide } from 'longport';
import { logger } from '../../utils/logger/index.js';
import { normalizeHKSymbol, decimalToNumber } from '../../utils/helpers/index.js';
import type { PendingOrder, DecimalLikeValue, OrderRecorder } from '../../types/index.js';
import type { OrderCacheManager, OrderCacheManagerDeps } from './types.js';

const PENDING_ORDERS_CACHE_TTL = 30000; // 30秒缓存

/**
 * 创建订单缓存管理器
 * @param deps 依赖注入
 * @returns OrderCacheManager 接口实例
 */
export const createOrderCacheManager = (deps: OrderCacheManagerDeps): OrderCacheManager => {
  const { ctxPromise, rateLimiter } = deps;

  // 闭包捕获的私有状态
  let pendingOrdersCache: PendingOrder[] | null = null;
  let pendingOrdersCacheSymbols: string | null = null;
  let pendingOrdersCacheTime: number = 0;

  /**
   * 获取今日未成交订单（带缓存机制）
   * @param symbols 标的代码数组，如果为null或空数组则获取所有标的的订单
   * @param forceRefresh 是否强制刷新缓存（默认false）
   * @returns 未成交订单列表
   */
  const getPendingOrders = async (
    symbols: string[] | null = null,
    forceRefresh: boolean = false,
  ): Promise<PendingOrder[]> => {
    // 将 symbols 数组规范化并排序，用于比较缓存是否对应同一组 symbols
    const symbolsKey =
      symbols && symbols.length > 0
        ? symbols
          .map((s) => normalizeHKSymbol(s))
          .sort((a, b) => a.localeCompare(b))
          .join(',')
        : 'ALL'; // null 或空数组统一标记为 "ALL"

    const now = Date.now();
    const isCacheValid =
      pendingOrdersCache !== null &&
      pendingOrdersCacheSymbols === symbolsKey &&
      now - pendingOrdersCacheTime < PENDING_ORDERS_CACHE_TTL;

    // 如果缓存有效且不强制刷新，直接返回缓存
    if (isCacheValid && !forceRefresh) {
      logger.debug(
        `[订单缓存] 使用缓存的未成交订单数据 (symbols=${symbolsKey}, 缓存时间: ${
          now - pendingOrdersCacheTime
        }ms)`,
      );
      return pendingOrdersCache!;
    }

    const ctx = await ctxPromise;
    try {
      // 过滤出未成交订单（New, PartialFilled, WaitToNew等状态）
      const pendingStatuses = new Set([
        OrderStatus.New,
        OrderStatus.PartialFilled,
        OrderStatus.WaitToNew,
        OrderStatus.WaitToReplace,
        OrderStatus.PendingReplace,
      ]);

      let allOrders: Array<{
        orderId: string;
        symbol: string;
        side: typeof OrderSide[keyof typeof OrderSide];
        price: unknown;
        quantity: unknown;
        executedQuantity: unknown;
        status: typeof OrderStatus[keyof typeof OrderStatus];
        orderType: unknown;
      }> = [];

      if (!symbols || symbols.length === 0) {
        // 如果没有指定标的，获取所有订单
        await rateLimiter.throttle();
        allOrders = (await ctx.todayOrders()) as typeof allOrders;
      } else {
        // 如果指定了标的，串行查询每个标的（避免并发导致 API 限流）
        // 注意：必须串行调用，因为 Promise.all 会导致多个请求同时发出超过 API 限制
        const normalizedSymbols = symbols.map((s) => normalizeHKSymbol(s));
        for (const symbol of normalizedSymbols) {
          try {
            await rateLimiter.throttle();
            const orders = await ctx.todayOrders({ symbol });
            allOrders.push(...(orders as typeof allOrders));
          } catch (err) {
            logger.warn(
              `[今日订单API] 获取标的 ${symbol} 的今日订单失败`,
              (err as Error)?.message ?? String(err),
            );
            // 单个标的查询失败时继续处理下一个标的
          }
        }
      }

      // 如果指定了标的，还需要在客户端再次过滤（因为可能获取了所有订单）
      const normalizedTargetSymbols =
        symbols && symbols.length > 0
          ? new Set(symbols.map((s) => normalizeHKSymbol(s)))
          : null;

      const result: PendingOrder[] = allOrders
        .filter((order) => {
          // 先过滤状态
          if (!pendingStatuses.has(order.status)) {
            return false;
          }
          // 如果指定了标的，再过滤标的
          if (normalizedTargetSymbols) {
            const normalizedOrderSymbol = normalizeHKSymbol(order.symbol);
            return normalizedTargetSymbols.has(normalizedOrderSymbol);
          }
          return true;
        })
        .map((order) => ({
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          submittedPrice: decimalToNumber(order.price as DecimalLikeValue),
          quantity: decimalToNumber(order.quantity as DecimalLikeValue),
          executedQuantity: decimalToNumber(order.executedQuantity as DecimalLikeValue),
          status: order.status,
          orderType: order.orderType,
          _rawOrder: order,
        }));

      pendingOrdersCache = result;
      pendingOrdersCacheSymbols = symbolsKey;
      pendingOrdersCacheTime = Date.now();

      logger.debug(
        `[订单缓存] 已刷新未成交订单缓存 (symbols=${symbolsKey})，共 ${result.length} 个订单`,
      );

      return result;
    } catch (err) {
      logger.error(
        '获取未成交订单失败',
        (err as Error)?.message ?? String(err),
      );
      return [];
    }
  };

  /**
   * 清除订单缓存（在订单状态可能变化时调用）
   */
  const clearCache = (): void => {
    pendingOrdersCache = null;
    pendingOrdersCacheSymbols = null;
    pendingOrdersCacheTime = 0;
    logger.debug('[订单缓存] 已清除缓存');
  };

  /**
   * 检查是否有买入的未成交订单
   * @param symbols 标的代码数组
   * @param orderRecorder OrderRecorder 实例（可选，用于启动时从缓存获取）
   * @returns true表示有买入的未成交订单
   */
  const hasPendingBuyOrders = async (
    symbols: string[],
    orderRecorder: OrderRecorder | null = null,
  ): Promise<boolean> => {
    try {
      // 如果提供了 orderRecorder，强制从缓存获取（启动时使用，避免重复调用 todayOrders）
      if (orderRecorder) {
        try {
          // 先检查缓存是否存在
          if (orderRecorder.hasCacheForSymbols(symbols)) {
            // 如果所有标的都有缓存，从缓存获取未成交订单（即使没有未成交订单也使用缓存结果）
            const pendingOrders =
              orderRecorder.getPendingOrdersFromCache(symbols);
            return pendingOrders.some((order) => order.side === OrderSide.Buy);
          }
          // 如果缓存不存在或不完整，说明 refreshOrders 还未执行或失败，返回 false（不调用 API）
          return false;
        } catch {
          // 缓存读取失败，返回 false（不调用 API）
          return false;
        }
      }
      // 从 API 获取（运行时使用，没有提供 orderRecorder 时使用）
      const pendingOrders = await getPendingOrders(symbols);
      return pendingOrders.some((order) => order.side === OrderSide.Buy);
    } catch (err) {
      logger.warn(
        '检查买入订单失败',
        (err as Error)?.message ?? String(err),
      );
      return false;
    }
  };

  return {
    getPendingOrders,
    clearCache,
    hasPendingBuyOrders,
  };
};
