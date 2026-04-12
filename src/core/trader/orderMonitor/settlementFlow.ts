/**
 * orderMonitor 终态结算模块
 *
 * 职责：
 * - 对已确认终态订单执行唯一副作用结算
 * - 维护买卖记录与冷却链路更新
 * - 在缺少归属上下文时拒绝结算，避免错误记账
 */
import { OrderSide } from 'longbridge';
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import type { MonitorConfig } from '../../../types/config.js';
import type {
  OrderRecord,
  OrderRecorder,
  PostTradeConsistencyRefreshNeed,
} from '../../../types/services.js';
import type { TrackedOrder } from '../types.js';
import type {
  FinalizeOrderSettlementParams,
  FinalizeOrderSettlementResult,
  SettlementFlow,
  SettlementFlowDeps,
} from './types.js';
import { detachTrackedOrder } from './routingIndex.js';

function resolveOrderSideText(orderSide: OrderSide): 'BUY' | 'SELL' {
  return orderSide === OrderSide.Buy ? 'BUY' : 'SELL';
}

function resolveOrderSideFromText(side: 'BUY' | 'SELL'): OrderSide {
  return side === 'BUY' ? OrderSide.Buy : OrderSide.Sell;
}

function sortOrdersBySellPriority(orders: ReadonlyArray<OrderRecord>): ReadonlyArray<OrderRecord> {
  return [...orders].sort((left, right) => {
    if (left.executedPrice !== right.executedPrice) {
      return left.executedPrice - right.executedPrice;
    }

    if (left.executedTime !== right.executedTime) {
      return left.executedTime - right.executedTime;
    }

    return left.orderId.localeCompare(right.orderId);
  });
}

function resolveExactFilledRelatedBuyOrderIds(params: {
  readonly orderRecorder: OrderRecorder;
  readonly symbol: string;
  readonly isLongSymbol: boolean;
  readonly relatedBuyOrderIds: ReadonlyArray<string>;
  readonly filledQuantity: number;
}): ReadonlyArray<string> | null {
  const { orderRecorder, symbol, isLongSymbol, relatedBuyOrderIds, filledQuantity } = params;
  if (relatedBuyOrderIds.length === 0 || !isValidPositiveNumber(filledQuantity)) {
    return null;
  }

  const relatedBuyOrderIdSet = new Set(relatedBuyOrderIds);
  const relatedBuyOrders = sortOrdersBySellPriority(
    orderRecorder
      .getBuyOrdersForSymbol(symbol, isLongSymbol)
      .filter((order) => relatedBuyOrderIdSet.has(order.orderId)),
  );
  if (relatedBuyOrders.length !== relatedBuyOrderIds.length) {
    return null;
  }

  const settledOrderIds: string[] = [];
  let matchedQuantity = 0;
  for (const order of relatedBuyOrders) {
    if (!isValidPositiveNumber(order.executedQuantity)) {
      return null;
    }

    matchedQuantity += order.executedQuantity;
    if (matchedQuantity > filledQuantity) {
      return null;
    }

    settledOrderIds.push(order.orderId);
    if (matchedQuantity === filledQuantity) {
      return settledOrderIds;
    }
  }

  return null;
}

function settleSellExecutedPart(params: {
  readonly orderRecorder: OrderRecorder;
  readonly orderId: string;
  readonly symbol: string;
  readonly isLongSymbol: boolean;
  readonly executedPrice: number | null;
  readonly executedQuantity: number | null;
  readonly executedTimeMs: number | null;
  readonly relatedBuyOrderIds: ReadonlyArray<string>;
}): {
  readonly remainingRelatedBuyOrderIds: ReadonlyArray<string> | null;
} {
  const {
    orderRecorder,
    orderId,
    symbol,
    isLongSymbol,
    executedPrice,
    executedQuantity,
    executedTimeMs,
    relatedBuyOrderIds,
  } = params;
  if (
    !isValidPositiveNumber(executedPrice) ||
    !isValidPositiveNumber(executedQuantity) ||
    !isValidPositiveNumber(executedTimeMs)
  ) {
    return {
      remainingRelatedBuyOrderIds: relatedBuyOrderIds.length > 0 ? relatedBuyOrderIds : null,
    };
  }

  const settledRelatedBuyOrderIds = resolveExactFilledRelatedBuyOrderIds({
    orderRecorder,
    symbol,
    isLongSymbol,
    relatedBuyOrderIds,
    filledQuantity: executedQuantity,
  });
  orderRecorder.recordLocalSell(
    symbol,
    executedPrice,
    executedQuantity,
    isLongSymbol,
    executedTimeMs,
    orderId,
    settledRelatedBuyOrderIds,
  );

  if (settledRelatedBuyOrderIds === null) {
    return {
      remainingRelatedBuyOrderIds: null,
    };
  }

  const currentBuyOrderIdSet = new Set(
    orderRecorder.getBuyOrdersForSymbol(symbol, isLongSymbol).map((order) => order.orderId),
  );
  const settledOrderIdSet = new Set(settledRelatedBuyOrderIds);
  const remainingRelatedBuyOrderIds = relatedBuyOrderIds.filter(
    (relatedBuyOrderId) =>
      currentBuyOrderIdSet.has(relatedBuyOrderId) && !settledOrderIdSet.has(relatedBuyOrderId),
  );

  return {
    remainingRelatedBuyOrderIds:
      remainingRelatedBuyOrderIds.length > 0 ? remainingRelatedBuyOrderIds : null,
  };
}

function resolveCloseContext(params: {
  readonly trackedOrder: TrackedOrder | undefined;
  readonly closeParams: FinalizeOrderSettlementParams;
}): {
  readonly side: 'BUY' | 'SELL' | null;
  readonly symbol: string | null;
  readonly monitorSymbol: string | null;
  readonly isLongSymbol: boolean | undefined;
  readonly isProtectiveLiquidation: boolean;
  readonly liquidationTriggerLimit: number;
  readonly liquidationCooldownConfig: MonitorConfig['liquidationCooldown'];
  readonly executedPrice: number | null;
  readonly executedQuantity: number | null;
  readonly executedTimeMs: number | null;
} {
  const { trackedOrder, closeParams } = params;
  const side = closeParams.side ?? (trackedOrder ? resolveOrderSideText(trackedOrder.side) : null);
  return {
    side,
    symbol: trackedOrder?.symbol ?? closeParams.symbol ?? null,
    monitorSymbol: trackedOrder?.monitorSymbol ?? closeParams.monitorSymbol ?? null,
    isLongSymbol: trackedOrder?.isLongSymbol ?? closeParams.isLongSymbol,
    isProtectiveLiquidation:
      trackedOrder?.isProtectiveLiquidation ?? closeParams.isProtectiveLiquidation ?? false,
    liquidationTriggerLimit:
      trackedOrder?.liquidationTriggerLimit ?? closeParams.liquidationTriggerLimit ?? 1,
    liquidationCooldownConfig:
      trackedOrder?.liquidationCooldownConfig ?? closeParams.liquidationCooldownConfig ?? null,
    executedPrice: closeParams.executedPrice ?? trackedOrder?.executedPrice ?? null,
    executedQuantity: closeParams.executedQuantity ?? trackedOrder?.executedQuantity ?? null,
    executedTimeMs: closeParams.executedTimeMs ?? trackedOrder?.lastExecutedTimeMs ?? null,
  };
}

function resolveRecordedExecution(params: {
  readonly executedPrice: number | null;
  readonly executedQuantity: number | null;
  readonly executedTimeMs: number | null;
}): {
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTimeMs: number;
} | null {
  if (
    !isValidPositiveNumber(params.executedPrice) ||
    !isValidPositiveNumber(params.executedQuantity) ||
    !isValidPositiveNumber(params.executedTimeMs)
  ) {
    return null;
  }

  return {
    executedPrice: params.executedPrice,
    executedQuantity: params.executedQuantity,
    executedTimeMs: params.executedTimeMs,
  };
}

function hasExecutionAttributionContext(params: {
  readonly side: 'BUY' | 'SELL' | null;
  readonly symbol: string | null;
  readonly isLongSymbol: boolean | undefined;
}): boolean {
  const { side, symbol, isLongSymbol } = params;
  return side !== null && symbol !== null && isLongSymbol !== undefined;
}

function reserveFollowUpSellOccupancy(params: {
  readonly orderRecorder: OrderRecorder;
  readonly orderId: string;
  readonly symbol: string;
  readonly isLongSymbol: boolean;
  readonly followUpQuantity: number;
  readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
}): ReadonlyArray<string> {
  const { orderRecorder, orderId, symbol, isLongSymbol, followUpQuantity, relatedBuyOrderIds } =
    params;
  const direction: 'LONG' | 'SHORT' = isLongSymbol ? 'LONG' : 'SHORT';
  const resolvedRelatedBuyOrderIds =
    relatedBuyOrderIds ??
    orderRecorder.allocateRelatedBuyOrderIdsForRecovery(symbol, direction, followUpQuantity);
  orderRecorder.submitSellOrder(
    orderId,
    symbol,
    direction,
    followUpQuantity,
    resolvedRelatedBuyOrderIds,
  );

  return resolvedRelatedBuyOrderIds;
}

/**
 * 新终态结算流程：只处理已确认终态，不做终态推理。
 */
export function createSettlementFlow(deps: SettlementFlowDeps): SettlementFlow {
  const {
    runtime,
    orderHoldRegistry,
    orderRecorder,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    postTradeConsistencyRuntime,
    emitOrderStateChanged,
  } = deps;

  /**
   * 清理订单运行态，并在删除 tracked order 前基于 symbol 释放 routing index。
   *
   * @param orderId 订单 ID
   * @returns 无返回值
   */
  function clearRuntimeTracking(orderId: string): void {
    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (trackedOrder) {
      detachTrackedOrder(runtime, trackedOrder.symbol, orderId);
    }

    runtime.trackedOrders.delete(orderId);
    runtime.trackedOrderLifecycles.set(orderId, 'CLOSED');
    orderHoldRegistry.markOrderClosed(orderId);
  }

  function markPostTradeRefresh(): void {
    const refreshNeed: PostTradeConsistencyRefreshNeed = {
      refreshAccount: true,
      refreshPositions: true,
    };
    postTradeConsistencyRuntime.recordSettlementRefreshNeed(refreshNeed);
  }

  function recordDailyLossAndEpisodeProgress(params: {
    readonly orderId: string;
    readonly side: 'BUY' | 'SELL';
    readonly monitorSymbol: string | null;
    readonly symbol: string | null;
    readonly isLongSymbol: boolean | undefined;
    readonly isProtectiveLiquidation: boolean;
    readonly executedPrice: number | null;
    readonly executedQuantity: number | null;
    readonly executedTimeMs: number | null;
  }): void {
    const {
      orderId,
      side,
      monitorSymbol,
      symbol,
      isLongSymbol,
      isProtectiveLiquidation,
      executedPrice,
      executedQuantity,
      executedTimeMs,
    } = params;
    if (
      !monitorSymbol ||
      !symbol ||
      isLongSymbol === undefined ||
      !isValidPositiveNumber(executedPrice) ||
      !isValidPositiveNumber(executedQuantity) ||
      !isValidPositiveNumber(executedTimeMs)
    ) {
      return;
    }

    const orderSide = resolveOrderSideFromText(side);
    dailyLossTracker.recordFilledOrder({
      monitorSymbol,
      symbol,
      isLongSymbol,
      side: orderSide,
      executedPrice,
      executedQuantity,
      executedTimeMs,
      orderId,
    });

    if (isProtectiveLiquidation && orderSide === OrderSide.Sell) {
      const direction = isLongSymbol ? 'LONG' : 'SHORT';
      protectiveLiquidationEpisodeTracker.recordProtectiveFillProgress({
        monitorSymbol,
        direction,
        symbol,
        executedTimeMs,
      });
    }
  }

  function settleOrder(params: FinalizeOrderSettlementParams): FinalizeOrderSettlementResult {
    const { orderId, closedReason } = params;
    if (runtime.closedOrderIds.has(orderId)) {
      return {
        handled: false,
        relatedBuyOrderIds: null,
      };
    }

    const trackedOrder = runtime.trackedOrders.get(orderId);
    const context = resolveCloseContext({
      trackedOrder,
      closeParams: params,
    });
    const side = context.side;
    const symbol = context.symbol;
    const isLongSymbol = context.isLongSymbol;
    const executedPrice = context.executedPrice;
    const executedQuantity = context.executedQuantity;
    const executedTimeMs = context.executedTimeMs;
    const recordedExecution = resolveRecordedExecution({
      executedPrice,
      executedQuantity,
      executedTimeMs,
    });
    const executionContextReady = hasExecutionAttributionContext({
      side,
      symbol,
      isLongSymbol,
    });
    const pendingSellDisposition = params.pendingSellDisposition ?? {
      kind: 'RELEASE',
    };
    if (recordedExecution !== null && !executionContextReady) {
      return {
        handled: false,
        relatedBuyOrderIds: null,
      };
    }

    let relatedBuyOrderIds: ReadonlyArray<string> | null = null;

    if (closedReason === 'FILLED') {
      if (
        !symbol ||
        !side ||
        isLongSymbol === undefined ||
        !isValidPositiveNumber(executedPrice) ||
        !isValidPositiveNumber(executedQuantity) ||
        !isValidPositiveNumber(executedTimeMs)
      ) {
        return {
          handled: false,
          relatedBuyOrderIds: null,
        };
      }

      const orderSide = resolveOrderSideFromText(side);
      if (orderSide === OrderSide.Buy) {
        orderRecorder.recordLocalBuy(
          symbol,
          executedPrice,
          executedQuantity,
          isLongSymbol,
          executedTimeMs,
        );
      } else {
        const filledSell = orderRecorder.markSellFilled(orderId);
        const settledSell = settleSellExecutedPart({
          orderRecorder,
          orderId,
          symbol,
          isLongSymbol,
          executedPrice,
          executedQuantity,
          executedTimeMs,
          relatedBuyOrderIds: filledSell?.relatedBuyOrderIds ?? [],
        });
        relatedBuyOrderIds = settledSell.remainingRelatedBuyOrderIds;
      }

      recordDailyLossAndEpisodeProgress({
        orderId,
        side,
        monitorSymbol: context.monitorSymbol,
        symbol,
        isLongSymbol,
        isProtectiveLiquidation: context.isProtectiveLiquidation,
        executedPrice,
        executedQuantity,
        executedTimeMs,
      });

      markPostTradeRefresh();
    }

    if (closedReason === 'CANCELED' || closedReason === 'REJECTED') {
      if (side === 'SELL') {
        const cancelledSell = orderRecorder.markSellCancelled(orderId);
        const cancelledRelatedBuyOrderIds = cancelledSell?.relatedBuyOrderIds ?? [];
        if (symbol && isLongSymbol !== undefined) {
          const settledSell = settleSellExecutedPart({
            orderRecorder,
            orderId,
            symbol,
            isLongSymbol,
            executedPrice,
            executedQuantity,
            executedTimeMs,
            relatedBuyOrderIds: cancelledRelatedBuyOrderIds,
          });
          relatedBuyOrderIds = settledSell.remainingRelatedBuyOrderIds;
        } else {
          relatedBuyOrderIds =
            cancelledRelatedBuyOrderIds.length > 0 ? cancelledRelatedBuyOrderIds : null;
        }

        if (
          pendingSellDisposition.kind === 'HANDOFF_TO_FOLLOW_UP_SELL' &&
          symbol &&
          isLongSymbol !== undefined &&
          isValidPositiveNumber(pendingSellDisposition.followUpQuantity)
        ) {
          relatedBuyOrderIds = reserveFollowUpSellOccupancy({
            orderRecorder,
            orderId,
            symbol,
            isLongSymbol,
            followUpQuantity: pendingSellDisposition.followUpQuantity,
            relatedBuyOrderIds,
          });
        }
      }

      if (side === 'BUY' && symbol && isLongSymbol !== undefined && recordedExecution !== null) {
        orderRecorder.recordLocalBuy(
          symbol,
          recordedExecution.executedPrice,
          recordedExecution.executedQuantity,
          isLongSymbol,
          recordedExecution.executedTimeMs,
        );
      }

      if (symbol && side && isLongSymbol !== undefined && recordedExecution !== null) {
        recordDailyLossAndEpisodeProgress({
          orderId,
          side,
          monitorSymbol: context.monitorSymbol,
          symbol,
          isLongSymbol,
          isProtectiveLiquidation: context.isProtectiveLiquidation,
          executedPrice: recordedExecution.executedPrice,
          executedQuantity: recordedExecution.executedQuantity,
          executedTimeMs: recordedExecution.executedTimeMs,
        });

        markPostTradeRefresh();
      }
    }

    runtime.closedOrderIds.add(orderId);
    clearRuntimeTracking(orderId);
    emitOrderStateChanged({
      orderId,
      symbol,
      side,
      source: params.source,
      status: closedReason,
      monitorSymbol: context.monitorSymbol,
      isLongSymbol: isLongSymbol ?? null,
      isProtectiveLiquidation: context.isProtectiveLiquidation,
      executedPrice,
      executedQuantity,
      executedTimeMs,
    });
    return {
      handled: true,
      relatedBuyOrderIds,
    };
  }

  return {
    settleOrder,
  };
}
