import { NON_REPLACEABLE_ORDER_STATUSES, NON_REPLACEABLE_ORDER_TYPES } from '../../../constants/index.js';
import type { PendingSellOrderSnapshot } from '../types.js';
import type { SellMergeDecision, SellMergeDecisionInput } from './types.js';

function resolveRemainingQuantity(order: PendingSellOrderSnapshot): number {
  const remaining = order.submittedQuantity - order.executedQuantity;
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
}

export function resolveSellMergeDecision(
  input: SellMergeDecisionInput,
): SellMergeDecision {
  const normalized = input.pendingOrders
    .map((order) => ({
      order,
      remaining: resolveRemainingQuantity(order),
    }))
    .filter((item) => item.remaining > 0);

  const pendingOrderIds = normalized.map((item) => item.order.orderId);
  const pendingRemainingQuantity = normalized.reduce(
    (sum, item) => sum + item.remaining,
    0,
  );

  if (!Number.isFinite(input.newOrderQuantity) || input.newOrderQuantity <= 0) {
    return {
      action: 'SKIP',
      mergedQuantity: pendingRemainingQuantity,
      targetOrderId: null,
      price: null,
      pendingOrderIds,
      pendingRemainingQuantity,
      reason: 'no-additional-quantity',
    };
  }

  if (pendingRemainingQuantity <= 0) {
    return {
      action: 'SUBMIT',
      mergedQuantity: input.newOrderQuantity,
      targetOrderId: null,
      price: input.newOrderPrice,
      pendingOrderIds,
      pendingRemainingQuantity,
      reason: 'no-pending-sell',
    };
  }

  const mergedQuantity = pendingRemainingQuantity + input.newOrderQuantity;
  const hasMultiple = normalized.length > 1;
  const hasTypeMismatch = normalized.some(
    (item) => item.order.orderType !== input.newOrderType,
  );
  const hasNonReplaceableStatus = normalized.some((item) =>
    NON_REPLACEABLE_ORDER_STATUSES.has(item.order.status),
  );
  const hasNonReplaceableType = normalized.some((item) =>
    NON_REPLACEABLE_ORDER_TYPES.has(item.order.orderType),
  );

  if (
    input.isProtectiveLiquidation ||
    hasMultiple ||
    hasTypeMismatch ||
    hasNonReplaceableStatus ||
    hasNonReplaceableType
  ) {
    return {
      action: 'CANCEL_AND_SUBMIT',
      mergedQuantity,
      targetOrderId: null,
      price: input.newOrderPrice,
      pendingOrderIds,
      pendingRemainingQuantity,
      reason: 'cancel-and-merge',
    };
  }

  return {
    action: 'REPLACE',
    mergedQuantity,
    targetOrderId: normalized[0]?.order.orderId ?? null,
    price: input.newOrderPrice ?? normalized[0]?.order.submittedPrice ?? null,
    pendingOrderIds,
    pendingRemainingQuantity,
    reason: 'replace-and-merge',
  };
}
