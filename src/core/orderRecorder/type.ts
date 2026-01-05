/**
 * 订单记录模块类型定义
 */

import type { OrderSide, OrderStatus, OrderType } from 'longport';
import type { DecimalLikeValue } from '../../types/index.js';

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
 * API 返回的原始订单接口（用于类型安全的转换）
 */
export interface RawOrderFromAPI {
  orderId: string;
  symbol: string;
  side: OrderSide;
  status: OrderStatus;
  orderType: OrderType;
  price: DecimalLikeValue;
  quantity: DecimalLikeValue;
  executedPrice: DecimalLikeValue;
  executedQuantity: DecimalLikeValue;
  submittedAt?: Date;
  updatedAt?: Date;
}

/**
 * 订单缓存接口
 */
export interface OrderCache {
  buyOrders: OrderRecord[];
  sellOrders: OrderRecord[];
  allOrders: RawOrderFromAPI[] | null;
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

/**
 * 订单统计信息接口（用于调试输出）
 */
export interface OrderStatistics {
  totalQuantity: number;
  totalValue: number;
  averagePrice: number;
}

/**
 * 过滤算法的中间结果接口
 */
export interface FilteringState {
  m0Orders: OrderRecord[];
  candidateOrders: OrderRecord[];
}

