/**
 * 订单执行模块（门面模式）
 *
 * 功能：
 * - 协调各个子模块完成交易功能
 * - 提供统一的对外接口
 * - 保持与原有代码的兼容性
 *
 * 架构：
 * - RateLimiter: API频率限制
 * - AccountService: 账户查询
 * - OrderCacheManager: 订单缓存管理
 * - OrderMonitor: 未成交订单监控
 * - OrderExecutor: 订单执行核心
 */

import { TradeContext } from 'longport';
import { createConfig } from '../../config/config.index.js';
import type { Signal, Quote, AccountSnapshot, Position, OrderRecorder, PendingOrder, Trader, TradeCheckResult } from '../../types/index.js';
import type { TraderDeps } from './type.js';

// 导入子模块工厂函数
import { createRateLimiter } from './rateLimiter.js';
import { createAccountService } from './accountService.js';
import { createOrderCacheManager } from './orderCacheManager.js';
import { createOrderMonitor } from './orderMonitor.js';
import { createOrderExecutor } from './orderExecutor.js';

/**
 * 创建交易执行模块（门面模式）
 * @param deps 依赖配置
 * @returns Promise<Trader> 接口实例
 */
export const createTrader = async (deps: TraderDeps = {}): Promise<Trader> => {
  const finalConfig = deps.config ?? createConfig();

  // 初始化 TradeContext
  const ctxPromise = TradeContext.new(finalConfig);

  // 初始化子模块（按依赖顺序创建）
  const rateLimiter = createRateLimiter({ config: { maxCalls: 30, windowMs: 30000 } });

  const accountService = createAccountService({ ctxPromise, rateLimiter });

  const cacheManager = createOrderCacheManager({ ctxPromise, rateLimiter });

  const orderMonitor = createOrderMonitor({ ctxPromise, rateLimiter, cacheManager });

  const orderExecutor = createOrderExecutor({
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderMonitor,
  });

  // 创建 Trader 实例
  return {
    _ctxPromise: ctxPromise,

    // ==================== 账户相关方法 ====================

    getAccountSnapshot(): Promise<AccountSnapshot | null> {
      return accountService.getAccountSnapshot();
    },

    getStockPositions(symbols: string[] | null = null): Promise<Position[]> {
      return accountService.getStockPositions(symbols);
    },

    // ==================== 订单缓存相关方法 ====================

    getPendingOrders(
      symbols: string[] | null = null,
      forceRefresh: boolean = false,
    ): Promise<PendingOrder[]> {
      return cacheManager.getPendingOrders(symbols, forceRefresh);
    },

    clearPendingOrdersCache(): void {
      cacheManager.clearCache();
    },

    hasPendingBuyOrders(
      symbols: string[],
      orderRecorder: OrderRecorder | null = null,
    ): Promise<boolean> {
      return cacheManager.hasPendingBuyOrders(symbols, orderRecorder);
    },

    // ==================== 订单监控相关方法 ====================

    enableBuyOrderMonitoring(): void {
      orderMonitor.enableMonitoring();
    },

    cancelOrder(orderId: string): Promise<boolean> {
      return orderMonitor.cancelOrder(orderId);
    },

    replaceOrderPrice(
      orderId: string,
      newPrice: number,
      quantity: number | null = null,
      cachedOrder: PendingOrder | null = null,
    ): Promise<void> {
      return orderMonitor.replaceOrderPrice(orderId, newPrice, quantity, cachedOrder);
    },

    monitorAndManageOrders(
      longQuote: Quote | null,
      shortQuote: Quote | null,
    ): Promise<void> {
      return orderMonitor.monitorAndManageOrders(longQuote, shortQuote);
    },

    // ==================== 订单执行相关方法 ====================

    _canTradeNow(signalAction: string): TradeCheckResult {
      return orderExecutor.canTradeNow(signalAction);
    },

    executeSignals(signals: Signal[]): Promise<void> {
      return orderExecutor.executeSignals(signals);
    },
  };
};
