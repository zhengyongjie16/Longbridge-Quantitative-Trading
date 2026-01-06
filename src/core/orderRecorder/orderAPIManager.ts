/**
 * 订单 API 管理模块
 *
 * 职责：
 * - 从 LongPort API 获取订单
 * - 管理订单缓存（永久缓存，程序运行期间）
 * - 订单数据转换和验证
 */

import { OrderSide, OrderStatus } from 'longport';
import {
  normalizeHKSymbol,
  decimalToNumber,
} from '../../utils/helpers.js';
import type {
  OrderRecord,
  OrderCache,
  FetchOrdersResult,
  RawOrderFromAPI,
  OrderAPIManager,
  OrderAPIManagerDeps,
} from './type.js';
import type { PendingOrder } from '../type.js';

/**
 * 创建订单API管理器
 * @param deps 依赖注入
 * @returns OrderAPIManager 接口实例
 */
export const createOrderAPIManager = (deps: OrderAPIManagerDeps): OrderAPIManager => {
  const ctxPromise = deps.ctxPromise;

  // 闭包捕获的私有状态
  const ordersCache = new Map<string, OrderCache>();

  /**
   * 检查指定标的的缓存是否存在（仅检查 key 是否存在）
   */
  const hasCache = (normalizedSymbol: string): boolean => {
    return ordersCache.has(normalizedSymbol);
  };

  /**
   * 从缓存获取订单数据
   */
  const getCachedOrders = (normalizedSymbol: string): {
    buyOrders: OrderRecord[];
    sellOrders: OrderRecord[];
  } | null => {
    const cached = ordersCache.get(normalizedSymbol);
    if (!cached) {
      return null;
    }
    return {
      buyOrders: [...cached.buyOrders],
      sellOrders: [...cached.sellOrders],
    };
  };

  /**
   * 更新缓存
   */
  const updateCache = (
    normalizedSymbol: string,
    buyOrders: OrderRecord[],
    sellOrders: OrderRecord[],
    allOrders: RawOrderFromAPI[] | null = null,
  ): void => {
    ordersCache.set(normalizedSymbol, {
      buyOrders,
      sellOrders,
      allOrders,
      fetchTime: Date.now(),
    });
  };

  /**
   * 合并并去重订单列表
   */
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

  /**
   * 转换单个订单为标准格式
   */
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
      symbol: normalizeHKSymbol(order.symbol),
      executedPrice: executedPrice,
      executedQuantity: executedQuantity,
      executedTime: executedTime,
      submittedAt: isBuyOrder ? order.submittedAt : undefined,
      updatedAt: isBuyOrder ? order.updatedAt : undefined,
    };

    return converted;
  };

  /**
   * 分类并转换订单
   */
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
   * 从API获取并转换订单数据（使用缓存）
   */
  const fetchOrdersFromAPI = async (symbol: string): Promise<FetchOrdersResult> => {
    const normalizedSymbol = normalizeHKSymbol(symbol);

    // 优先使用缓存
    if (hasCache(normalizedSymbol)) {
      const cached = getCachedOrders(normalizedSymbol);
      if (cached) {
        return cached;
      }
    }

    // 从 API 获取订单
    const ctx = await ctxPromise;

    const [historyOrdersRaw, todayOrdersRaw] = await Promise.all([
      ctx.historyOrders({
        symbol: normalizedSymbol,
        endAt: new Date(),
      }),
      ctx.todayOrders({ symbol: normalizedSymbol }),
    ]);

    // 转换为 RawOrderFromAPI 类型（通过 unknown 进行安全转换）
    const historyOrders = historyOrdersRaw as unknown as RawOrderFromAPI[];
    const todayOrders = todayOrdersRaw as unknown as RawOrderFromAPI[];

    // 合并并去重
    const allOrders = mergeAndDeduplicateOrders(historyOrders, todayOrders);

    // 分类和转换订单
    const { buyOrders, sellOrders } = classifyAndConvertOrders(allOrders);

    // 更新缓存
    updateCache(normalizedSymbol, buyOrders, sellOrders, allOrders);

    return { buyOrders, sellOrders };
  };

  /**
   * 检查指定标的的缓存是否存在
   */
  const hasCacheForSymbols = (symbols: string[]): boolean => {
    if (symbols.length === 0) {
      return false;
    }

    const normalizedSymbols = symbols.map((s) => normalizeHKSymbol(s));
    return normalizedSymbols.every((symbol) => {
      const cached = ordersCache.get(symbol);
      return cached?.allOrders != null;
    });
  };

  /**
   * 从缓存的原始订单中提取未成交订单（用于启动时避免重复调用 todayOrders）
   */
  const getPendingOrdersFromCache = (symbols: string[]): PendingOrder[] => {
    const pendingStatuses = new Set([
      OrderStatus.New,
      OrderStatus.PartialFilled,
      OrderStatus.WaitToNew,
      OrderStatus.WaitToReplace,
      OrderStatus.PendingReplace,
    ]);

    const result: PendingOrder[] = [];

    for (const symbol of symbols) {
      const normalizedSymbol = normalizeHKSymbol(symbol);
      const cached = ordersCache.get(normalizedSymbol);

      if (!cached?.allOrders) {
        continue;
      }

      const pendingOrders = cached.allOrders
        .filter((order) => {
          const normalizedOrderSymbol = normalizeHKSymbol(order.symbol);
          return (
            pendingStatuses.has(order.status) &&
            normalizedOrderSymbol === normalizedSymbol
          );
        })
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
