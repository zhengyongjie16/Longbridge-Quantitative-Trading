/**
 * 订单保留集管理：
 * - 追踪未成交订单，维护 symbol -> orderId 的索引
 * - 用于限制重复交易或快速判断是否存在未完成订单
 */
import { PENDING_ORDER_STATUSES } from '../../constants/index.js';
import type { RawOrderFromAPI } from '../../types/index.js';
import type { OrderHoldRegistry } from './types.js';

export function createOrderHoldRegistry(): OrderHoldRegistry {
  const orderIdToSymbol = new Map<string, string>();
  const orderIdsBySymbol = new Map<string, Set<string>>();
  const holdSymbols = new Set<string>();

  /**
   * 追踪订单与标的的关联，建立双向索引。
   */
  function trackOrder(orderId: string, symbol: string): void {
    if (!orderId || !symbol) {
      return;
    }
    if (orderIdToSymbol.has(orderId)) {
      return;
    }
    orderIdToSymbol.set(orderId, symbol);

    let symbolOrders = orderIdsBySymbol.get(symbol);
    if (!symbolOrders) {
      symbolOrders = new Set<string>();
      orderIdsBySymbol.set(symbol, symbolOrders);
    }
    symbolOrders.add(orderId);
    holdSymbols.add(symbol);
  }

  /**
   * 订单成交后清理索引，若标的无剩余未成交订单则移除。
   */
  function markOrderFilled(orderId: string): void {
    const symbol = orderIdToSymbol.get(orderId);
    if (!symbol) {
      return;
    }
    orderIdToSymbol.delete(orderId);

    const symbolOrders = orderIdsBySymbol.get(symbol);
    if (!symbolOrders) {
      return;
    }
    symbolOrders.delete(orderId);
    if (symbolOrders.size === 0) {
      orderIdsBySymbol.delete(symbol);
      holdSymbols.delete(symbol);
    }
  }

  /**
   * 启动时从已有订单列表初始化保留集。
   */
  function seedFromOrders(orders: ReadonlyArray<RawOrderFromAPI>): void {
    for (const order of orders) {
      if (!order || !order.symbol) {
        continue;
      }
      if (!PENDING_ORDER_STATUSES.has(order.status)) {
        continue;
      }
      trackOrder(String(order.orderId), order.symbol);
    }
  }

  /**
   * 返回当前存在未成交订单的标的集合。
   */
  function getHoldSymbols(): ReadonlySet<string> {
    return holdSymbols;
  }

  return {
    trackOrder,
    markOrderFilled,
    seedFromOrders,
    getHoldSymbols,
  };
}
