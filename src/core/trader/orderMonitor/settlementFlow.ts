/**
 * orderMonitor 终态结算模块
 *
 * 职责：
 * - 对已确认终态订单执行唯一副作用结算
 * - 维护买卖记录、tradeLogger 写入与冷却链路更新
 * - 在缺少归属上下文时拒绝结算，避免错误记账
 */
import { OrderSide } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { toHongKongTimeIso } from '../../../utils/time/index.js';
import { recordTrade } from '../tradeLogger.js';
import type { MonitorConfig } from '../../../types/config.js';
import type { OrderRecord, OrderRecorder } from '../../../types/services.js';
import type { TrackedOrder } from '../types.js';
import type {
  FinalizeOrderSettlementParams,
  FinalizeOrderSettlementResult,
  SettlementFlow,
  SettlementFlowDeps,
} from './types.js';
import { resolveSignalAction } from './utils.js';

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

/**
 * 新终态结算流程：只处理已确认终态，不做终态推理。
 */
export function createSettlementFlow(deps: SettlementFlowDeps): SettlementFlow {
  const {
    runtime,
    orderHoldRegistry,
    orderRecorder,
    dailyLossTracker,
    liquidationCooldownTracker,
    refreshGate,
  } = deps;

  function clearRuntimeTracking(orderId: string): void {
    runtime.trackedOrders.delete(orderId);
    runtime.trackedOrderLifecycles.set(orderId, 'CLOSED');
    orderHoldRegistry.markOrderClosed(orderId);
  }

  function markPostTradeRefresh(symbol: string, isLongSymbol: boolean): void {
    refreshGate?.markStale();
    runtime.pendingRefreshSymbols.push({
      symbol,
      isLongSymbol,
      refreshAccount: true,
      refreshPositions: true,
    });
  }

  function recordDailyLossAndCooldown(params: {
    readonly orderId: string;
    readonly side: 'BUY' | 'SELL';
    readonly monitorSymbol: string | null;
    readonly symbol: string | null;
    readonly isLongSymbol: boolean | undefined;
    readonly isProtectiveLiquidation: boolean;
    readonly liquidationTriggerLimit: number;
    readonly liquidationCooldownConfig: MonitorConfig['liquidationCooldown'];
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
      liquidationTriggerLimit,
      liquidationCooldownConfig,
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

    if (isProtectiveLiquidation) {
      const direction = isLongSymbol ? 'LONG' : 'SHORT';
      const result = liquidationCooldownTracker.recordLiquidationTrigger({
        symbol: monitorSymbol,
        direction,
        executedTimeMs,
        triggerLimit: liquidationTriggerLimit,
        cooldownConfig: liquidationCooldownConfig,
      });
      if (result.cooldownActivated) {
        logger.warn(
          `[订单监控] 订单 ${orderId} 保护性清仓触发次数已达上限（${result.currentCount}/${liquidationTriggerLimit}），进入买入冷却`,
        );
      }
    }
  }

  function recordFilledTradeLog(params: {
    readonly orderId: string;
    readonly side: 'BUY' | 'SELL';
    readonly symbol: string | null;
    readonly monitorSymbol: string | null;
    readonly isLongSymbol: boolean | undefined;
    readonly isProtectiveLiquidation: boolean;
    readonly closedReason: FinalizeOrderSettlementParams['closedReason'];
    readonly executedPrice: number | null;
    readonly executedQuantity: number | null;
    readonly executedTimeMs: number | null;
  }): void {
    const {
      orderId,
      side,
      symbol,
      monitorSymbol,
      isLongSymbol,
      isProtectiveLiquidation,
      closedReason,
      executedPrice,
      executedQuantity,
      executedTimeMs,
    } = params;
    if (
      !symbol ||
      isLongSymbol === undefined ||
      !isValidPositiveNumber(executedPrice) ||
      !isValidPositiveNumber(executedQuantity) ||
      !isValidPositiveNumber(executedTimeMs)
    ) {
      return;
    }

    const signalAction = resolveSignalAction(resolveOrderSideFromText(side), isLongSymbol);
    recordTrade({
      orderId,
      symbol,
      symbolName: null,
      monitorSymbol,
      action: signalAction,
      side,
      quantity: String(executedQuantity),
      price: String(executedPrice),
      orderType: null,
      status: 'FILLED',
      error: null,
      reason: closedReason === 'FILLED' ? null : closedReason,
      signalTriggerTime: null,
      executedAt: toHongKongTimeIso(new Date(executedTimeMs)),
      executedAtMs: executedTimeMs,
      timestamp: null,
      isProtectiveClearance: isProtectiveLiquidation,
    });
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

      recordDailyLossAndCooldown({
        orderId,
        side,
        monitorSymbol: context.monitorSymbol,
        symbol,
        isLongSymbol,
        isProtectiveLiquidation: context.isProtectiveLiquidation,
        liquidationTriggerLimit: context.liquidationTriggerLimit,
        liquidationCooldownConfig: context.liquidationCooldownConfig,
        executedPrice,
        executedQuantity,
        executedTimeMs,
      });

      recordFilledTradeLog({
        orderId,
        side,
        symbol,
        monitorSymbol: context.monitorSymbol,
        isLongSymbol,
        isProtectiveLiquidation: context.isProtectiveLiquidation,
        closedReason,
        executedPrice,
        executedQuantity,
        executedTimeMs,
      });
      markPostTradeRefresh(symbol, isLongSymbol);
    }

    if (closedReason === 'CANCELED' || closedReason === 'REJECTED') {
      if (side === 'SELL') {
        const cancelledSell = orderRecorder.markSellCancelled(orderId);
        const cancelledRelatedBuyOrderIds = cancelledSell?.relatedBuyOrderIds ?? [];
        const settledSell =
          symbol && isLongSymbol !== undefined
            ? settleSellExecutedPart({
                orderRecorder,
                orderId,
                symbol,
                isLongSymbol,
                executedPrice,
                executedQuantity,
                executedTimeMs,
                relatedBuyOrderIds: cancelledRelatedBuyOrderIds,
              })
            : {
                remainingRelatedBuyOrderIds:
                  cancelledRelatedBuyOrderIds.length > 0 ? cancelledRelatedBuyOrderIds : null,
              };
        relatedBuyOrderIds = settledSell.remainingRelatedBuyOrderIds;
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
        recordDailyLossAndCooldown({
          orderId,
          side,
          monitorSymbol: context.monitorSymbol,
          symbol,
          isLongSymbol,
          isProtectiveLiquidation: context.isProtectiveLiquidation,
          liquidationTriggerLimit: context.liquidationTriggerLimit,
          liquidationCooldownConfig: context.liquidationCooldownConfig,
          executedPrice: recordedExecution.executedPrice,
          executedQuantity: recordedExecution.executedQuantity,
          executedTimeMs: recordedExecution.executedTimeMs,
        });

        recordFilledTradeLog({
          orderId,
          side,
          symbol,
          monitorSymbol: context.monitorSymbol,
          isLongSymbol,
          isProtectiveLiquidation: context.isProtectiveLiquidation,
          closedReason,
          executedPrice: recordedExecution.executedPrice,
          executedQuantity: recordedExecution.executedQuantity,
          executedTimeMs: recordedExecution.executedTimeMs,
        });
        markPostTradeRefresh(symbol, isLongSymbol);
      }
    }

    runtime.closedOrderIds.add(orderId);
    clearRuntimeTracking(orderId);
    return {
      handled: true,
      relatedBuyOrderIds,
    };
  }

  return {
    settleOrder,
  };
}
