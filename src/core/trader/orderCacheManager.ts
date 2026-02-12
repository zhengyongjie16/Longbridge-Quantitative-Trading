/**
 * 订单缓存管理模块
 *
 * 职责：
 * - 缓存未成交订单列表（30秒 TTL）
 * - 提供按标的查询和强制刷新功能
 *
 * 缓存策略：
 * - 按 symbols 组合作为缓存键
 * - 订单状态变化后自动失效
 */
import { OrderStatus, OrderSide } from 'longport';
import { logger } from '../../utils/logger/index.js';
import { decimalToNumber, formatError } from '../../utils/helpers/index.js';
import { PENDING_ORDER_STATUSES, API } from '../../constants/index.js';
import type { PendingOrder } from '../../types/services.js';
import type { DecimalLikeValue } from '../../types/common.js';
import type { OrderCacheManager, OrderCacheManagerDeps } from './types.js';

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
   * 获取今日未成交订单
   * 优先使用缓存，超过 TTL 或 forceRefresh 时调用 API 刷新
   */
  const getPendingOrders = async (
    symbols: string[] | null = null,
    forceRefresh: boolean = false,
  ): Promise<PendingOrder[]> => {
    // 将 symbols 数组排序，用于比较缓存是否对应同一组 symbols
    const symbolsKey =
      symbols && symbols.length > 0
        ? symbols
          .slice()
          .sort((a, b) => a.localeCompare(b))
          .join(',')
        : 'ALL'; // null 或空数组统一标记为 "ALL"

    const now = Date.now();
    const isCacheValid =
      pendingOrdersCache !== null &&
      pendingOrdersCacheSymbols === symbolsKey &&
      now - pendingOrdersCacheTime < API.PENDING_ORDERS_CACHE_TTL_MS;

    // 如果缓存有效且不强制刷新，直接返回缓存
    // 注意：虽然 isCacheValid 已经检查了 pendingOrdersCache !== null，
    // 但 TypeScript 无法推断变量中的条件关系，需要显式检查来缩窄类型
    if (isCacheValid && !forceRefresh && pendingOrdersCache !== null) {
      logger.debug(
        `[订单缓存] 使用缓存的未成交订单数据 (symbols=${symbolsKey}, 缓存时间: ${
          now - pendingOrdersCacheTime
        }ms)`,
      );
      return pendingOrdersCache;
    }

    const ctx = await ctxPromise;
    try {
      // 使用模块级常量 PENDING_ORDER_STATUSES 过滤未成交订单，避免每次调用创建新 Set
      let allOrders: Array<{
        orderId: string;
        symbol: string;
        side: OrderSide;
        price: unknown;
        quantity: unknown;
        executedQuantity: unknown;
        status: OrderStatus;
        orderType: PendingOrder['orderType'];
      }> = [];

      function isValidTodayOrder(
        order: unknown,
      ): order is (typeof allOrders)[number] {
        if (typeof order !== 'object' || order === null) {
          return false;
        }
        const obj = order as Record<string, unknown>;
        return (
          typeof obj['orderId'] === 'string' &&
          typeof obj['symbol'] === 'string' &&
          typeof obj['side'] === 'string' &&
          typeof obj['status'] === 'string'
        );
      }

      // 始终一次性获取所有今日订单，然后在客户端按标的过滤
      // 这样无论查询多少个标的，都只需要 1 次 API 调用
      // 避免了之前为每个标的单独调用导致的 API 限流问题
      await rateLimiter.throttle();
      const todayOrdersRaw = await ctx.todayOrders();
      if (!Array.isArray(todayOrdersRaw)) {
        logger.error(
          '[订单缓存] todayOrders 返回结果不是数组，无法解析未成交订单',
        );
        return [];
      }
      // 信任边界：仅保留结构符合预期的订单
      allOrders = todayOrdersRaw.filter(isValidTodayOrder);

      // 如果指定了标的，还需要在客户端再次过滤（因为可能获取了所有订单）
      const targetSymbols =
        symbols && symbols.length > 0
          ? new Set(symbols)
          : null;

      const result: PendingOrder[] = [];
      for (const order of allOrders) {
        // 先过滤状态
        if (!PENDING_ORDER_STATUSES.has(order.status)) {
          continue;
        }
        // 如果指定了标的，再过滤标的
        if (targetSymbols && !targetSymbols.has(order.symbol)) {
          continue;
        }
        result.push({
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          submittedPrice: decimalToNumber(order.price as DecimalLikeValue),
          quantity: decimalToNumber(order.quantity as DecimalLikeValue),
          executedQuantity: decimalToNumber(order.executedQuantity as DecimalLikeValue),
          status: order.status,
          orderType: order.orderType,
          _rawOrder: order,
        });
      }

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
        formatError(err),
      );
      return [];
    }
  };

  /** 清除缓存（订单提交/撤销/修改后调用） */
  const clearCache = (): void => {
    pendingOrdersCache = null;
    pendingOrdersCacheSymbols = null;
    pendingOrdersCacheTime = 0;
    logger.debug('[订单缓存] 已清除缓存');
  };

  return {
    getPendingOrders,
    clearCache,
  };
};
