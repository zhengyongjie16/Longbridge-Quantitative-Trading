/**
 * 订单记录模块工具函数
 *
 * 提供订单相关的纯函数工具，用于订单数量计算等操作。
 */

import type { OrderRecord } from '../../types/index.js';

/**
 * 计算订单列表的总成交数量
 */
export function calculateTotalQuantity(orders: ReadonlyArray<OrderRecord>): number {
  return orders.reduce((sum, order) => {
    return sum + (order.executedQuantity || 0);
  }, 0);
}
