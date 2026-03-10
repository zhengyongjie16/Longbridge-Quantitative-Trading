/**
 * orderMonitor 事件流模块
 *
 * 职责：
 * - 处理 BOOTSTRAPPING / ACTIVE 两阶段订单推送
 * - 将终态订单统一交给关闭收口函数
 * - 在部分成交时维护 pendingSell 部分成交状态
 */
import { OrderSide, OrderStatus, type PushOrderChanged } from 'longport';
import { logger } from '../../../utils/logger/index.js';
import { decimalToNumber } from '../../../utils/helpers/index.js';
import type { EventFlow, EventFlowDeps } from './types.js';
import { isClosedStatus, resolveUpdatedAtMs } from './utils.js';

/**
 * 创建事件流处理器。
 *
 * @param deps 事件流依赖
 * @returns 事件流接口
 */
export function createEventFlow(deps: EventFlowDeps): EventFlow {
  const { runtime, orderRecorder, finalizeOrderClose, enqueueCloseSync, cacheBootstrappingEvent } =
    deps;

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
        enqueueCloseSync(orderId, 'LATE_CLOSED_EVENT');
      }

      return;
    }

    trackedOrder.status = event.status;
    trackedOrder.executedQuantity = decimalToNumber(event.executedQuantity) || 0;
    trackedOrder.executedPrice = decimalToNumber(event.executedPrice) || null;
    trackedOrder.lastExecutedTimeMs = resolveUpdatedAtMs(event.updatedAt);

    if (event.status === OrderStatus.Filled) {
      const executedPrice = decimalToNumber(event.executedPrice);
      const executedQuantity = decimalToNumber(event.executedQuantity);
      const executedTimeMs = resolveUpdatedAtMs(event.updatedAt);
      const result = finalizeOrderClose({
        orderId,
        closedReason: 'FILLED',
        source: 'WS',
        executedPrice,
        executedQuantity,
        executedTimeMs,
      });
      if (!result.handled) {
        enqueueCloseSync(orderId, 'LATE_CLOSED_EVENT', 'FILLED');
      }

      return;
    }

    if (event.status === OrderStatus.Canceled) {
      const executedPrice = decimalToNumber(event.executedPrice);
      const executedQuantity = decimalToNumber(event.executedQuantity);
      const executedTimeMs = resolveUpdatedAtMs(event.updatedAt);
      finalizeOrderClose({
        orderId,
        closedReason: 'CANCELED',
        source: 'WS',
        executedPrice,
        executedQuantity,
        executedTimeMs,
      });
      logger.info(`[订单监控] 订单 ${orderId} 状态变为 ${event.status}，停止追踪`);
      return;
    }

    if (event.status === OrderStatus.Rejected) {
      const executedPrice = decimalToNumber(event.executedPrice);
      const executedQuantity = decimalToNumber(event.executedQuantity);
      const executedTimeMs = resolveUpdatedAtMs(event.updatedAt);
      finalizeOrderClose({
        orderId,
        closedReason: 'REJECTED',
        source: 'WS',
        executedPrice,
        executedQuantity,
        executedTimeMs,
      });
      logger.warn(`[订单监控] 订单 ${orderId} 状态变为 ${event.status}，停止追踪`);
      return;
    }

    if (event.status === OrderStatus.PartialFilled && trackedOrder.side === OrderSide.Sell) {
      orderRecorder.markSellPartialFilled(orderId, trackedOrder.executedQuantity);
      logger.info(
        `[订单监控] 订单 ${orderId} 部分成交，` +
          `已成交=${trackedOrder.executedQuantity}/${trackedOrder.submittedQuantity}，` +
          '等待完全成交后更新本地记录',
      );
    }
  }

  /**
   * 处理 WebSocket 订单状态变化（BOOTSTRAPPING/ACTIVE 分发）。
   *
   * @param event 订单推送事件
   * @returns 无返回值
   */
  function handleOrderChanged(event: PushOrderChanged): void {
    if (runtime.runtimeState === 'BOOTSTRAPPING') {
      cacheBootstrappingEvent(event);
      return;
    }

    handleOrderChangedWhenActive(event);
  }

  return {
    handleOrderChangedWhenActive,
    handleOrderChanged,
  };
}
