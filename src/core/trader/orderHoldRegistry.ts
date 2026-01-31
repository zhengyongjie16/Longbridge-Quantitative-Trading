import { PENDING_ORDER_STATUSES } from '../../constants/index.js';
import type { RawOrderFromAPI } from '../../types/index.js';
import type { OrderHoldRegistry } from './types.js';

export function createOrderHoldRegistry(): OrderHoldRegistry {
  const orderIdToSymbol = new Map<string, string>();
  const orderIdsBySymbol = new Map<string, Set<string>>();
  const holdSymbols = new Set<string>();

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
