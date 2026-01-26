/**
 * 订单 API 管理模块
 *
 * 职责：
 * - 从 LongPort API 获取订单
 * - 管理订单缓存（永久缓存，程序运行期间）
 * - 订单数据转换和验证
 */

import { OrderSide, OrderStatus } from 'longport';
import { decimalToNumber } from '../../utils/helpers/index.js';
import type {
  OrderRecord,
  FetchOrdersResult,
  PendingOrder,
} from '../../types/index.js';
import type {
  OrderCache,
  RawOrderFromAPI,
  OrderAPIManager,
  OrderAPIManagerDeps,
} from './types.js';

/** 未成交订单状态集合（模块级常量，避免函数内重复创建） */
const PENDING_ORDER_STATUSES = new Set([
  OrderStatus.New,
  OrderStatus.PartialFilled,
  OrderStatus.WaitToNew,
  OrderStatus.WaitToReplace,
  OrderStatus.PendingReplace,
]) as ReadonlySet<typeof OrderStatus[keyof typeof OrderStatus]>;

/**
 * 创建订单API管理器
 * @param deps 依赖注入
 * @returns OrderAPIManager 接口实例
 */
export const createOrderAPIManager = (deps: OrderAPIManagerDeps): OrderAPIManager => {
  const { ctxPromise, rateLimiter } = deps;

  // 闭包捕获的私有状态
  const ordersCache = new Map<string, OrderCache>();

  /** 检查指定标的的缓存是否存在 */
  const hasCache = (symbol: string): boolean => {
    return ordersCache.has(symbol);
  };

  /** 从缓存获取订单数据，返回买入和卖出订单的副本 */
  const getCachedOrders = (symbol: string): {
    buyOrders: OrderRecord[];
    sellOrders: OrderRecord[];
  } | null => {
    const cached = ordersCache.get(symbol);
    if (!cached) {
      return null;
    }
    return {
      buyOrders: [...cached.buyOrders],
      sellOrders: [...cached.sellOrders],
    };
  };

  /** 更新指定标的的订单缓存 */
  const updateCache = (
    symbol: string,
    buyOrders: OrderRecord[],
    sellOrders: OrderRecord[],
    allOrders: RawOrderFromAPI[] | null = null,
  ): void => {
    ordersCache.set(symbol, {
      buyOrders,
      sellOrders,
      allOrders,
      fetchTime: Date.now(),
    });
  };

  /** 合并历史订单和今日订单，按 orderId 去重 */
  const mergeAndDeduplicateOrders = (
    historyOrders: RawOrderFromAPI[],
    todayOrders: RawOrderFromAPI[],
  ): RawOrderFromAPI[] => {
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
  };

  /** 将 API 原始订单转换为标准 OrderRecord 格式，验证失败返回 null */
  const convertOrderToRecord = (
    order: RawOrderFromAPI,
    isBuyOrder: boolean,
  ): OrderRecord | null => {
    const executedPrice = decimalToNumber(order.executedPrice);
    const executedQuantity = decimalToNumber(order.executedQuantity);
    const executedTime = order.updatedAt ? order.updatedAt.getTime() : 0;

    // 验证数据有效性
    if (
      !Number.isFinite(executedPrice) ||
      executedPrice <= 0 ||
      !Number.isFinite(executedQuantity) ||
      executedQuantity <= 0 ||
      executedTime === 0
    ) {
      return null;
    }

    const converted: OrderRecord = {
      orderId: order.orderId,
      symbol: order.symbol,
      executedPrice: executedPrice,
      executedQuantity: executedQuantity,
      executedTime: executedTime,
      submittedAt: isBuyOrder ? order.submittedAt : undefined,
      updatedAt: isBuyOrder ? order.updatedAt : undefined,
    };

    return converted;
  };

  /** 按买卖方向分类订单，筛选已成交订单并转换格式 */
  const classifyAndConvertOrders = (orders: RawOrderFromAPI[]): {
    buyOrders: OrderRecord[];
    sellOrders: OrderRecord[];
  } => {
    const filledBuyOrders = orders.filter(
      (order) =>
        order.side === OrderSide.Buy && order.status === OrderStatus.Filled,
    );

    const filledSellOrders = orders.filter(
      (order) =>
        order.side === OrderSide.Sell && order.status === OrderStatus.Filled,
    );

    const buyOrders = filledBuyOrders
      .map((order) => convertOrderToRecord(order, true))
      .filter((order): order is OrderRecord => order !== null);

    const sellOrders = filledSellOrders
      .map((order) => convertOrderToRecord(order, false))
      .filter((order): order is OrderRecord => order !== null);

    return { buyOrders, sellOrders };
  };

  /**
   * 从 API 获取并转换订单数据
   * 优先使用缓存，若无缓存则调用 historyOrders 和 todayOrders API
   */
  const fetchOrdersFromAPI = async (symbol: string): Promise<FetchOrdersResult> => {
    // 优先使用缓存
    if (hasCache(symbol)) {
      const cached = getCachedOrders(symbol);
      if (cached) {
        return cached;
      }
    }

    // 从 API 获取订单（使用 rateLimiter 控制频率）
    const ctx = await ctxPromise;
    // 此处 API 调用由外部进行错误捕获，这里不需要try-catch
    // 注意：必须串行调用并在每次调用前 throttle，以符合 API 限制
    // - 30秒内不超过30次调用
    // - 两次调用间隔不少于0.02秒
    await rateLimiter.throttle();
    const historyOrdersRaw = await ctx.historyOrders({
      symbol,
      endAt: new Date(),
    });
    await rateLimiter.throttle();
    const todayOrdersRaw = await ctx.todayOrders({ symbol });

    // 转换为 RawOrderFromAPI 类型（通过 unknown 进行安全转换）
    const historyOrders = historyOrdersRaw as unknown as RawOrderFromAPI[];
    const todayOrders = todayOrdersRaw as unknown as RawOrderFromAPI[];

    // 合并并去重
    const allOrders = mergeAndDeduplicateOrders(historyOrders, todayOrders);

    // 分类和转换订单
    const { buyOrders, sellOrders } = classifyAndConvertOrders(allOrders);

    // 更新缓存
    updateCache(symbol, buyOrders, sellOrders, allOrders);

    return { buyOrders, sellOrders };
  };

  /** 检查指定标的列表是否都有缓存（包含原始订单数据） */
  const hasCacheForSymbols = (symbols: string[]): boolean => {
    if (symbols.length === 0) {
      return false;
    }

    return symbols.every((symbol) => {
      const cached = ordersCache.get(symbol);
      return cached?.allOrders != null;
    });
  };

  /** 从缓存中提取未成交订单，用于启动时避免重复调用 todayOrders API */
  const getPendingOrdersFromCache = (symbols: string[]): PendingOrder[] => {
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
  };

  return {
    fetchOrdersFromAPI,
    hasCacheForSymbols,
    getPendingOrdersFromCache,
  };
};
