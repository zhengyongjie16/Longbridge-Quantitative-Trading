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
import type { Config } from 'longport';
import { createConfig } from '../../config/config.index.js';
import type { Signal, Quote, AccountSnapshot, Position } from '../../types/index.js';
import type { OrderRecorder } from '../orderRecorder/index.js';
import type { PendingOrder } from '../type.js';
import type { TradeCheckResult } from './type.js';

// 导入子模块
import { RateLimiter } from './rateLimiter.js';
import { AccountService } from './accountService.js';
import { OrderCacheManager } from './orderCacheManager.js';
import { OrderMonitor } from './orderMonitor.js';
import { OrderExecutor } from './orderExecutor.js';

/**
 * 交易执行模块（门面类）
 */
export class Trader {
  _ctxPromise!: Promise<TradeContext>;

  // 子模块
  private readonly accountService: AccountService;
  private readonly cacheManager: OrderCacheManager;
  private readonly orderMonitor: OrderMonitor;
  private readonly orderExecutor: OrderExecutor;

  private constructor(
    ctxPromise: Promise<TradeContext>,
    accountService: AccountService,
    cacheManager: OrderCacheManager,
    orderMonitor: OrderMonitor,
    orderExecutor: OrderExecutor,
  ) {
    this._ctxPromise = ctxPromise;
    this.accountService = accountService;
    this.cacheManager = cacheManager;
    this.orderMonitor = orderMonitor;
    this.orderExecutor = orderExecutor;
  }

  /**
   * 创建 Trader 实例（静态工厂方法）
   * @param config 配置对象，如果为 null 则使用默认配置
   * @returns Trader 实例
   */
  static async create(config: Config | null = null): Promise<Trader> {
    const finalConfig = config ?? createConfig();

    // 初始化 TradeContext
    const ctxPromise = TradeContext.new(finalConfig);

    // 初始化子模块（按依赖顺序创建）
    const rateLimiter = new RateLimiter(30, 30000);

    const accountService = new AccountService(ctxPromise, rateLimiter);

    const cacheManager = new OrderCacheManager(ctxPromise, rateLimiter);

    const orderMonitor = new OrderMonitor(ctxPromise, rateLimiter, cacheManager);

    const orderExecutor = new OrderExecutor(
      ctxPromise,
      rateLimiter,
      cacheManager,
      orderMonitor,
    );

    // 创建 Trader 实例
    return new Trader(
      ctxPromise,
      accountService,
      cacheManager,
      orderMonitor,
      orderExecutor,
    );
  }

  // ==================== 账户相关方法 ====================

  async getAccountSnapshot(): Promise<AccountSnapshot | null> {
    return this.accountService.getAccountSnapshot();
  }

  async getStockPositions(symbols: string[] | null = null): Promise<Position[]> {
    return this.accountService.getStockPositions(symbols);
  }

  // ==================== 订单缓存相关方法 ====================

  async getPendingOrders(
    symbols: string[] | null = null,
    forceRefresh: boolean = false,
  ): Promise<PendingOrder[]> {
    return this.cacheManager.getPendingOrders(symbols, forceRefresh);
  }

  clearPendingOrdersCache(): void {
    this.cacheManager.clearCache();
  }

  async hasPendingBuyOrders(
    symbols: string[],
    orderRecorder: OrderRecorder | null = null,
  ): Promise<boolean> {
    return this.cacheManager.hasPendingBuyOrders(symbols, orderRecorder);
  }

  // ==================== 订单监控相关方法 ====================

  enableBuyOrderMonitoring(): void {
    this.orderMonitor.enableMonitoring();
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return this.orderMonitor.cancelOrder(orderId);
  }

  async replaceOrderPrice(
    orderId: string,
    newPrice: number,
    quantity: number | null = null,
    cachedOrder: PendingOrder | null = null,
  ): Promise<void> {
    return this.orderMonitor.replaceOrderPrice(orderId, newPrice, quantity, cachedOrder);
  }

  async monitorAndManageOrders(
    longQuote: Quote | null,
    shortQuote: Quote | null,
  ): Promise<void> {
    return this.orderMonitor.monitorAndManageOrders(longQuote, shortQuote);
  }

  // ==================== 订单执行相关方法 ====================

  _canTradeNow(signalAction: string): TradeCheckResult {
    return this.orderExecutor.canTradeNow(signalAction);
  }

  async executeSignals(signals: Signal[]): Promise<void> {
    return this.orderExecutor.executeSignals(signals);
  }
}
