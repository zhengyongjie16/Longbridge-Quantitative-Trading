import { API } from '../../constants/index.js';
import { formatError } from '../error/index.js';
import type {
  ExternalApiAggregateRequestErrorParams,
  ExternalApiRequestError,
  ExternalApiRequestErrorParams,
  ExternalApiRetryConfig,
  WrapExternalApiRequestParams,
} from './types.js';

const DEFAULT_EXTERNAL_API_RETRY_CONFIG: ExternalApiRetryConfig = {
  retries: API.DEFAULT_RETRY_COUNT,
  delayMs: API.DEFAULT_RETRY_DELAY_MS,
};
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
