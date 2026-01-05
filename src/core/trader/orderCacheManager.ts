/**
 * 订单缓存管理模块
 *
 * 功能：
 * - 管理未成交订单的缓存
 * - 提供缓存刷新和清除功能
 * - 检查是否有买入的未成交订单
 */

import { OrderStatus, OrderSide, type TradeContext } from 'longport';
import { logger } from '../../utils/logger.js';
import { normalizeHKSymbol, decimalToNumber } from '../../utils/helpers.js';
import type { PendingOrder } from '../type.js';
import type { DecimalLikeValue } from '../../types/index.js';
import type { RateLimiter } from './rateLimiter.js';
import type { OrderRecorder } from '../orderRecorder/index.js';

export class OrderCacheManager {
  private _pendingOrdersCache: PendingOrder[] | null = null;
  private _pendingOrdersCacheSymbols: string | null = null;
  private _pendingOrdersCacheTime: number = 0;
  private readonly _pendingOrdersCacheTTL: number = 15000; // 15秒缓存

  constructor(
    private readonly ctxPromise: Promise<TradeContext>,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /**
   * 获取今日未成交订单（带缓存机制）
   * @param symbols 标的代码数组，如果为null或空数组则获取所有标的的订单
   * @param forceRefresh 是否强制刷新缓存（默认false）
   * @returns 未成交订单列表
   */
  async getPendingOrders(
    symbols: string[] | null = null,
    forceRefresh: boolean = false,
  ): Promise<PendingOrder[]> {
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
      this._pendingOrdersCache !== null &&
      this._pendingOrdersCacheSymbols === symbolsKey &&
      now - this._pendingOrdersCacheTime < this._pendingOrdersCacheTTL;

    // 如果缓存有效且不强制刷新，直接返回缓存
    if (isCacheValid && !forceRefresh) {
      logger.debug(
        `[订单缓存] 使用缓存的未成交订单数据 (symbols=${symbolsKey}, 缓存时间: ${
          now - this._pendingOrdersCacheTime
        }ms)`,
      );
      return this._pendingOrdersCache!;
    }

    const ctx = await this.ctxPromise;
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
        await this.rateLimiter.throttle();
        allOrders = (await ctx.todayOrders()) as typeof allOrders;
      } else {
        // 如果指定了标的，分别查询每个标的（因为 symbol 参数只接受单个字符串）
        const normalizedSymbols = symbols.map((s) => normalizeHKSymbol(s));
        const orderPromises = normalizedSymbols.map(async (symbol) => {
          try {
            await this.rateLimiter.throttle();
            return await ctx.todayOrders({ symbol });
          } catch (err) {
            logger.warn(
              `[今日订单API] 获取标的 ${symbol} 的今日订单失败`,
              (err as Error)?.message ?? String(err),
            );
            return []; // 单个标的查询失败时返回空数组，不影响其他标的
          }
        });
        const orderArrays = await Promise.all(orderPromises);
        allOrders = orderArrays.flat() as typeof allOrders;
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

      this._pendingOrdersCache = result;
      this._pendingOrdersCacheSymbols = symbolsKey;
      this._pendingOrdersCacheTime = Date.now();

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
  }

  /**
   * 清除订单缓存（在订单状态可能变化时调用）
   */
  clearCache(): void {
    this._pendingOrdersCache = null;
    this._pendingOrdersCacheSymbols = null;
    this._pendingOrdersCacheTime = 0;
    logger.debug('[订单缓存] 已清除缓存');
  }

  /**
   * 检查是否有买入的未成交订单
   * @param symbols 标的代码数组
   * @param orderRecorder OrderRecorder 实例（可选，用于启动时从缓存获取）
   * @returns true表示有买入的未成交订单
   */
  async hasPendingBuyOrders(
    symbols: string[],
    orderRecorder: OrderRecorder | null = null,
  ): Promise<boolean> {
    try {
      // 如果提供了 orderRecorder，尝试从缓存获取（启动时使用，避免重复调用 todayOrders）
      if (orderRecorder) {
        try {
          const pendingOrders =
            orderRecorder.getPendingOrdersFromCache(symbols);
          // 如果从缓存中获取到了订单数据，直接使用
          if (pendingOrders.length > 0 || symbols.length === 0) {
            return pendingOrders.some((order) => order.side === OrderSide.Buy);
          }
          // 如果缓存为空，说明可能没有缓存数据，继续从 API 获取
        } catch (error_) {
          // 缓存读取失败，继续从 API 获取
          logger.debug(
            '从 orderRecorder 缓存读取失败，将从 API 获取',
            (error_ as Error)?.message ?? String(error_),
          );
        }
      }
      // 从 API 获取（运行时使用）
      const pendingOrders = await this.getPendingOrders(symbols);
      return pendingOrders.some((order) => order.side === OrderSide.Buy);
    } catch (err) {
      logger.warn(
        '检查买入订单失败',
        (err as Error)?.message ?? String(err),
      );
      return false;
    }
  }
}
