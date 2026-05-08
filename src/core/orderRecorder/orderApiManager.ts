/**
 * 订单 API 管理模块
 *
 * 职责：
 * - 从 Longbridge API 获取订单
 * - 管理订单缓存（缓存到显式清理/刷新为止）
 * - 在信任边界将 SDK Order 转换为 RawOrderFromAPI
 */
import { OrderSide, OrderStatus, OrderType, type Order } from 'longbridge';
import { decimalToNumber, isRecord } from '../../utils/helpers/index.js';
import { wrapExternalApiRequest } from '../../utils/apiFailure/index.js';
import type { OrderRecord, RawOrderFromAPI } from '../../types/services.js';
import type {
  MergedOrderEntry,
  OrderCache,
  OrderAPIManager,
  OrderAPIManagerDeps,
  OrderSnapshotSource,
} from './types.js';

/**
 * 校验外部订单 API 返回值必须是数组。
 *
 * @param value 外部 API 返回值
 * @param operation 外部 API 操作名
 */
function assertOrderArray(
  value: unknown,
  operation: string,
): asserts value is ReadonlyArray<unknown> {
  if (!Array.isArray(value)) {
    throw new TypeError(`[订单记录] ${operation} 返回值不是数组`);
  }
}

function hasToNumber(value: unknown): value is { readonly toNumber: () => unknown } {
  return isRecord(value) && typeof value['toNumber'] === 'function';
}

function isFiniteDecimalLike(value: unknown): boolean {
  if (typeof value === 'number' || typeof value === 'string') {
    return Number.isFinite(decimalToNumber(value));
  }

  if (hasToNumber(value)) {
    const numeric = value.toNumber();
    return typeof numeric === 'number' && Number.isFinite(numeric);
  }

  return false;
}

function isNullableFiniteDecimalLike(value: unknown): boolean {
  return value === null || isFiniteDecimalLike(value);
}

function isValidOrderSide(value: unknown): value is OrderSide {
  switch (value) {
    case OrderSide.Unknown:
    case OrderSide.Buy:
    case OrderSide.Sell: {
      return true;
    }

    default: {
      return false;
    }
  }
}

function isValidOrderStatus(value: unknown): value is OrderStatus {
  switch (value) {
    case OrderStatus.Unknown:
    case OrderStatus.NotReported:
    case OrderStatus.ReplacedNotReported:
    case OrderStatus.ProtectedNotReported:
    case OrderStatus.VarietiesNotReported:
    case OrderStatus.Filled:
    case OrderStatus.WaitToNew:
    case OrderStatus.New:
    case OrderStatus.WaitToReplace:
    case OrderStatus.PendingReplace:
    case OrderStatus.Replaced:
    case OrderStatus.PartialFilled:
    case OrderStatus.WaitToCancel:
    case OrderStatus.PendingCancel:
    case OrderStatus.Rejected:
    case OrderStatus.Canceled:
    case OrderStatus.Expired:
    case OrderStatus.PartialWithdrawal: {
      return true;
    }

    default: {
      return false;
    }
  }
}

function isValidOrderType(value: unknown): value is OrderType {
  switch (value) {
    case OrderType.Unknown:
    case OrderType.LO:
    case OrderType.ELO:
    case OrderType.MO:
    case OrderType.AO:
    case OrderType.ALO:
    case OrderType.ODD:
    case OrderType.LIT:
    case OrderType.MIT:
    case OrderType.TSLPAMT:
    case OrderType.TSLPPCT:
    case OrderType.TSMAMT:
    case OrderType.TSMPCT:
    case OrderType.SLO: {
      return true;
    }

    default: {
      return false;
    }
  }
}

function assertValidOrder(value: unknown, operation: string): asserts value is Order {
  if (!isRecord(value)) {
    throw new TypeError(`[订单记录] ${operation} 订单数据结构无效`);
  }

  if (
    typeof value['orderId'] !== 'string' ||
    value['orderId'].length === 0 ||
    typeof value['symbol'] !== 'string' ||
    value['symbol'].length === 0 ||
    typeof value['stockName'] !== 'string' ||
    !isValidOrderSide(value['side']) ||
    !isValidOrderStatus(value['status']) ||
    !isValidOrderType(value['orderType']) ||
    !isNullableFiniteDecimalLike(value['price']) ||
    !isFiniteDecimalLike(value['quantity']) ||
    !isNullableFiniteDecimalLike(value['executedPrice']) ||
    !isFiniteDecimalLike(value['executedQuantity']) ||
    !(value['submittedAt'] instanceof Date) ||
    (value['updatedAt'] !== undefined &&
      value['updatedAt'] !== null &&
      !(value['updatedAt'] instanceof Date))
  ) {
    throw new TypeError(`[订单记录] ${operation} 订单数据结构无效`);
  }
}

function assertValidOrders(
  orders: ReadonlyArray<unknown>,
  operation: string,
): asserts orders is ReadonlyArray<Order> {
  for (const order of orders) {
    assertValidOrder(order, operation);
  }
}

/**
 * 将 Longbridge SDK Order 实例转换为内部 RawOrderFromAPI（信任边界唯一转换处）。
 *
 * @param order Longbridge SDK 返回的 Order 实例
 * @returns 内部统一的 RawOrderFromAPI 结构
 */
function orderToRawOrderFromAPI(order: Order): RawOrderFromAPI {
  const price = order.price;
  const executedPrice = order.executedPrice;
  const remark = order.remark;
  return {
    orderId: order.orderId,
    symbol: order.symbol,
    stockName: order.stockName,
    side: order.side,
    status: order.status,
    orderType: order.orderType,
    remark: typeof remark === 'string' ? remark : null,
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
 * @param deps 依赖注入（ctx、rateLimiter）
 * @returns OrderAPIManager 接口实例（fetchAllOrdersFromAPI、cacheOrdersForSymbol、clearCacheForSymbol、clearCache）
 */
export function createOrderAPIManager(deps: OrderAPIManagerDeps): OrderAPIManager {
  const { ctx, rateLimiter } = deps;

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

    await rateLimiter.throttle();
    const historyOrdersRaw: unknown = await wrapExternalApiRequest({
      operation: 'TradeContext.historyOrders',
      request: () =>
        ctx.historyOrders({
          endAt: new Date(),
        }),
    });
    assertOrderArray(historyOrdersRaw, 'TradeContext.historyOrders');
    assertValidOrders(historyOrdersRaw, 'TradeContext.historyOrders');

    await rateLimiter.throttle();
    const todayOrdersRaw: unknown = await wrapExternalApiRequest({
      operation: 'TradeContext.todayOrders',
      request: () => ctx.todayOrders(),
    });
    assertOrderArray(todayOrdersRaw, 'TradeContext.todayOrders');
    assertValidOrders(todayOrdersRaw, 'TradeContext.todayOrders');

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
