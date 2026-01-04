/**
 * 订单执行模块类型定义
 */

import type { OrderSide, OrderType, TimeInForceType } from 'longport';

/**
 * 默认订单配置类型
 */
export type OrderOptions = {
  symbol: string;
  readonly targetNotional: number;
  readonly quantity: number;
  readonly orderType: typeof OrderType[keyof typeof OrderType];
  readonly timeInForce: typeof TimeInForceType[keyof typeof TimeInForceType];
  readonly remark: string;
  readonly price?: number;
};

/**
 * 订单载荷类型
 */
export type OrderPayload = {
  readonly symbol: string;
  readonly orderType: typeof OrderType[keyof typeof OrderType];
  readonly side: typeof OrderSide[keyof typeof OrderSide];
  readonly timeInForce: typeof TimeInForceType[keyof typeof TimeInForceType];
  readonly submittedQuantity: import('longport').Decimal;
  submittedPrice?: import('longport').Decimal;
  remark?: string;
};

/**
 * 交易记录类型
 */
export type TradeRecord = {
  orderId?: string;
  symbol: string;
  symbolName?: string | null;
  action?: string;
  side?: string;
  quantity?: string;
  price?: string;
  orderType?: string;
  status?: string;
  error?: string;
  reason?: string;
  signalTriggerTime?: Date | string | null;
  timestamp?: string;
};

/**
 * 错误类型标识类型
 */
export type ErrorTypeIdentifier = {
  readonly isShortSellingNotSupported: boolean;
  readonly isInsufficientFunds: boolean;
  readonly isOrderNotFound: boolean;
  readonly isNetworkError: boolean;
  readonly isRateLimited: boolean;
};

