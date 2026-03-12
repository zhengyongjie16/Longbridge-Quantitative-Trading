/**
 * orderMonitor 单订单状态查询模块
 *
 * 职责：
 * - 在撤单/改单 API 业务失败后调用 orderDetail 做权威确认
 * - 将 Longbridge 原始订单状态映射为统一 OrderStateCheckResult
 * - 区分终态、仍开放状态与查询失败原因
 */
import { decimalToNumber } from '../../../utils/helpers/index.js';
import type { OrderStateCheckResult } from '../../../types/trader.js';
import type { OrderStatusQuery, OrderStatusQueryDeps } from './types.js';
import { extractErrorCode, extractErrorMessage, resolveUpdatedAtMs } from './utils.js';

const OPEN_API_ORDER_STATUS_FILLED = 5;
const OPEN_API_ORDER_STATUS_REJECTED = 14;
const OPEN_API_ORDER_STATUS_CANCELED = 15;
const OPEN_API_ORDER_STATUS_EXPIRED = 16;
const OPEN_API_ORDER_STATUS_PARTIAL_WITHDRAWAL = 17;

function resolveClosedReasonFromStatus(
  status: number,
): Extract<OrderStateCheckResult, { kind: 'TERMINAL' }>['closedReason'] | null {
  if (status === OPEN_API_ORDER_STATUS_FILLED) {
    return 'FILLED';
  }

  if (
    status === OPEN_API_ORDER_STATUS_CANCELED ||
    status === OPEN_API_ORDER_STATUS_EXPIRED ||
    status === OPEN_API_ORDER_STATUS_PARTIAL_WITHDRAWAL
  ) {
    return 'CANCELED';
  }

  if (status === OPEN_API_ORDER_STATUS_REJECTED) {
    return 'REJECTED';
  }

  return null;
}

/**
 * 单订单权威状态查询：仅用于撤单/改单 API 业务失败后的确认。
 */
export function createOrderStatusQuery(deps: OrderStatusQueryDeps): OrderStatusQuery {
  const { ctxPromise, rateLimiter } = deps;

  async function checkOrderState(orderId: string): Promise<OrderStateCheckResult> {
    try {
      await rateLimiter.throttle();
      const ctx = await ctxPromise;
      const detail = await ctx.orderDetail(orderId);
      const status = detail.status;
      const executedPriceNumber = decimalToNumber(detail.executedPrice);
      const executedQuantityNumber = decimalToNumber(detail.executedQuantity);
      const executedPrice = Number.isFinite(executedPriceNumber) ? executedPriceNumber : null;
      const executedQuantity = Number.isFinite(executedQuantityNumber)
        ? executedQuantityNumber
        : null;
      const updatedAtMs = resolveUpdatedAtMs(detail.updatedAt);
      const closedReason = resolveClosedReasonFromStatus(status);
      if (closedReason !== null) {
        return {
          kind: 'TERMINAL',
          closedReason,
          status,
          executedPrice,
          executedQuantity,
          executedTimeMs: updatedAtMs,
        };
      }

      return {
        kind: 'OPEN',
        status,
        executedPrice,
        executedQuantity,
        updatedAtMs,
      };
    } catch (error) {
      const errorCode = extractErrorCode(error);
      return {
        kind: 'QUERY_FAILED',
        reason: errorCode === '603001' ? 'NOT_FOUND' : 'API_ERROR',
        errorCode,
        message: extractErrorMessage(error),
      };
    }
  }

  return {
    checkOrderState,
  };
}
