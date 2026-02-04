/**
 * 订单记录模块工具函数
 *
 * 提供订单相关的纯函数工具，用于订单数量计算等操作。
 */
import { OrderSide, OrderStatus } from 'longport';
import { decimalToNumber } from '../../utils/helpers/index.js';
import type { OrderRecord, RawOrderFromAPI } from '../../types/index.js';

/**
 * 计算订单列表的总成交数量
 */
export function calculateTotalQuantity(orders: ReadonlyArray<OrderRecord>): number {
  return orders.reduce((sum, order) => {
    return sum + (order.executedQuantity || 0);
  }, 0);
}

function convertOrderToRecord(
  order: RawOrderFromAPI,
  isBuyOrder: boolean,
): OrderRecord | null {
  const executedPrice = decimalToNumber(order.executedPrice);
  const executedQuantity = decimalToNumber(order.executedQuantity);
  const executedTime = order.updatedAt ? order.updatedAt.getTime() : 0;

  if (
    !Number.isFinite(executedPrice) ||
    executedPrice <= 0 ||
    !Number.isFinite(executedQuantity) ||
    executedQuantity <= 0 ||
    executedTime === 0
  ) {
    return null;
  }

  return {
    orderId: order.orderId,
    symbol: order.symbol,
    executedPrice: executedPrice,
    executedQuantity: executedQuantity,
    executedTime: executedTime,
    submittedAt: isBuyOrder ? order.submittedAt ?? undefined : undefined,
    updatedAt: isBuyOrder ? order.updatedAt ?? undefined : undefined,
  };
}

export function classifyAndConvertOrders(
  orders: ReadonlyArray<RawOrderFromAPI>,
): {
  buyOrders: OrderRecord[];
  sellOrders: OrderRecord[];
} {
  const buyOrders: OrderRecord[] = [];
  const sellOrders: OrderRecord[] = [];

  for (const order of orders) {
    if (order.status !== OrderStatus.Filled) {
      continue;
    }

    const isBuyOrder = order.side === OrderSide.Buy;
    const isSellOrder = order.side === OrderSide.Sell;

    if (!isBuyOrder && !isSellOrder) {
      continue;
    }

    const converted = convertOrderToRecord(order, isBuyOrder);
    if (!converted) {
      continue;
    }

    if (isBuyOrder) {
      buyOrders.push(converted);
    } else {
      sellOrders.push(converted);
    }
  }

  return { buyOrders, sellOrders };
}
