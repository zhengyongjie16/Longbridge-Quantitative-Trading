import { OrderSide, OrderStatus, type Decimal } from 'longport';
import type { GlobalConfig } from '../../../types/config.js';
import type { OrderMonitorConfig } from '../types.js';
import {
  DEFAULT_PRICE_DECIMALS,
  ORDER_PRICE_DIFF_THRESHOLD,
  PENDING_ORDER_STATUSES,
} from '../../../constants/index.js';
import { isRecord } from '../../../utils/primitives/index.js';
import { toDecimal } from '../utils.js';

/**
 * 根据订单方向和席位方向解析信号动作。
 *
 * @param side 订单方向
 * @param isLongSymbol 是否为做多标的
 * @returns 对应的信号动作
 */
export function resolveSignalAction(
  side: OrderSide,
  isLongSymbol: boolean,
): 'BUYCALL' | 'BUYPUT' | 'SELLCALL' | 'SELLPUT' {
  if (side === OrderSide.Buy) {
    return isLongSymbol ? 'BUYCALL' : 'BUYPUT';
  }
  return isLongSymbol ? 'SELLCALL' : 'SELLPUT';
}

/**
 * 构建订单监控配置（秒转毫秒）。
 *
 * @param globalConfig 全局配置
 * @returns 订单监控配置
 */
export function buildOrderMonitorConfig(globalConfig: GlobalConfig): OrderMonitorConfig {
  return {
    buyTimeout: {
      enabled: globalConfig.buyOrderTimeout.enabled,
      timeoutMs: globalConfig.buyOrderTimeout.timeoutSeconds * 1000,
    },
    sellTimeout: {
      enabled: globalConfig.sellOrderTimeout.enabled,
      timeoutMs: globalConfig.sellOrderTimeout.timeoutSeconds * 1000,
    },
    priceUpdateIntervalMs: globalConfig.orderMonitorPriceUpdateInterval * 1000,
    priceDiffThreshold: ORDER_PRICE_DIFF_THRESHOLD,
  };
}

/**
 * 解析 updatedAt 为毫秒时间戳。
 *
 * @param updatedAt 更新时间字段
 * @returns 毫秒时间戳，无法解析时返回 null
 */
export function resolveUpdatedAtMs(updatedAt: unknown): number | null {
  if (updatedAt instanceof Date) {
    return updatedAt.getTime();
  }
  if (typeof updatedAt === 'number') {
    return updatedAt;
  }
  if (typeof updatedAt === 'string' && updatedAt.trim()) {
    const parsed = Date.parse(updatedAt);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * 解析 submittedAt 为毫秒时间戳。
 *
 * @param submittedAt 提交时间字段
 * @returns 毫秒时间戳，无法解析时返回 null
 */
export function resolveSubmittedAtMs(submittedAt: unknown): number | null {
  if (submittedAt instanceof Date) {
    return submittedAt.getTime();
  }
  if (typeof submittedAt === 'number') {
    return submittedAt;
  }
  if (typeof submittedAt === 'string' && submittedAt.trim()) {
    const parsed = Date.parse(submittedAt);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * 判断订单状态是否已关闭。
 *
 * @param status 订单状态
 * @returns true 表示成交/撤销/拒绝
 */
export function isClosedStatus(status: OrderStatus): boolean {
  return (
    status === OrderStatus.Filled ||
    status === OrderStatus.Canceled ||
    status === OrderStatus.Rejected
  );
}

/**
 * 解析追踪订单初始状态。
 * 默认行为：缺失或非 pending 状态回退为 New。
 *
 * @param initialStatus 可选初始状态
 * @returns 追踪状态
 */
export function resolveInitialTrackedStatus(initialStatus?: OrderStatus): OrderStatus {
  if (initialStatus === undefined) {
    return OrderStatus.New;
  }
  if (!PENDING_ORDER_STATUSES.has(initialStatus)) {
    return OrderStatus.New;
  }
  return initialStatus;
}

/**
 * 从 submitOrder 响应中提取 orderId。
 *
 * @param response 提交响应
 * @returns 订单 ID，缺失时返回 null
 */
export function resolveOrderIdFromSubmitResponse(response: unknown): string | null {
  if (!isRecord(response)) {
    return null;
  }
  const orderId = response['orderId'];
  return typeof orderId === 'string' && orderId.length > 0 ? orderId : null;
}

/**
 * 将价格标准化为固定小数位文本。
 *
 * @param price 原始价格
 * @returns 固定小数位文本
 */
export function normalizePriceText(price: number): string {
  return price.toFixed(DEFAULT_PRICE_DECIMALS);
}

/**
 * 计算价格差绝对值（Decimal）。
 *
 * @param currentPrice 当前价格
 * @param submittedPrice 委托价格
 * @returns 绝对价差 Decimal
 */
export function calculatePriceDiffDecimal(currentPrice: number, submittedPrice: number): Decimal {
  const currentPriceDecimal = toDecimal(currentPrice);
  const submittedPriceDecimal = toDecimal(submittedPrice);
  return currentPriceDecimal.sub(submittedPriceDecimal).abs();
}
