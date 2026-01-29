/**
 * 交易执行模块入口（门面模式）
 *
 * 职责：
 * - 协调各子模块（账户、缓存、监控、执行）完成交易功能
 * - 提供统一的 Trader 接口供外部调用
 *
 * 子模块：
 * - rateLimiter: API 频率限制（30次/30秒）
 * - accountService: 账户余额和持仓查询
 * - orderCacheManager: 未成交订单缓存
 * - orderRecorder: 订单记录持久化
 * - orderMonitor: WebSocket 订单状态监控
 * - orderExecutor: 信号执行和订单提交
 *
 * 初始化顺序：
 * 1. ctxPromise → 2. rateLimiter/cacheManager/accountService
 * 3. orderRecorder → 4. orderMonitor → 5. orderExecutor
 */

import { TradeContext, OrderSide } from 'longport';
import { createOrderRecorder } from '../orderRecorder/index.js';
import type { Signal, Quote, AccountSnapshot, Position, OrderRecorder, PendingOrder, Trader, TradeCheckResult, PendingRefreshSymbol } from '../../types/index.js';
import type { TraderDeps } from './types.js';

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
export async function createTrader(deps: TraderDeps): Promise<Trader> {
  const { config, tradingConfig, liquidationCooldownTracker, symbolRegistry } = deps;

  // ========== 1. 创建基础依赖 ==========
  const ctxPromise = TradeContext.new(config);

  // ========== 2. 创建无依赖的基础模块 ==========
  const rateLimiterConfig = deps.rateLimiterConfig ?? { maxCalls: 30, windowMs: 30000 };
  const rateLimiter = createRateLimiter({ config: rateLimiterConfig });

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
    liquidationCooldownTracker,
    tradingConfig,
    symbolRegistry,
  });

  // ========== 5. 创建 orderExecutor ==========
  const orderExecutor = createOrderExecutor({
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderMonitor,
    tradingConfig,
    symbolRegistry,
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
      monitorSymbol: string | null,
      isProtectiveLiquidation: boolean,
    ): void {
      orderMonitor.trackOrder(
        orderId,
        symbol,
        side,
        price,
        quantity,
        isLongSymbol,
        monitorSymbol,
        isProtectiveLiquidation,
      );
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
}
