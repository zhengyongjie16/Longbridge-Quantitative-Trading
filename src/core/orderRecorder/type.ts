/**
 * 订单记录模块类型定义
 */

/**
 * 订单记录接口
 */
export interface OrderRecord {
  orderId: string;
  symbol: string;
  executedPrice: number;
  executedQuantity: number;
  executedTime: number;
  submittedAt: Date | undefined;
  updatedAt: Date | undefined;
}

/**
 * 订单缓存接口
 */
export interface OrderCache {
  buyOrders: OrderRecord[];
  sellOrders: OrderRecord[];
  allOrders: unknown[] | null;
  fetchTime: number;
}

/**
 * 获取订单结果接口
 */
export interface FetchOrdersResult {
  success?: boolean;
  buyOrders: OrderRecord[];
  sellOrders: OrderRecord[];
}

