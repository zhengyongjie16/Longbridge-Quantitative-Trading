/**
 * orderMonitor 事件流模块
 *
 * 职责：
 * - 处理 BOOTSTRAPPING / ACTIVE 两阶段订单推送
 * - 在成交/撤销/部分成交时维护本地运行态与业务副作用
 * - 成交后写入 trade 日志并登记待刷新标的
 */
import { OrderSide, OrderStatus, type PushOrderChanged } from 'longport';
import { logger } from '../../../utils/logger/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { toHongKongTimeIso } from '../../../utils/time/index.js';
import { recordTrade } from '../tradeLogger.js';
import type { EventFlow, EventFlowDeps } from './types.js';
import { isClosedStatus, resolveSignalAction, resolveUpdatedAtMs } from './utils.js';

/**
 * 创建事件流处理器。
 *
 * @param deps 事件流依赖
 * @returns 事件流接口
 */
export function createEventFlow(deps: EventFlowDeps): EventFlow {
  const {
    runtime,
    orderHoldRegistry,
    orderRecorder,
    dailyLossTracker,
    liquidationCooldownTracker,
    refreshGate,
    cacheBootstrappingEvent,
  } = deps;

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
        orderHoldRegistry.markOrderClosed(orderId);
      }
      return;
    }

    trackedOrder.status = event.status;
    const executedQuantity = decimalToNumber(event.executedQuantity);
    trackedOrder.executedQuantity = executedQuantity || 0;

    if (event.status === OrderStatus.Filled) {
      orderHoldRegistry.markOrderClosed(orderId);
      const executedPrice = decimalToNumber(event.executedPrice);
      const filledQuantity = decimalToNumber(event.executedQuantity);
      if (isValidPositiveNumber(executedPrice) && isValidPositiveNumber(filledQuantity)) {
        const executedTimeMs = resolveUpdatedAtMs(event.updatedAt);
        if (executedTimeMs === null) {
          logger.error(`[订单监控] 订单 ${orderId} 成交时间缺失，无法更新订单记录`);
          runtime.trackedOrders.delete(orderId);
          return;
        }
        if (trackedOrder.side === OrderSide.Buy) {
          orderRecorder.recordLocalBuy(
            trackedOrder.symbol,
            executedPrice,
            filledQuantity,
            trackedOrder.isLongSymbol,
            executedTimeMs,
          );
        } else {
          orderRecorder.recordLocalSell(
            trackedOrder.symbol,
            executedPrice,
            filledQuantity,
            trackedOrder.isLongSymbol,
            executedTimeMs,
            orderId,
          );
          orderRecorder.markSellFilled(orderId);
        }
        if (trackedOrder.monitorSymbol) {
          dailyLossTracker.recordFilledOrder({
            monitorSymbol: trackedOrder.monitorSymbol,
            symbol: trackedOrder.symbol,
            isLongSymbol: trackedOrder.isLongSymbol,
            side: trackedOrder.side,
            executedPrice,
            executedQuantity: filledQuantity,
            executedTimeMs,
            orderId,
          });
        }
        if (trackedOrder.isProtectiveLiquidation) {
          const direction = trackedOrder.isLongSymbol ? 'LONG' : 'SHORT';
          if (trackedOrder.monitorSymbol) {
            liquidationCooldownTracker.recordCooldown({
              symbol: trackedOrder.monitorSymbol,
              direction,
              executedTimeMs,
            });
          } else {
            logger.error(`[订单监控] 订单 ${orderId} 缺少监控标的代码，无法记录清仓冷却`);
          }
        }
        const signalAction = resolveSignalAction(trackedOrder.side, trackedOrder.isLongSymbol);
        const executedAt = toHongKongTimeIso(new Date(executedTimeMs));
        recordTrade({
          orderId,
          symbol: trackedOrder.symbol,
          symbolName: null,
          monitorSymbol: trackedOrder.monitorSymbol,
          action: signalAction,
          side: trackedOrder.side === OrderSide.Buy ? 'BUY' : 'SELL',
          quantity: String(filledQuantity),
          price: String(executedPrice),
          orderType: null,
          status: 'FILLED',
          error: null,
          reason: null,
          signalTriggerTime: null,
          executedAt,
          executedAtMs: executedTimeMs,
          timestamp: null,
          isProtectiveClearance: trackedOrder.isProtectiveLiquidation,
        });
        logger.info(
          `[订单监控] 订单 ${orderId} 完全成交，` +
            `成交价=${executedPrice.toFixed(3)}，成交数量=${filledQuantity}，` +
            '已更新本地订单记录',
        );
        refreshGate?.markStale();
        runtime.pendingRefreshSymbols.push({
          symbol: trackedOrder.symbol,
          isLongSymbol: trackedOrder.isLongSymbol,
          refreshAccount: true,
          refreshPositions: true,
        });
      } else {
        const executedPriceText = event.executedPrice?.toString() ?? 'null';
        const executedQuantityText = event.executedQuantity.toString();
        logger.warn(
          `[订单监控] 订单 ${orderId} 成交数据无效，` +
            `executedPrice=${executedPriceText}，executedQuantity=${executedQuantityText}`,
        );
      }
      runtime.trackedOrders.delete(orderId);
      return;
    }

    if (event.status === OrderStatus.Canceled || event.status === OrderStatus.Rejected) {
      orderHoldRegistry.markOrderClosed(orderId);
      if (trackedOrder.side === OrderSide.Sell) {
        orderRecorder.markSellCancelled(orderId);
      }
      runtime.trackedOrders.delete(orderId);
      logger.info(`[订单监控] 订单 ${orderId} 状态变为 ${event.status}，停止追踪`);
      return;
    }

    if (event.status === OrderStatus.PartialFilled) {
      if (trackedOrder.side === OrderSide.Sell) {
        orderRecorder.markSellPartialFilled(orderId, executedQuantity);
      }
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
