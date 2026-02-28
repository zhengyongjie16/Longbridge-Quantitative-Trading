/**
 * 交易执行模块入口（门面模式）
 *
 * 职责：
 * - 协调各子模块（账户、缓存、监控、执行）完成交易功能
 * - 提供统一的 Trader 接口供外部调用
 *
 * 子模块：
 * - rateLimiter: API 频率限制（可通过 rateLimiterConfig 配置，默认 30次/30秒）
 * - accountService: 账户余额和持仓查询
 * - orderCacheManager: 未成交订单缓存
 * - orderRecorder: 订单记录管理
 * - orderMonitor: WebSocket 订单状态监控
 * - orderExecutor: 信号执行和订单提交
 *
 * 初始化顺序：
 * 1. ctxPromise → 2. rateLimiter/cacheManager/accountService
 * 3. orderRecorder → 4. orderMonitor → 5. orderExecutor
 */
import { TradeContext } from 'longport';
import { createOrderRecorder } from '../orderRecorder/index.js';
import type { Signal, SignalType } from '../../types/signal.js';
import type { Quote } from '../../types/quote.js';
import type { AccountSnapshot, Position } from '../../types/account.js';
import type {
  Trader,
  TradeCheckResult,
  PendingOrder,
  PendingRefreshSymbol,
  RawOrderFromAPI,
} from '../../types/services.js';
import type { MonitorConfig } from '../../types/config.js';
import type { TraderDeps } from './types.js';

// 导入子模块工厂函数
import { createRateLimiter } from './rateLimiter.js';
import { createAccountService } from './accountService.js';
import { createOrderCacheManager } from './orderCacheManager.js';
import { createOrderMonitor } from './orderMonitor/index.js';
import { createOrderExecutor } from './orderExecutor/index.js';
import { createOrderHoldRegistry } from './orderHoldRegistry.js';
import { createOrderStorage } from '../orderRecorder/orderStorage.js';
import { createOrderAPIManager } from '../orderRecorder/orderApiManager.js';
import { createOrderFilteringEngine } from '../orderRecorder/orderFilteringEngine.js';

/**
 * 创建交易执行模块（门面模式）。
 * 按固定顺序创建 rateLimiter、accountService、orderCacheManager、orderRecorder、orderMonitor、orderExecutor 等子模块并组装为 Trader 接口。
 * createTrader 仅负责依赖装配，不执行运行期副作用（如 WebSocket 初始化、订单恢复），由上层显式调用。
 * 交易能力由多子模块协同完成，门面统一初始化顺序与依赖注入，保证 orderMonitor 依赖 orderRecorder、orderExecutor 依赖 orderMonitor 等约束。
 * @param deps 依赖（config、tradingConfig、liquidationCooldownTracker、symbolRegistry、dailyLossTracker、refreshGate、isExecutionAllowed 等）
 * @returns 实现 Trader 接口的实例（含 canTradeNow、executeSignals、getPendingOrders 等）
 */
export function createTrader(deps: TraderDeps): Promise<Trader> {
  const {
    config,
    tradingConfig,
    liquidationCooldownTracker,
    symbolRegistry,
    dailyLossTracker,
    refreshGate,
    isExecutionAllowed,
  } = deps;

  // ========== 1. 创建基础依赖 ==========
  const ctxPromise = TradeContext.new(config);

  // ========== 2. 创建无依赖的基础模块 ==========
  const rateLimiterConfig = deps.rateLimiterConfig ?? { maxCalls: 30, windowMs: 30000 };
  const rateLimiter = createRateLimiter({ config: rateLimiterConfig });

  const cacheManager = createOrderCacheManager({ ctxPromise, rateLimiter });

  const accountService = createAccountService({ ctxPromise, rateLimiter });

  // ========== 3. 创建 orderRecorder（依赖注入子模块） ==========
  const orderStorage = createOrderStorage();
  const orderApiManager = createOrderAPIManager({ ctxPromise, rateLimiter });
  const orderFilteringEngine = createOrderFilteringEngine();
  const orderRecorder = createOrderRecorder({
    storage: orderStorage,
    apiManager: orderApiManager,
    filteringEngine: orderFilteringEngine,
  });

  // ========== 4. 创建 orderHoldRegistry ==========
  const orderHoldRegistry = createOrderHoldRegistry();

  // ========== 5. 创建 orderMonitor（依赖 orderRecorder） ==========
  const orderMonitor = createOrderMonitor({
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderRecorder,
    dailyLossTracker,
    orderHoldRegistry,
    liquidationCooldownTracker,
    tradingConfig,
    symbolRegistry,
    isExecutionAllowed,
    ...(refreshGate ? { refreshGate } : {}),
  });

  // ========== 6. 创建 orderExecutor ==========
  const orderExecutor = createOrderExecutor({
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderMonitor,
    orderRecorder,
    tradingConfig,
    symbolRegistry,
    isExecutionAllowed,
  });

  // 创建 Trader 实例
  const trader: Trader = {
    orderRecorder,

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

    seedOrderHoldSymbols(orders: ReadonlyArray<RawOrderFromAPI>): void {
      orderHoldRegistry.seedFromOrders(orders);
    },

    getOrderHoldSymbols(): ReadonlySet<string> {
      return orderHoldRegistry.getHoldSymbols();
    },

    // ==================== 订单监控相关方法 ====================

    cancelOrder(orderId: string): Promise<boolean> {
      return orderMonitor.cancelOrder(orderId);
    },

    monitorAndManageOrders(quotesMap: ReadonlyMap<string, Quote | null>): Promise<void> {
      return orderMonitor.processWithLatestQuotes(quotesMap);
    },

    getAndClearPendingRefreshSymbols(): PendingRefreshSymbol[] {
      return orderMonitor.getAndClearPendingRefreshSymbols();
    },

    initializeOrderMonitor(): Promise<void> {
      return orderMonitor.initialize();
    },

    // ==================== 订单执行相关方法 ====================

    canTradeNow(signalAction: SignalType, monitorConfig?: MonitorConfig | null): TradeCheckResult {
      return orderExecutor.canTradeNow(signalAction, monitorConfig);
    },

    recordBuyAttempt(signalAction: SignalType, monitorConfig?: MonitorConfig | null): void {
      orderExecutor.markBuyAttempt(signalAction, monitorConfig);
    },

    fetchAllOrdersFromAPI(forceRefresh: boolean = false): Promise<ReadonlyArray<RawOrderFromAPI>> {
      return orderRecorder.fetchAllOrdersFromAPI(forceRefresh);
    },

    resetRuntimeState(): void {
      orderRecorder.resetAll();
      cacheManager.clearCache();
      orderHoldRegistry.clear();
      orderMonitor.clearTrackedOrders();
      orderExecutor.resetBuyThrottle();
    },

    recoverOrderTrackingFromSnapshot(allOrders: ReadonlyArray<RawOrderFromAPI>): Promise<void> {
      return orderMonitor.recoverOrderTrackingFromSnapshot(allOrders);
    },

    executeSignals(
      signals: Signal[],
    ): Promise<{ submittedCount: number; submittedOrderIds: ReadonlyArray<string> }> {
      return orderExecutor.executeSignals(signals);
    },
  };

  return Promise.resolve(trader);
}
