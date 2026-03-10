/**
 * orderMonitor 关闭收口与定向对账模块
 *
 * 职责：
 * - 提供订单关闭的唯一收口函数（成交/撤销/拒绝/对账 NOT_FOUND）
 * - 提供 closeSyncQueue（按 orderId 去重）入队与调度
 * - 在终态处理中保证幂等，避免重复记账与重复清理
 */
import { OrderSide, OrderStatus } from 'longport';
import { logger } from '../../../utils/logger/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { toHongKongTimeIso } from '../../../utils/time/index.js';
import { recordTrade } from '../tradeLogger.js';
import { hasProtectiveLiquidationRemark } from '../utils.js';
import { resolveOrderOwnership } from '../../orderRecorder/orderOwnershipParser.js';
import type { OrderRecord, OrderRecorder, RawOrderFromAPI } from '../../../types/services.js';
import type { OrderClosedReason } from '../../../types/trader.js';
import type { TrackedOrder } from '../types.js';
import type {
  CloseFlow,
  CloseFlowDeps,
  CloseSyncTask,
  CloseSyncTriggerReason,
  FinalizeOrderCloseParams,
  FinalizeOrderCloseResult,
} from './types.js';
import { resolveSignalAction, resolveUpdatedAtMs } from './utils.js';

const CLOSE_SYNC_MAX_RETRIES = 5;
const CLOSE_SYNC_BASE_DELAY_MS = 1000;
const CLOSE_SYNC_MAX_DELAY_MS = 30_000;
const CLOSE_SYNC_MAX_ITEMS_PER_TICK = 20;

function resolveClosedReasonFromStatus(status: OrderStatus): OrderClosedReason | null {
  if (status === OrderStatus.Filled) {
    return 'FILLED';
  }

  if (status === OrderStatus.Canceled) {
    return 'CANCELED';
  }

  if (status === OrderStatus.Rejected) {
    return 'REJECTED';
  }

  return null;
}

function resolveBackoffDelayMs(attempts: number): number {
  const delay = CLOSE_SYNC_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, CLOSE_SYNC_MAX_DELAY_MS);
}

function resolveOrderSideText(orderSide: OrderSide): 'BUY' | 'SELL' {
  return orderSide === OrderSide.Buy ? 'BUY' : 'SELL';
}

function resolveOrderSideFromText(side: 'BUY' | 'SELL'): OrderSide {
  return side === 'BUY' ? OrderSide.Buy : OrderSide.Sell;
}

function sortOrdersBySellPriority(
  orders: ReadonlyArray<OrderRecord>,
): ReadonlyArray<OrderRecord> {
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

function settleCancelledOrRejectedSell(params: {
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
      remainingRelatedBuyOrderIds: relatedBuyOrderIds,
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

function resolveCloseContextFromSnapshot(params: {
  readonly order: RawOrderFromAPI;
  readonly trackedOrder: TrackedOrder | undefined;
  readonly deps: Pick<CloseFlowDeps, 'tradingConfig' | 'symbolRegistry'>;
}): {
  readonly side: 'BUY' | 'SELL';
  readonly monitorSymbol: string | null;
  readonly isLongSymbol: boolean;
  readonly isProtectiveLiquidation: boolean;
} | null {
  const { order, trackedOrder, deps } = params;
  if (trackedOrder) {
    return {
      side: resolveOrderSideText(trackedOrder.side),
      monitorSymbol: trackedOrder.monitorSymbol,
      isLongSymbol: trackedOrder.isLongSymbol,
      isProtectiveLiquidation: trackedOrder.isProtectiveLiquidation,
    };
  }

  const resolvedBySeat = deps.symbolRegistry.resolveSeatBySymbol(order.symbol);
  if (resolvedBySeat) {
    return {
      side: resolveOrderSideText(order.side),
      monitorSymbol: resolvedBySeat.monitorSymbol,
      isLongSymbol: resolvedBySeat.direction === 'LONG',
      isProtectiveLiquidation: hasProtectiveLiquidationRemark(order.remark),
    };
  }

  const ownership = resolveOrderOwnership(order, deps.tradingConfig.monitors);
  if (!ownership) {
    return null;
  }

  return {
    side: resolveOrderSideText(order.side),
    monitorSymbol: ownership.monitorSymbol,
    isLongSymbol: ownership.direction === 'LONG',
    isProtectiveLiquidation: hasProtectiveLiquidationRemark(order.remark),
  };
}

/**
 * 创建关闭收口流程。
 *
 * @param deps 关闭收口依赖
 * @returns 关闭收口接口
 */
export function createCloseFlow(deps: CloseFlowDeps): CloseFlow {
  const {
    runtime,
    orderHoldRegistry,
    orderRecorder,
    dailyLossTracker,
    liquidationCooldownTracker,
    tradingConfig,
    symbolRegistry,
    refreshGate,
  } = deps;

  function clearRuntimeTracking(orderId: string): void {
    runtime.trackedOrders.delete(orderId);
    runtime.trackedOrderLifecycles.set(orderId, 'CLOSED');
    runtime.closeSyncQueue.delete(orderId);
    orderHoldRegistry.markOrderClosed(orderId);
  }

  function finalizeOrderClose(params: FinalizeOrderCloseParams): FinalizeOrderCloseResult {
    const { orderId, closedReason } = params;
    if (runtime.closedOrderIds.has(orderId) && closedReason !== 'NOT_FOUND') {
      return {
        handled: false,
        relatedBuyOrderIds: null,
      };
    }

    const trackedOrder = runtime.trackedOrders.get(orderId);
    const sideText = params.side ?? (trackedOrder ? resolveOrderSideText(trackedOrder.side) : null);
    let relatedBuyOrderIds: ReadonlyArray<string> | null = null;
    if (closedReason === 'FILLED') {
      const executedPrice = params.executedPrice ?? null;
      const executedQuantity = params.executedQuantity ?? null;
      const executedTimeMs = params.executedTimeMs ?? null;
      const monitorSymbol = trackedOrder?.monitorSymbol ?? params.monitorSymbol ?? null;
      const isLongSymbol = trackedOrder?.isLongSymbol ?? params.isLongSymbol;
      const side = sideText;
      const isProtectiveLiquidation =
        trackedOrder?.isProtectiveLiquidation ?? params.isProtectiveLiquidation ?? false;
      const liquidationTriggerLimit =
        trackedOrder?.liquidationTriggerLimit ?? params.liquidationTriggerLimit ?? 1;
      const liquidationCooldownConfig =
        trackedOrder?.liquidationCooldownConfig ?? params.liquidationCooldownConfig ?? null;
      const symbol = trackedOrder?.symbol ?? params.symbol ?? null;

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
        const settledSell = settleCancelledOrRejectedSell({
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

      if (monitorSymbol) {
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
      }

      if (isProtectiveLiquidation && monitorSymbol) {
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

      const action = resolveSignalAction(orderSide, isLongSymbol);
      recordTrade({
        orderId,
        symbol,
        symbolName: null,
        monitorSymbol,
        action,
        side,
        quantity: String(executedQuantity),
        price: String(executedPrice),
        orderType: null,
        status: 'FILLED',
        error: null,
        reason: null,
        signalTriggerTime: null,
        executedAt: toHongKongTimeIso(new Date(executedTimeMs)),
        executedAtMs: executedTimeMs,
        timestamp: null,
        isProtectiveClearance: isProtectiveLiquidation,
      });

      refreshGate?.markStale();
      runtime.pendingRefreshSymbols.push({
        symbol,
        isLongSymbol,
        refreshAccount: true,
        refreshPositions: true,
      });
    }

    if ((closedReason === 'CANCELED' || closedReason === 'REJECTED') && sideText === 'SELL') {
      const cancelledSell = orderRecorder.markSellCancelled(orderId);
      const cancelledRelatedBuyOrderIds = cancelledSell?.relatedBuyOrderIds ?? [];
      const symbol = trackedOrder?.symbol ?? params.symbol ?? null;
      const isLongSymbol = trackedOrder?.isLongSymbol ?? params.isLongSymbol;
      const executedPrice = params.executedPrice ?? trackedOrder?.executedPrice ?? null;
      const executedQuantity =
        params.executedQuantity ??
        trackedOrder?.executedQuantity ??
        cancelledSell?.filledQuantity ??
        null;
      const executedTimeMs = params.executedTimeMs ?? trackedOrder?.lastExecutedTimeMs ?? null;
      if (symbol && isLongSymbol !== undefined && isValidPositiveNumber(executedQuantity)) {
        const settledSell = settleCancelledOrRejectedSell({
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

      const monitorSymbol = trackedOrder?.monitorSymbol ?? params.monitorSymbol ?? null;
      const isProtectiveLiquidation =
        trackedOrder?.isProtectiveLiquidation ?? params.isProtectiveLiquidation ?? false;
      const liquidationTriggerLimit =
        trackedOrder?.liquidationTriggerLimit ?? params.liquidationTriggerLimit ?? 1;
      const liquidationCooldownConfig =
        trackedOrder?.liquidationCooldownConfig ?? params.liquidationCooldownConfig ?? null;
      if (
        symbol &&
        monitorSymbol &&
        isLongSymbol !== undefined &&
        isValidPositiveNumber(executedPrice) &&
        isValidPositiveNumber(executedQuantity) &&
        isValidPositiveNumber(executedTimeMs)
      ) {
        const orderSide = resolveOrderSideFromText(sideText);
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

        const action = resolveSignalAction(orderSide, isLongSymbol);
        recordTrade({
          orderId,
          symbol,
          symbolName: null,
          monitorSymbol,
          action,
          side: sideText,
          quantity: String(executedQuantity),
          price: String(executedPrice),
          orderType: null,
          status: 'FILLED',
          error: null,
          reason: closedReason,
          signalTriggerTime: null,
          executedAt: toHongKongTimeIso(new Date(executedTimeMs)),
          executedAtMs: executedTimeMs,
          timestamp: null,
          isProtectiveClearance: isProtectiveLiquidation,
        });

        refreshGate?.markStale();
        runtime.pendingRefreshSymbols.push({
          symbol,
          isLongSymbol,
          refreshAccount: true,
          refreshPositions: true,
        });
      }
    }

    if (closedReason !== 'NOT_FOUND') {
      runtime.closedOrderIds.add(orderId);
    }

    clearRuntimeTracking(orderId);
    return {
      handled: true,
      relatedBuyOrderIds,
    };
  }

  function enqueueCloseSync(
    orderId: string,
    reason: CloseSyncTriggerReason,
    expectedReason: OrderClosedReason | null = null,
  ): void {
    if (runtime.closedOrderIds.has(orderId)) {
      return;
    }

    const existing = runtime.closeSyncQueue.get(orderId);
    if (existing) {
      existing.nextAttemptAtMs = Math.min(existing.nextAttemptAtMs, Date.now());
      existing.lastError = null;
      return;
    }

    const task: CloseSyncTask = {
      orderId,
      triggerReason: reason,
      expectedReason,
      attempts: 0,
      nextAttemptAtMs: Date.now(),
      lastError: null,
    };
    runtime.closeSyncQueue.set(orderId, task);
    if (runtime.trackedOrders.has(orderId)) {
      runtime.trackedOrderLifecycles.set(orderId, 'CLOSE_SYNC_PENDING');
    }
  }

  function scheduleCloseSyncRetry(task: CloseSyncTask, message: string): void {
    task.attempts += 1;
    task.lastError = message;

    if (task.attempts >= CLOSE_SYNC_MAX_RETRIES) {
      logger.error(
        `[订单监控] closeSync 对账失败达到上限，orderId=${task.orderId} trigger=${task.triggerReason} lastError=${message}`,
      );

      if (task.expectedReason === 'NOT_FOUND') {
        finalizeOrderClose({
          orderId: task.orderId,
          closedReason: 'NOT_FOUND',
          source: 'SYNC',
        });
      } else {
        runtime.closeSyncQueue.delete(task.orderId);
      }

      return;
    }

    task.nextAttemptAtMs = Date.now() + resolveBackoffDelayMs(task.attempts);
  }

  async function processCloseSyncQueue(): Promise<void> {
    if (runtime.closeSyncQueue.size === 0) {
      return;
    }

    const nowMs = Date.now();
    const dueTasks = [...runtime.closeSyncQueue.values()]
      .filter((task) => task.nextAttemptAtMs <= nowMs)
      .slice(0, CLOSE_SYNC_MAX_ITEMS_PER_TICK);

    if (dueTasks.length === 0) {
      return;
    }

    let allOrders: ReadonlyArray<RawOrderFromAPI>;
    try {
      allOrders = await orderRecorder.fetchAllOrdersFromAPI(true);
    } catch (error) {
      const message = String(error);
      for (const task of dueTasks) {
        scheduleCloseSyncRetry(task, message);
      }

      return;
    }

    const orderById = new Map<string, RawOrderFromAPI>(
      allOrders.map((order) => [order.orderId, order]),
    );
    for (const task of dueTasks) {
      const snapshot = orderById.get(task.orderId);
      if (!snapshot) {
        scheduleCloseSyncRetry(task, 'order snapshot not found');
        continue;
      }

      const closedReason = resolveClosedReasonFromStatus(snapshot.status);
      if (closedReason === null) {
        scheduleCloseSyncRetry(task, `order status still open: ${snapshot.status}`);
        continue;
      }

      const trackedOrder = runtime.trackedOrders.get(task.orderId);
      const resolvedFromSnapshot = resolveCloseContextFromSnapshot({
        order: snapshot,
        trackedOrder,
        deps: {
          tradingConfig,
          symbolRegistry,
        },
      });
      const executedPrice = decimalToNumber(snapshot.executedPrice);
      const executedQuantity = decimalToNumber(snapshot.executedQuantity);
      const executedTimeMs = resolveUpdatedAtMs(snapshot.updatedAt);
      const finalizeParams: FinalizeOrderCloseParams = {
        orderId: task.orderId,
        closedReason,
        source: 'SYNC',
        executedPrice,
        executedQuantity,
        executedTimeMs,
        symbol: snapshot.symbol,
        ...(resolvedFromSnapshot?.side ? { side: resolvedFromSnapshot.side } : {}),
        ...(resolvedFromSnapshot
          ? {
              monitorSymbol: resolvedFromSnapshot.monitorSymbol ?? null,
              isLongSymbol: resolvedFromSnapshot.isLongSymbol,
              isProtectiveLiquidation: resolvedFromSnapshot.isProtectiveLiquidation,
            }
          : {}),
      };
      const result = finalizeOrderClose(finalizeParams);
      if (!result.handled) {
        scheduleCloseSyncRetry(task, 'close sink is not ready');
      }
    }
  }

  function clearCloseSyncQueue(): void {
    runtime.closeSyncQueue.clear();
  }

  return {
    finalizeOrderClose,
    enqueueCloseSync,
    processCloseSyncQueue,
    clearCloseSyncQueue,
  };
}
