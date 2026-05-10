import { API } from '../../constants/index.js';
import { formatError } from '../error/index.js';
import { isRecord } from '../helpers/index.js';
import type {
  ExternalApiAggregateRequestErrorParams,
  ExternalApiRequestError,
  ExternalApiRequestErrorParams,
  ExternalApiRetryConfig,
  ExternalApiRetryDecision,
  WrapExternalApiRequestParams,
} from './types.js';

const DEFAULT_EXTERNAL_API_RETRY_CONFIG: ExternalApiRetryConfig = {
  retries: API.DEFAULT_RETRY_COUNT,
  delayMs: API.DEFAULT_RETRY_DELAY_MS,
};
const TRANSIENT_STATUS_CODES = new Set(['408', '425', '429', '500', '502', '503', '504']);
const NON_RETRYABLE_MESSAGE_HINTS = [
  'invalid',
  'validation',
  'permission',
  'unauthorized',
  'forbidden',
  'unsupported',
  'not found',
  'no data',
  'business rejection',
] as const;
const RETRYABLE_MESSAGE_HINTS = [
  'network',
  'timeout',
  'timed out',
  'temporarily unavailable',
  'service unavailable',
  'service busy',
  'connection',
  'econnreset',
  'etimedout',
  'rate limit',
] as const;
const externalApiRequestErrors = new WeakSet<Error>();

/**
 * 创建外部 API 请求失败错误。
 *
 * @param params 外部 API 请求失败错误构造参数
 * @returns 携带 operation 与 attempts 的 Error 对象
 */
export function createExternalApiRequestError(
  params: ExternalApiRequestErrorParams,
): ExternalApiRequestError {
  const error = new Error(`[外部 API 请求失败] ${params.operation}: ${formatError(params.cause)}`, {
    cause: params.cause,
  });
  const externalApiError = Object.assign(error, {
    name: 'ExternalApiRequestError' as const,
    operation: params.operation,
    attempts: params.attempts,
  });
  externalApiRequestErrors.add(externalApiError);
  return externalApiError;
}

/**
 * 创建外部 API 聚合请求失败错误。
 *
 * @param params 外部 API 聚合请求失败错误构造参数
 * @returns 同时保留 AggregateError causes 与 ExternalApiRequestError 分类的错误对象
 */
export function createExternalApiAggregateRequestError(
  params: ExternalApiAggregateRequestErrorParams,
): ExternalApiRequestError {
  const error = new AggregateError(
    params.causes,
    `[外部 API 请求失败] ${params.operation}: ${params.causes.length} 个请求失败`,
  );
  const externalApiError = Object.assign(error, {
    name: 'ExternalApiRequestError' as const,
    operation: params.operation,
    attempts: params.attempts,
  });
  externalApiRequestErrors.add(externalApiError);
  return externalApiError;
}

/**
 * 判断错误是否为外部 API 请求失败。
 *
 * @param error 待判断错误对象
 * @returns true 表示错误来自真实外部 API 请求失败边界
 */
export function isExternalApiRequestError(error: unknown): error is ExternalApiRequestError {
  return (
    error instanceof Error &&
    externalApiRequestErrors.has(error) &&
    error.name === 'ExternalApiRequestError' &&
    'operation' in error &&
    typeof error.operation === 'string' &&
    error.operation.length > 0 &&
    'attempts' in error &&
    typeof error.attempts === 'number' &&
    Number.isInteger(error.attempts) &&
    error.attempts > 0
  );
}

/**
 * 判断错误列表是否全部为外部 API 请求失败。
 *
 * @param errors 待判断错误列表
 * @returns true 表示列表非空且所有错误均为 ExternalApiRequestError
 */
export function isAllExternalApiRequestErrors(
  errors: ReadonlyArray<unknown>,
): errors is ReadonlyArray<ExternalApiRequestError> {
  return errors.length > 0 && errors.every(isExternalApiRequestError);
}

/**
 * 等待指定毫秒数。
 *
 * @param delayMs 等待时长，单位毫秒
 * @returns 等待完成后的 Promise
 */
function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * 判断错误是否属于程序内部契约/不变量错误。
 *
 * 这类错误必须 fail-fast，不能降级为外部 API 失败重试或业务拒绝分支。
 *
 * @param error 待判断错误对象
 * @returns true 表示错误属于 TypeError、ContractError 或 InvariantError
 */
export function isProgramError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && (error.name === 'ContractError' || error.name === 'InvariantError'))
  );
}

/**
 * 从错误对象读取字符串或数字字段。
 *
 * @param error 待读取错误对象
 * @param key 字段名
 * @returns 可用于分类的字段文本
 */
function extractStringProperty(error: unknown, key: string): string | null {
  if (!isRecord(error)) {
    return null;
  }

  const value = error[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

/**
 * 从结构化错误字段读取 HTTP 状态码。
 *
 * @param error 待分类错误对象
 * @returns 三位状态码文本
 */
function extractNumericStatusText(error: unknown): string | null {
  const statusKeys = ['status', 'statusCode', 'httpStatus'] as const;
  for (const key of statusKeys) {
    const value = extractStringProperty(error, key);
    if (value !== null && /^\d{3}$/.test(value)) {
      return value;
    }
  }

  return null;
}

/**
 * 从错误消息中读取 HTTP 状态码。
 *
 * @param message 错误消息文本
 * @returns 三位状态码文本
 */
function extractStatusFromMessage(message: string): string | null {
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
 * 判断错误是否带有 Longbridge 业务错误码。
 *
 * @param error 待分类错误对象
 * @param message 错误消息文本
 * @returns true 表示结构化字段或消息包含六位业务 code
 */
function hasBusinessErrorCode(error: unknown, message: string): boolean {
  const structuredCodeKeys = ['code', 'errorCode', 'errno'] as const;
  for (const key of structuredCodeKeys) {
    const structuredCode = extractStringProperty(error, key);
    if (structuredCode !== null && /^\d{6}$/.test(structuredCode)) {
      return true;
    }
  }

  return /\b(?:code=)?\d{6}\b/i.test(message);
}

/**
 * 解析外部 API 错误的默认重试决策。
 *
 * @param error 待分类错误对象
 * @returns RETRY 表示允许有限重试，FAIL_FAST 表示立即抛出
 */
function resolveExternalApiRetryDecision(error: unknown): ExternalApiRetryDecision {
  if (isProgramError(error)) {
    return 'FAIL_FAST';
  }

  const message = formatError(error).toLowerCase();
  if (NON_RETRYABLE_MESSAGE_HINTS.some((hint) => message.includes(hint))) {
    return 'FAIL_FAST';
  }

  if (hasBusinessErrorCode(error, message)) {
    return 'FAIL_FAST';
  }

  const statusText = extractNumericStatusText(error) ?? extractStatusFromMessage(message);
  if (statusText !== null && TRANSIENT_STATUS_CODES.has(statusText)) {
    return 'RETRY';
  }

  if (RETRYABLE_MESSAGE_HINTS.some((hint) => message.includes(hint))) {
    return 'RETRY';
  }

  return 'FAIL_FAST';
}

/**
 * 判断外部 API 错误是否属于可重试暂态错误。
 *
 * @param error 待分类错误对象
 * @returns true 表示可进入有限重试
 */
export function isRetryableExternalApiError(error: unknown): boolean {
  return resolveExternalApiRetryDecision(error) === 'RETRY';
}

/**
 * 执行真实外部 API 请求，并在有限重试后将失败分类为 ExternalApiRequestError。
 *
 * @param params 外部 API 请求包装参数，包含操作名、请求函数与可选 retry 配置
 * @returns 外部 API 请求成功后的原始返回值
 */
export async function wrapExternalApiRequest<T>(
  params: WrapExternalApiRequestParams<T>,
): Promise<T> {
  const retryConfig = params.retryConfig ?? DEFAULT_EXTERNAL_API_RETRY_CONFIG;
  let lastError: unknown = null;
  const maxAttempts = retryConfig.retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await params.request();
    } catch (error) {
      if (isProgramError(error)) {
        throw error;
      }

      if (!isRetryableExternalApiError(error)) {
        throw error;
      }

      if (params.shouldRetry?.(error) === false) {
        throw error;
      }

      lastError = error;
      if (attempt < maxAttempts && retryConfig.delayMs > 0) {
        await wait(retryConfig.delayMs);
      }
    }
  }

  throw createExternalApiRequestError({
    operation: params.operation,
    attempts: maxAttempts,
    cause: lastError,
  });
}
