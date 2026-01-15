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
 * - OrderRecorder: 订单记录（先于 OrderMonitor 创建）
 * - OrderMonitor: 未成交订单监控（依赖 OrderRecorder）
 * - OrderExecutor: 订单执行核心
 *
 * 模块初始化顺序（解决依赖问题）：
 * 1. ctxPromise - 最基础的依赖
 * 2. rateLimiter, cacheManager, accountService - 无其他模块依赖
 * 3. orderRecorder - 依赖 ctxPromise 和 rateLimiter（控制 Trade API 调用频率）
 * 4. orderMonitor - 依赖 orderRecorder
 * 5. orderExecutor - 依赖 orderMonitor
 */

import { TradeContext, OrderSide } from 'longport';
import { createConfig } from '../../config/config.index.js';
import { createOrderRecorder } from '../orderRecorder/index.js';
import type { Signal, Quote, AccountSnapshot, Position, OrderRecorder, PendingOrder, Trader, TradeCheckResult } from '../../types/index.js';
import type { TraderDeps, PendingRefreshSymbol } from './types.js';

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

  // ========== 1. 创建基础依赖 ==========
  const ctxPromise = TradeContext.new(finalConfig);

  // ========== 2. 创建无依赖的基础模块 ==========
  const rateLimiter = createRateLimiter({ config: { maxCalls: 30, windowMs: 30000 } });

  const cacheManager = createOrderCacheManager({ ctxPromise, rateLimiter });

  const accountService = createAccountService({ ctxPromise, rateLimiter });

  // ========== 3. 创建 orderRecorder（依赖 ctxPromise 和 rateLimiter） ==========
  const orderRecorder = createOrderRecorder({ ctxPromise, rateLimiter });

  // ========== 4. 创建 orderMonitor（依赖 orderRecorder） ==========
  const orderMonitor = createOrderMonitor({
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderRecorder,
  });

  // ========== 5. 创建 orderExecutor ==========
  const orderExecutor = createOrderExecutor({
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderMonitor,
  });

  // ========== 6. 初始化 WebSocket 订阅 ==========
  await orderMonitor.initialize();

  // ========== 7. 恢复未完成订单的追踪 ==========
  await orderMonitor.recoverTrackedOrders();

  // 创建 Trader 实例
  return {
    _ctxPromise: ctxPromise,
    _orderRecorder: orderRecorder,

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
      recorder: OrderRecorder | null = null,
    ): Promise<boolean> {
      return cacheManager.hasPendingBuyOrders(symbols, recorder);
    },

    // ==================== 订单监控相关方法 ====================

    trackOrder(
      orderId: string,
      symbol: string,
      side: typeof OrderSide[keyof typeof OrderSide],
      price: number,
      quantity: number,
      isLongSymbol: boolean,
    ): void {
      orderMonitor.trackOrder(orderId, symbol, side, price, quantity, isLongSymbol);
    },

    cancelOrder(orderId: string): Promise<boolean> {
      return orderMonitor.cancelOrder(orderId);
    },

    replaceOrderPrice(
      orderId: string,
      newPrice: number,
      quantity: number | null = null,
    ): Promise<void> {
      return orderMonitor.replaceOrderPrice(orderId, newPrice, quantity);
    },

    monitorAndManageOrders(
      quotesMap: ReadonlyMap<string, Quote | null>,
    ): Promise<void> {
      return orderMonitor.processWithLatestQuotes(quotesMap);
    },

    getAndClearPendingRefreshSymbols(): PendingRefreshSymbol[] {
      return orderMonitor.getAndClearPendingRefreshSymbols();
    },

    // ==================== 订单执行相关方法 ====================

    _canTradeNow(signalAction: string, monitorConfig?: import('../../types/index.js').MonitorConfig | null): TradeCheckResult {
      return orderExecutor.canTradeNow(signalAction, monitorConfig);
    },

    _markBuyAttempt(signalAction: string, monitorConfig?: import('../../types/index.js').MonitorConfig | null): void {
      orderExecutor.markBuyAttempt(signalAction, monitorConfig);
    },

    executeSignals(signals: Signal[]): Promise<void> {
      return orderExecutor.executeSignals(signals);
    },
  };
};
