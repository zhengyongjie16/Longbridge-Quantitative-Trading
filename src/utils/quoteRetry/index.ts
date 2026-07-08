import { ORDER_QUOTE_RETRY } from '../../constants/index.js';
import type {
  IsQuoteReadyForRequirementParams,
  QuoteReadinessStatus,
  ResolveNextQuoteRetryParams,
  ResolveNextQuoteRetryResult,
} from './types.js';

/**
 * 解析 quote 是否满足指定动作的就绪要求。
 * @param params quote 与字段要求
 * @returns quote 就绪性分类
 */
export function resolveQuoteReadinessForRequirement(
  params: IsQuoteReadyForRequirementParams,
): QuoteReadinessStatus {
  const { quote, requirement } = params;
  if (!quote) {
    return 'MISSING';
  }

  if (!Number.isFinite(quote.price) || quote.price <= 0) {
    return 'INVALID_PRICE';
  }

  if (requirement === 'PRICE') {
    return 'READY';
  }

  const lotSize = quote.lotSize;
  if (lotSize === undefined) {
    return 'MISSING_LOT_SIZE';
  }

  if (!Number.isFinite(lotSize) || lotSize <= 0) {
    return 'INVALID_LOT_SIZE';
  }

  return 'READY';
}

/**
 * 计算下一次 quote retry 的推进状态。
 * @param params 已执行重试次数、当前时间以及可选配置
 * @returns 下一次重试的次数、时间与是否耗尽
 */
export function resolveNextQuoteRetry(
  params: ResolveNextQuoteRetryParams,
): ResolveNextQuoteRetryResult {
  const intervalMs = params.intervalMs ?? ORDER_QUOTE_RETRY.INTERVAL_MS;
  const maxAttempts = params.maxAttempts ?? ORDER_QUOTE_RETRY.MAX_ATTEMPTS;
  const nextAttempts = params.attempts + 1;
  const exhausted = nextAttempts > maxAttempts;
  return {
    nextAttempts,
    nextRetryAt: exhausted ? null : params.nowMs + intervalMs,
    exhausted,
  };
}
