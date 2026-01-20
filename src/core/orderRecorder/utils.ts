/**
 * 订单记录模块工具函数
 */

import type { OrderRecord } from '../../types/index.js';

/**
 * 计算订单列表的总成交数量
 * @param orders 订单列表
 * @returns 总成交数量
 */
export function calculateTotalQuantity(orders: ReadonlyArray<OrderRecord>): number {
  return orders.reduce((sum, order) => {
    return sum + (order.executedQuantity || 0);
  }, 0);
}
