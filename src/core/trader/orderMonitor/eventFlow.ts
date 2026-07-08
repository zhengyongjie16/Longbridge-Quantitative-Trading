/**
 * orderMonitor 事件流模块
 *
 * 职责：
 * - 处理 STOPPED / BOOTSTRAPPING / ACTIVE 三阶段订单推送
 * - 将已确认终态订单统一交给 settlementFlow 结算
 * - 在部分成交时维护 pendingSell 部分成交状态
 */
import { OrderSide, OrderStatus, type PushOrderChanged } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import { decimalToNumber } from '../../../utils/helpers/index.js';
import { ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS } from '../../../constants/index.js';
import type { EventFlow, EventFlowDeps } from './types.js';
import { resetOrderReplaceRuntimeState, resumeOrderReplaceFromWsProgress } from './orderOps.js';
import { isClosedStatus, resolveOrderClosedReasonFromStatus, resolveUpdatedAtMs } from './utils.js';

/** 仅当状态已离开撤单中阶段时，才恢复下一次撤单重试机会。 */
function shouldResumeCancelRetryFromWsStatus(status: OrderStatus): boolean {
  return status !== OrderStatus.WaitToCancel && status !== OrderStatus.PendingCancel;
}

/** 将 SDK Decimal/unknown 价格数量统一收敛为 number | null。 */
function resolveNullableDecimalNumber(value: Parameters<typeof decimalToNumber>[0]): number | null {
  const resolved = decimalToNumber(value);
  return Number.isFinite(resolved) ? resolved : null;
}

/**
 * 创建事件流处理器。
 *
 * @param deps 事件流依赖
 * @returns 事件流接口
 */
export function createEventFlow(deps: EventFlowDeps): EventFlow {
  const { runtime, orderRecorder, settleOrder, cacheBootstrappingEvent, triggerRoute } = deps;

  /**
   * 处理 ACTIVE 状态下的订单推送。
   *
   * @param event 订单变更事件
   * @returns 无返回值
   */
  function handleOrderChangedWhenActive(event: PushOrderChanged): void {
    const orderId = event.orderId;
    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (!trackedOrder) {
      if (isClosedStatus(event.status)) {
        logger.warn(`[订单监控] 收到未追踪订单 ${orderId} 的终态事件 ${event.status}，已忽略`);
      }

      return;
    }

    const previousStatus = trackedOrder.status;
    trackedOrder.status = event.status;
    trackedOrder.executedQuantity = decimalToNumber(event.executedQuantity) || 0;
    trackedOrder.executedPrice = resolveNullableDecimalNumber(event.executedPrice);
    trackedOrder.lastExecutedTimeMs = resolveUpdatedAtMs(event.updatedAt);

    if (previousStatus !== event.status) {
      resetOrderReplaceRuntimeState(runtime, orderId);
      if (
        trackedOrder.nextCancelAttemptAt === ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS &&
        shouldResumeCancelRetryFromWsStatus(event.status)
      ) {
        trackedOrder.cancelRetryCount = 0;
        trackedOrder.nextCancelAttemptAt = Date.now();
      }

      resumeOrderReplaceFromWsProgress(runtime, orderId, trackedOrder);
    }

    if (event.status === OrderStatus.PartialFilled && trackedOrder.side === OrderSide.Sell) {
      orderRecorder.markSellPartialFilled(orderId, trackedOrder.executedQuantity);
      logger.info(
        `[订单监控] 订单 ${orderId} 部分成交，` +
          `已成交=${trackedOrder.executedQuantity}/${trackedOrder.submittedQuantity}，` +
          '等待完全成交后更新本地记录',
      );
    }

    const closedReason = resolveOrderClosedReasonFromStatus(event.status);
    if (closedReason === null) {
      triggerRoute(trackedOrder.symbol, 'ORDER_EVENT');
      return;
    }

    if (trackedOrder.side === OrderSide.Sell && trackedOrder.timeoutMarketConversionPending) {
      trackedOrder.timeoutMarketConversionTerminalState = {
        closedReason,
        source: 'WS',
        executedPrice: resolveNullableDecimalNumber(event.executedPrice),
        executedQuantity: resolveNullableDecimalNumber(event.executedQuantity),
        executedTimeMs: resolveUpdatedAtMs(event.updatedAt),
      };

      triggerRoute(trackedOrder.symbol, 'ORDER_EVENT');
      logger.info(
        `[订单监控] 卖出订单 ${orderId} 超时撤单后收到终态=${event.status}，已写入终态快照并显式唤醒 route`,
      );
      return;
    }

    const result = settleOrder({
      orderId,
      closedReason,
      source: 'WS',
      executedPrice: resolveNullableDecimalNumber(event.executedPrice),
      executedQuantity: resolveNullableDecimalNumber(event.executedQuantity),
      executedTimeMs: resolveUpdatedAtMs(event.updatedAt),
    });
    resetOrderReplaceRuntimeState(runtime, orderId);
    if (!result.handled) {
      logger.warn(`[订单监控] 订单 ${orderId} 终态=${event.status} 已到达，但结算未执行`);
      return;
    }

    const remainingOrderIds = runtime.trackedOrderIdsBySymbol.get(trackedOrder.symbol);
    if (remainingOrderIds !== undefined && remainingOrderIds.size > 0) {
      triggerRoute(trackedOrder.symbol, 'ORDER_EVENT');
    }
  }

  /**
   * 处理 WebSocket 订单状态变化（BOOTSTRAPPING/ACTIVE 分发）。
   *
   * @param event 订单推送事件
   * @returns 无返回值
   */
  function handleOrderChanged(event: PushOrderChanged): void {
    switch (runtime.runtimeState) {
      case 'STOPPED': {
        return;
      }

      case 'BOOTSTRAPPING': {
        cacheBootstrappingEvent(event);
        return;
      }

      case 'ACTIVE': {
        handleOrderChangedWhenActive(event);
        return;
      }

      default: {
        return;
      }
    }
  }

  return {
    handleOrderChangedWhenActive,
    handleOrderChanged,
  };
}
