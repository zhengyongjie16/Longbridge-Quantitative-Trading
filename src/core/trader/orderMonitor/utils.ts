import { OrderSide, OrderStatus, type Decimal } from 'longport';
import type { GlobalConfig } from '../../../types/config.js';
import type { OrderClosedReason, OrderMonitorConfig } from '../types.js';
import {
  DEFAULT_PRICE_DECIMALS,
  ORDER_ALREADY_FILLED_ERROR_CODE_SET,
  ORDER_CANCEL_CONFIRMED_ERROR_CODE_SET,
  ORDER_CLOSED_ERROR_CODE_SET,
  ORDER_NOT_FOUND_ERROR_CODE_SET,
  ORDER_PRICE_DIFF_THRESHOLD,
  PENDING_ORDER_STATUSES,
  REPLACE_TEMP_BLOCKED_BY_STATUS_ERROR_CODE_SET,
  REPLACE_UNSUPPORTED_BY_TYPE_ERROR_CODE_SET,
} from '../../../constants/index.js';
import type {
  OrderClosedErrorCode,
  ReplaceTempBlockedErrorCode,
  ReplaceUnsupportedByTypeErrorCode,
} from './types.js';
import { isRecord } from '../../../utils/primitives/index.js';
import { toDecimal } from '../utils.js';
import { logger } from '../../../utils/logger/index.js';

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

/**
 * 判断错误码是否为"订单已关闭"类错误
 *
 * @param code - 错误码字符串
 * @returns 是否为订单已关闭错误码
 */
function isOrderClosedErrorCode(code: string): code is OrderClosedErrorCode {
  return ORDER_CLOSED_ERROR_CODE_SET.has(code as OrderClosedErrorCode);
}

/**
 * 判断错误码是否为"不支持改单"类错误
 *
 * @param code - 错误码字符串
 * @returns 是否为不支持改单错误码
 */
function isReplaceUnsupportedByTypeErrorCode(code: string): code is ReplaceUnsupportedByTypeErrorCode {
  return REPLACE_UNSUPPORTED_BY_TYPE_ERROR_CODE_SET.has(code as ReplaceUnsupportedByTypeErrorCode);
}

/**
 * 判断错误码是否为"订单状态暂不允许改单"类错误
 *
 * @param code - 错误码字符串
 * @returns 是否为状态暂不允许改单错误码
 */
function isReplaceTempBlockedErrorCode(code: string): code is ReplaceTempBlockedErrorCode {
  return REPLACE_TEMP_BLOCKED_BY_STATUS_ERROR_CODE_SET.has(code as ReplaceTempBlockedErrorCode);
}

/**
 * 从对象字段中提取错误码。
 *
 * @param value 任意对象值
 * @returns 错误码，提取失败返回 null
 */
function extractErrorCodeFromRecord(value: Record<string, unknown>): string | null {
  const codeKeys = ['code', 'errorCode', 'errno'];
  for (const key of codeKeys) {
    const rawValue = value[key];
    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      if (/^\d+$/.test(trimmed)) {
        return trimmed;
      }
    }

    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      return String(Math.trunc(rawValue));
    }
  }
  return null;
}

/**
 * 从错误对象中提取错误码。
 * 优先级：结构化字段（code/errorCode/errno）> 嵌套 cause/error > message 文本。
 *
 * @param err 错误对象
 * @param depth 递归深度（内部使用）
 * @returns 错误码字符串，提取失败返回 null
 */
export function extractErrorCode(err: unknown, depth: number = 0): string | null {
  if (depth > 2 || !isRecord(err)) {
    return null;
  }
  const directCode = extractErrorCodeFromRecord(err);
  if (directCode !== null) {
    return directCode;
  }

  const nestedKeys = ['cause', 'error'];
  for (const key of nestedKeys) {
    const nested = err[key];
    if (isRecord(nested)) {
      const nestedCode = extractErrorCode(nested, depth + 1);
      if (nestedCode !== null) {
        return nestedCode;
      }
    }
  }

  const message = err['message'];
  if (typeof message !== 'string') {
    return null;
  }

  const codeRegex = /code=(\d+)/;
  const codeMatch = codeRegex.exec(message);
  if (codeMatch?.[1]) {
    return codeMatch[1];
  }

  const fallbackSixDigitsRegex = /\b(\d{6})\b/;
  const fallbackMatch = fallbackSixDigitsRegex.exec(message);
  if (fallbackMatch?.[1]) {
    return fallbackMatch[1];
  }

  logger.debug(`[错误码提取] 无法从错误消息中提取错误码: ${message}`);

  return null;
}

/**
 * 从错误对象中提取错误消息。
 *
 * @param err 错误对象
 * @returns 错误消息文本
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  if (isRecord(err)) {
    const message = err['message'];
    if (typeof message === 'string') {
      return message;
    }
  }
  return String(err);
}

/**
 * 解析订单关闭原因（基于错误码）。
 *
 * @param err 错误对象
 * @returns 关闭原因，无法解析返回 null
 */
export function resolveOrderClosedReasonFromError(err: unknown): OrderClosedReason | null {
  const code = extractErrorCode(err);
  if (code === null || !isOrderClosedErrorCode(code)) {
    return null;
  }

  if (ORDER_CANCEL_CONFIRMED_ERROR_CODE_SET.has(code)) {
    if (code === '601013') {
      return 'REJECTED';
    }
    return 'CANCELED';
  }

  if (ORDER_ALREADY_FILLED_ERROR_CODE_SET.has(code)) {
    return 'FILLED';
  }

  if (ORDER_NOT_FOUND_ERROR_CODE_SET.has(code)) {
    return 'NOT_FOUND';
  }

  return null;
}

/**
 * 判断是否为可重试撤单失败。
 *
 * @param err 错误对象
 * @returns true 表示可重试
 */
export function isRetryableCancelError(err: unknown): boolean {
  const message = extractErrorMessage(err).toLowerCase();
  const retryableHints = [
    'network',
    'timeout',
    'timed out',
    'temporarily unavailable',
    'connection',
    'econnreset',
    'etimedout',
    '429',
    'rate limit',
  ];
  return retryableHints.some((hint) => message.includes(hint));
}

/**
 * 判断是否为"不支持改单（订单类型）"错误。
 *
 * @param err 错误对象
 * @returns 是否为类型不支持改单错误
 */
export function isReplaceUnsupportedByTypeError(err: unknown): boolean {
  const code = extractErrorCode(err);
  return code !== null && isReplaceUnsupportedByTypeErrorCode(code);
}

/**
 * 判断是否为"状态暂不允许改单"错误。
 *
 * @param err 错误对象
 * @returns 是否为状态暂时阻塞改单错误
 */
export function isReplaceTempBlockedError(err: unknown): boolean {
  const code = extractErrorCode(err);
  return code !== null && isReplaceTempBlockedErrorCode(code);
}
