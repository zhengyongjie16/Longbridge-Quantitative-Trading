import { OrderStatus, type Decimal } from 'longbridge';
import type { GlobalConfig } from '../../../types/config.js';
import type { OrderClosedReason } from '../../../types/trader.js';
import type { OrderMonitorConfig, TrackedOrder } from '../types.js';
import {
  DEFAULT_PRICE_DECIMALS,
  ORDER_CLOSED_ERROR_CODE_SET,
  ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
  ORDER_PRICE_DIFF_THRESHOLD,
  ORDER_API_RETRYABLE_MESSAGE_HINTS,
  ORDER_API_TRANSIENT_STATUS_CODE_SET,
  PENDING_ORDER_STATUSES,
  REPLACE_TEMP_BLOCKED_BY_STATUS_ERROR_CODE_SET,
  REPLACE_UNSUPPORTED_BY_TYPE_ERROR_CODE_SET,
} from '../../../constants/index.js';
import type {
  OrderClosedErrorCode,
  ReplaceTempBlockedErrorCode,
  ReplaceUnsupportedByTypeErrorCode,
} from './types.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { toDecimal } from '../utils.js';
import { logger } from '../../../utils/logger/index.js';

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
    allowBuyOrderTrackingAboveInitialPrice: globalConfig.allowBuyOrderTrackingAboveInitialPrice,
  };
}

/**
 * 将时间字段解析为毫秒时间戳。
 *
 * @param value 时间字段
 * @returns 毫秒时间戳，无法解析时返回 null
 */
function resolveTimeMs(value: unknown): number | null {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

/**
 * 解析 updatedAt 为毫秒时间戳。
 *
 * @param updatedAt 更新时间字段
 * @returns 毫秒时间戳，无法解析时返回 null
 */
export function resolveUpdatedAtMs(updatedAt: unknown): number | null {
  return resolveTimeMs(updatedAt);
}

/**
 * 解析 submittedAt 为毫秒时间戳。
 *
 * @param submittedAt 提交时间字段
 * @returns 毫秒时间戳，无法解析时返回 null
 */
export function resolveSubmittedAtMs(submittedAt: unknown): number | null {
  return resolveTimeMs(submittedAt);
}

/**
 * 判断订单状态是否已关闭。
 *
 * @param status 订单状态
 * @returns true 表示订单处于关闭态（成交/撤销/拒绝/过期/部分撤单）
 */
export function isClosedStatus(status: OrderStatus): boolean {
  return (
    status === OrderStatus.Filled ||
    status === OrderStatus.Canceled ||
    status === OrderStatus.Rejected ||
    status === OrderStatus.Expired ||
    status === OrderStatus.PartialWithdrawal
  );
}

export function resolveOrderClosedReasonFromStatus(status: OrderStatus): OrderClosedReason | null {
  if (status === OrderStatus.Filled) {
    return 'FILLED';
  }

  if (
    status === OrderStatus.Canceled ||
    status === OrderStatus.Expired ||
    status === OrderStatus.PartialWithdrawal
  ) {
    return 'CANCELED';
  }

  if (status === OrderStatus.Rejected) {
    return 'REJECTED';
  }

  return null;
}

export function isWaitWsOnlyReplaceMode(
  order: Pick<TrackedOrder, 'replaceCapability' | 'replaceBlockedUntilAt'>,
): boolean {
  return (
    order.replaceCapability === 'TEMP_BLOCKED_BY_STATUS' &&
    order.replaceBlockedUntilAt === ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS
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
  return ORDER_CLOSED_ERROR_CODE_SET.has(code);
}

/**
 * 判断错误码是否为"不支持改单"类错误
 *
 * @param code - 错误码字符串
 * @returns 是否为不支持改单错误码
 */
function isReplaceUnsupportedByTypeErrorCode(
  code: string,
): code is ReplaceUnsupportedByTypeErrorCode {
  return REPLACE_UNSUPPORTED_BY_TYPE_ERROR_CODE_SET.has(code);
}

/**
 * 判断错误码是否为"订单状态暂不允许改单"类错误
 *
 * @param code - 错误码字符串
 * @returns 是否为状态暂不允许改单错误码
 */
function isReplaceTempBlockedErrorCode(code: string): code is ReplaceTempBlockedErrorCode {
  return REPLACE_TEMP_BLOCKED_BY_STATUS_ERROR_CODE_SET.has(code);
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

export function isOrderClosedBusinessError(err: unknown): boolean {
  const code = extractErrorCode(err);
  return code !== null && isOrderClosedErrorCode(code);
}

/**
 * 从对象字段中提取 HTTP 状态码。
 *
 * @param value 任意对象值
 * @returns 三位状态码，提取失败返回 null
 */
function extractStatusCodeFromRecord(value: Record<string, unknown>): string | null {
  const statusKeys = ['status', 'statusCode', 'httpStatus'] as const;
  for (const key of statusKeys) {
    const rawValue = value[key];
    if (typeof rawValue === 'string' && /^\d{3}$/.test(rawValue.trim())) {
      return rawValue.trim();
    }

    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      const normalized = String(Math.trunc(rawValue));
      if (/^\d{3}$/.test(normalized)) {
        return normalized;
      }
    }
  }

  return null;
}

/**
 * 从错误消息中提取显式 HTTP 状态码。
 *
 * @param message 错误消息文本
 * @returns 三位状态码，提取失败返回 null
 */
function extractStatusCodeFromMessage(message: string): string | null {
  const patterns = [/\bstatus(?:code)?[=:]\s*(\d{3})\b/i, /\bhttp\s+(\d{3})\b/i] as const;
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * 从错误对象中提取订单 API 状态码。
 *
 * @param err 错误对象
 * @param depth 递归深度（内部使用）
 * @returns 三位状态码，提取失败返回 null
 */
function extractOrderApiStatusCode(err: unknown, depth: number = 0): string | null {
  if (depth > 2 || !isRecord(err)) {
    return null;
  }

  const directStatusCode = extractStatusCodeFromRecord(err);
  if (directStatusCode !== null) {
    return directStatusCode;
  }

  const nestedKeys = ['cause', 'error'];
  for (const key of nestedKeys) {
    const nested = err[key];
    if (isRecord(nested)) {
      const nestedStatusCode = extractOrderApiStatusCode(nested, depth + 1);
      if (nestedStatusCode !== null) {
        return nestedStatusCode;
      }
    }
  }

  const message = err['message'];
  if (typeof message !== 'string') {
    return null;
  }

  return extractStatusCodeFromMessage(message);
}

/**
 * 判断是否为可重试订单 API 请求失败。
 *
 * @param err 错误对象
 * @returns true 表示可重试
 */
export function isRetryableOrderApiError(err: unknown): boolean {
  const statusCode = extractOrderApiStatusCode(err);
  if (statusCode !== null && ORDER_API_TRANSIENT_STATUS_CODE_SET.has(statusCode)) {
    return true;
  }

  const errorCode = extractErrorCode(err);
  if (errorCode !== null) {
    return ORDER_API_TRANSIENT_STATUS_CODE_SET.has(errorCode);
  }

  const message = extractErrorMessage(err).toLowerCase();
  return ORDER_API_RETRYABLE_MESSAGE_HINTS.some((hint) => message.includes(hint));
}

/**
 * 判断是否为可重试订单 mutation 请求失败。
 *
 * @param err 错误对象
 * @returns true 表示可重试
 */
export function isRetryableOrderMutationError(err: unknown): boolean {
  return isRetryableOrderApiError(err);
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
