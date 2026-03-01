/**
 * 订单 API 管理模块
 *
 * 职责：
 * - 从 LongPort API 获取订单
 * - 管理订单缓存（缓存到显式清理/刷新为止）
 * - 在信任边界将 SDK Order 转换为 RawOrderFromAPI
 */
import type { Order } from 'longport';
import { decimalToNumber } from '../../utils/helpers/index.js';
import type { OrderRecord, RawOrderFromAPI } from '../../types/services.js';
import type {
  MergedOrderEntry,
  OrderCache,
  OrderAPIManager,
  OrderAPIManagerDeps,
  OrderSnapshotSource,
} from './types.js';

/**
 * 将 LongPort SDK Order 实例转换为内部 RawOrderFromAPI（信任边界唯一转换处）。
 *
 * @param order LongPort SDK 返回的 Order 实例
 * @returns 内部统一的 RawOrderFromAPI 结构
 */
function orderToRawOrderFromAPI(order: Order): RawOrderFromAPI {
  const price = order.price;
  const executedPrice = order.executedPrice;
  return {
    orderId: order.orderId,
    symbol: order.symbol,
    stockName: order.stockName,
    side: order.side,
    status: order.status,
    orderType: order.orderType,
    price: price === null ? null : decimalToNumber(price),
    quantity: decimalToNumber(order.quantity),
    executedPrice: executedPrice === null ? null : decimalToNumber(executedPrice),
    executedQuantity: decimalToNumber(order.executedQuantity),
    submittedAt: order.submittedAt,
    updatedAt: order.updatedAt ?? null,
  };
}

/**
 * 解析订单快照版本时间（用于合并去重时比较新旧）。
 * 优先使用 updatedAt，其次 submittedAt，均缺失时按 0 处理。
 *
 * @param order 订单记录
 * @returns 版本时间戳（毫秒）
 */
function resolveOrderSnapshotVersionMs(order: RawOrderFromAPI): number {
  const updatedAtMs = order.updatedAt?.getTime() ?? 0;
  if (updatedAtMs > 0) {
    return updatedAtMs;
  }
  const submittedAtMs = order.submittedAt?.getTime() ?? 0;
  return Math.max(Number.isNaN(submittedAtMs) ? 0 : submittedAtMs, 0);
}

/**
 * 判断候选订单是否应覆盖现有订单：today 快照优先于 history；同一来源时版本时间更晚者优先。
 *
 * @param existingEntry 已存在的合并项
 * @param candidateOrder 候选订单
 * @param candidateSource 候选订单来源（today/history）
 * @returns 为 true 时应用候选订单覆盖现有项
 */
function shouldReplaceMergedEntry(
  existingEntry: MergedOrderEntry,
  candidateOrder: RawOrderFromAPI,
  candidateSource: OrderSnapshotSource,
): boolean {
  if (candidateSource === 'today' && existingEntry.source === 'history') {
    return true;
  }

  if (candidateSource === 'history' && existingEntry.source === 'today') {
    return false;
  }

  const existingVersion = resolveOrderSnapshotVersionMs(existingEntry.order);
  const candidateVersion = resolveOrderSnapshotVersionMs(candidateOrder);
  return candidateVersion > existingVersion;
}

/**
 * 合并历史订单和今日订单，按 orderId 去重并保留最新快照。
 *
 * @param historyOrders 历史订单列表
 * @param todayOrders 今日订单列表
 * @returns 按 orderId 去重后的订单数组（同 ID 保留版本更新的一条）
 */
function mergeAndDeduplicateOrders(
  historyOrders: ReadonlyArray<RawOrderFromAPI>,
  todayOrders: ReadonlyArray<RawOrderFromAPI>,
): RawOrderFromAPI[] {
  const mergedByOrderId = new Map<string, MergedOrderEntry>();

  for (const order of historyOrders) {
    const existing = mergedByOrderId.get(order.orderId);
    if (!existing) {
      mergedByOrderId.set(order.orderId, {
        source: 'history',
        order,
      });
      continue;
    }

    if (shouldReplaceMergedEntry(existing, order, 'history')) {
      mergedByOrderId.set(order.orderId, {
        source: 'history',
        order,
      });
    }
  }

  for (const order of todayOrders) {
    const existing = mergedByOrderId.get(order.orderId);
    if (!existing) {
      mergedByOrderId.set(order.orderId, {
        source: 'today',
        order,
      });
      continue;
    }

    if (shouldReplaceMergedEntry(existing, order, 'today')) {
      mergedByOrderId.set(order.orderId, {
        source: 'today',
        order,
      });
    }
  }

  return Array.from(mergedByOrderId.values(), (entry) => entry.order);
}

/**
 * 创建订单 API 管理器
 * 管理全量订单缓存（history + today 合并去重），提供按标的缓存读写和强制刷新能力；信任边界内将 SDK Order 转为 RawOrderFromAPI。
 * @param deps 依赖注入（ctxPromise、rateLimiter）
 * @returns OrderAPIManager 接口实例（fetchAllOrdersFromAPI、cacheOrdersForSymbol、clearCacheForSymbol、clearCache）
 */
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
    if (ordersCache.has(symbol)) {
      ordersCache.delete(symbol);
    }
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
    const historyOrdersRaw: ReadonlyArray<Order> = await ctx.historyOrders({
      endAt: new Date(),
    });
    await rateLimiter.throttle();
    const todayOrdersRaw: ReadonlyArray<Order> = await ctx.todayOrders();

    const historyOrders = Array.from(historyOrdersRaw, orderToRawOrderFromAPI);
    const todayOrders = Array.from(todayOrdersRaw, orderToRawOrderFromAPI);
    const allOrders = mergeAndDeduplicateOrders(historyOrders, todayOrders);

    allOrdersCache = allOrders;
    return [...allOrders];
  }

  return {
    fetchAllOrdersFromAPI,
    cacheOrdersForSymbol,
    clearCacheForSymbol,
    clearCache,
  };
}
