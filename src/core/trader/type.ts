/**
 * 订单执行模块类型定义
 */

import type { OrderSide, OrderType, TimeInForceType } from 'longport';

/**
 * 默认订单配置类型
 */
export type OrderOptions = {
  readonly symbol: string;
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
  readonly submittedPrice?: import('longport').Decimal;
  readonly remark?: string;
};

/**
 * 交易记录类型
 */
export type TradeRecord = {
  readonly orderId?: string;
  readonly symbol: string;
  readonly symbolName?: string | null;
  readonly action?: string;
  readonly side?: string;
  readonly quantity?: string;
  readonly price?: string;
  readonly orderType?: string;
  readonly status?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly signalTriggerTime?: Date | string | null;
  readonly timestamp?: string;
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

/**
 * 交易检查结果类型
 */
export type TradeCheckResult = {
  readonly canTrade: boolean;
  readonly waitSeconds?: number;
  readonly direction?: 'LONG' | 'SHORT';
  readonly reason?: string;
};

/**
 * 订单对象类型（用于修改订单）
 */
export type OrderForReplace = {
  readonly orderId: string;
  readonly status: import('longport').OrderStatus;
  readonly executedQuantity: unknown;
  readonly quantity: unknown;
};

