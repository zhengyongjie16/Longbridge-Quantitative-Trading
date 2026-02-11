/**
 * 订单 API 管理模块
 *
 * 职责：
 * - 从 LongPort API 获取订单
 * - 管理订单缓存（缓存到显式清理/刷新为止）
 * - 订单数据转换和验证
 */
import { decimalToNumber } from '../../utils/helpers/index.js';
import { PENDING_ORDER_STATUSES } from '../../constants/index.js';
import type {
  OrderRecord,
  PendingOrder,
  RawOrderFromAPI,
} from '../../types/index.js';
import type {
  OrderCache,
  OrderAPIManager,
  OrderAPIManagerDeps,
} from './types.js';

/** 合并历史订单和今日订单，按 orderId 去重 */
function mergeAndDeduplicateOrders(
  historyOrders: ReadonlyArray<RawOrderFromAPI>,
  todayOrders: ReadonlyArray<RawOrderFromAPI>,
): RawOrderFromAPI[] {
  const orderIdSet = new Set<string>();
  const allOrders: RawOrderFromAPI[] = [];

  // 先添加历史订单
  for (const order of historyOrders) {
    if (!orderIdSet.has(order.orderId)) {
      orderIdSet.add(order.orderId);
      allOrders.push(order);
    }
  }

  // 再添加今日订单（去重）
  for (const order of todayOrders) {
    if (!orderIdSet.has(order.orderId)) {
      orderIdSet.add(order.orderId);
      allOrders.push(order);
    }
  }

  return allOrders;
}

export function createOrderAPIManager(deps: OrderAPIManagerDeps): OrderAPIManager {
  const { ctxPromise, rateLimiter } = deps;

  // 闭包捕获的私有状态
  const ordersCache = new Map<string, OrderCache>();
  let allOrdersCache: RawOrderFromAPI[] | null = null;

  /** 更新指定标的的订单缓存 */
  function updateCache(
    symbol: string,
    buyOrders: OrderRecord[],
    sellOrders: OrderRecord[],
    allOrders: RawOrderFromAPI[] | null = null,
  ): void {
    ordersCache.set(symbol, {
      buyOrders,
      sellOrders,
      allOrders,
      fetchTime: Date.now(),
    });
  }

  /** 使用外部订单列表刷新指定标的缓存 */
  function cacheOrdersForSymbol(
    symbol: string,
    buyOrders: ReadonlyArray<OrderRecord>,
    sellOrders: ReadonlyArray<OrderRecord>,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
  ): void {
    updateCache(symbol, [...buyOrders], [...sellOrders], [...allOrders]);
  }

  /** 清理指定标的的订单缓存 */
  function clearCacheForSymbol(symbol: string): void {
    ordersCache.delete(symbol);
  }

  /** 清空 symbol cache 与 allOrdersCache */
  function clearCache(): void {
    ordersCache.clear();
    allOrdersCache = null;
  }

  /** 从 API 获取全量订单数据（history + today） */
  async function fetchAllOrdersFromAPI(
    forceRefresh = false,
  ): Promise<ReadonlyArray<RawOrderFromAPI>> {
    if (allOrdersCache && !forceRefresh) {
      return [...allOrdersCache];
    }

    const ctx = await ctxPromise;
    await rateLimiter.throttle();
    const historyOrdersRaw = await ctx.historyOrders({
      endAt: new Date(),
    });
    await rateLimiter.throttle();
    const todayOrdersRaw = await ctx.todayOrders();

    const historyOrders = historyOrdersRaw as unknown as RawOrderFromAPI[];
    const todayOrders = todayOrdersRaw as unknown as RawOrderFromAPI[];
    const allOrders = mergeAndDeduplicateOrders(historyOrders, todayOrders);

    allOrdersCache = allOrders;
    return [...allOrders];
  }

  /** 检查指定标的列表是否都有缓存（包含原始订单数据） */
  function hasCacheForSymbols(symbols: ReadonlyArray<string>): boolean {
    if (symbols.length === 0) {
      return false;
    }

    return symbols.every((symbol) => {
      const cached = ordersCache.get(symbol);
      return cached?.allOrders != null;
    });
  }

  /** 从缓存中提取未成交订单，用于启动时避免重复调用 todayOrders API */
  function getPendingOrdersFromCache(symbols: ReadonlyArray<string>): PendingOrder[] {
    // 使用模块级常量 PENDING_ORDER_STATUSES，避免每次调用创建新 Set
    const result: PendingOrder[] = [];

    for (const symbol of symbols) {
      const cached = ordersCache.get(symbol);

      if (!cached?.allOrders) {
        continue;
      }

      const pendingOrders = cached.allOrders
        .filter((order) =>
          PENDING_ORDER_STATUSES.has(order.status) && order.symbol === symbol,
        )
        .map((order) => ({
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          submittedPrice: decimalToNumber(order.price),
          quantity: decimalToNumber(order.quantity),
          executedQuantity: decimalToNumber(order.executedQuantity),
          status: order.status,
          orderType: order.orderType,
          _rawOrder: order,
        }));

      result.push(...pendingOrders);
    }

    return result;
  }

  return {
    fetchAllOrdersFromAPI,
    cacheOrdersForSymbol,
    clearCacheForSymbol,
    clearCache,
    hasCacheForSymbols,
    getPendingOrdersFromCache,
  };
}
